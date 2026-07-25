import { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { openaiRequestToCanonical, canonicalToOpenAIResponse, canonicalChunkToOpenAISSE } from "../core/openai-inbound.js";
import { responsesRequestToCanonical, canonicalToResponsesResponse, ResponsesSSE } from "../core/responses-inbound.js";
import { shrinkImagesInPlace } from "../core/image-resize.js";
import { editImageContextInPlace } from "../core/context-edit.js";
import { errorHint, classifyError } from "./errors.js";
import { RunawayGuard } from "../core/stream-guard.js";

// Cut a single streaming turn that degenerates (model repeats one short token forever, never stops)
// so the client gets a bounded answer instead of a frozen session. Mirrors the Anthropic backend.
const STREAM_DEADLINE_MS = 120_000;

export function mountOpenAI(app: Express, router: Router, onMetric: MetricSink): void {
  // Model discovery — OpenAI list shape. Clients (LiteLLM-style gateways, "test connection" probes)
  // GET this before chatting; without it they 404 and refuse to connect.
  app.get("/openai/models", (_req, res) => {
    res.json({ object: "list", data: router.listModels().map((id) => ({ id, object: "model", owned_by: "copilot-reverse" })) });
  });

  app.post("/openai/chat/completions", async (req, res) => {
    const start = Date.now();
    const canon = openaiRequestToCanonical(req.body);
    // Downscale oversized images before they reach Copilot — it bills an inline data URL as plain
    // text, so a full-resolution screenshot would otherwise overflow the model's prompt-token limit.
    await shrinkImagesInPlace(canon.messages);
    // Then clear OLD tool screenshots so a long agentic conversation's cumulative image bytes stay
    // under Copilot's request entity limit (413). Keeps the most recent few, like Anthropic's backend.
    editImageContextInPlace(canon.messages);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number, opts: { error?: string; tokensIn?: number; tokensOut?: number } = {}) => onMetric({ endpoint: "/openai/chat/completions", model: canon.model, status, latencyMs: Date.now() - start, tokensIn: opts.tokensIn, tokensOut: opts.tokensOut, error: opts.error });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`; // unique per response, not constant
        const guard = new RunawayGuard();
        const deadline = start + STREAM_DEADLINE_MS;
        let runawayReason = "";
        let usage: { promptTokens: number; completionTokens: number } | undefined;
        for await (const chunk of provider.stream(canon)) {
          res.write(canonicalChunkToOpenAISSE(chunk, id, canon.model));
          if (chunk.done) usage = chunk.usage;
          // Backstop covers tool-call streams too: a model can loop on tool calls forever, which
          // never feeds the text guard — the wall clock cuts those cleanly instead of freezing.
          if (chunk.kind === "text" && guard.push(chunk.delta)) { runawayReason = guard.reason ?? "repetition"; break; }
          if (Date.now() > deadline) { runawayReason = "deadline"; break; }
        }
        res.end();
        metric(200, { tokensIn: usage?.promptTokens, tokensOut: usage?.completionTokens, error: runawayReason ? `runaway stream cut (${runawayReason}) — model degenerated, ended early` : undefined });
      } else {
        const resp = await provider.complete(canon);
        res.json(canonicalToOpenAIResponse(resp));
        metric(200, { tokensIn: resp.usage?.promptTokens, tokensOut: resp.usage?.completionTokens });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const hint = errorHint(raw);
      const message = hint ? `${raw}\n${hint}` : raw;
      // A permanent upstream 4xx (bad model, invalid body) is terminal — surface its real status so
      // the client fails fast instead of retrying a 502-class error to its turn timeout (#50 P1).
      const { status } = classifyError(err);
      if (!res.headersSent) {
        res.status(status).json({ error: { message } });
      } else {
        // Stream already opened: surface the failure as a final error chunk so the client
        // sees it instead of a silently truncated response, then close the stream.
        res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
        res.end();
      }
      metric(status, { error: message });
    }
  });

  // OpenAI Responses API — Codex speaks ONLY this after codex#7782 removed wire_api="chat". Codex
  // POSTs {base_url}/responses, so with base_url …/openai the route is /openai/responses. Same
  // canonical pipeline as chat/completions; the Responses translator handles the item-centric shape.
  app.post("/openai/responses", async (req, res) => {
    const start = Date.now();
    const canon = responsesRequestToCanonical(req.body);
    // Same image downscale as /chat: keep the base64 payload within the model's prompt budget.
    await shrinkImagesInPlace(canon.messages);
    editImageContextInPlace(canon.messages); // + clear old screenshots (cumulative-byte / 413 guard)
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number, opts: { error?: string; tokensIn?: number; tokensOut?: number } = {}) => onMetric({ endpoint: "/openai/responses", model: canon.model, status, latencyMs: Date.now() - start, tokensIn: opts.tokensIn, tokensOut: opts.tokensOut, error: opts.error });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const sse = new ResponsesSSE(`resp_${randomUUID().replace(/-/g, "")}`, canon.model);
        res.write(sse.start());
        const argsByIdx = new Map<number, string>();
        let usage: { promptTokens: number; completionTokens: number } | undefined;
        let finish = "stop";
        const guard = new RunawayGuard();
        const deadline = start + STREAM_DEADLINE_MS;
        let runawayReason = "";
        for await (const chunk of provider.stream(canon)) {
          if (chunk.done) { finish = chunk.finishReason ?? "stop"; usage = chunk.usage; break; }
          if (chunk.kind === "text") { for (const f of sse.text(chunk.delta)) res.write(f); if (guard.push(chunk.delta)) { finish = "length"; runawayReason = guard.reason ?? "repetition"; break; } }
          else if (chunk.kind === "tool_use_start") for (const f of sse.toolStart(chunk.index, chunk.id, chunk.name, chunk.custom)) res.write(f);
          else if (chunk.kind === "tool_use_delta") { argsByIdx.set(chunk.index, (argsByIdx.get(chunk.index) ?? "") + chunk.argsDelta); for (const f of sse.toolArgs(chunk.index, chunk.argsDelta)) res.write(f); }
          // Deadline applies to every chunk kind: a tool-call-only runaway never hits the text guard.
          if (Date.now() > deadline) { finish = "length"; runawayReason = "deadline"; break; }
        }
        for (const f of sse.finish(usage, finish, argsByIdx)) res.write(f);
        res.end();
        metric(200, { tokensIn: usage?.promptTokens, tokensOut: usage?.completionTokens, error: runawayReason ? `runaway stream cut (${runawayReason}) — model degenerated, ended early` : undefined });
      } else {
        const resp = await provider.complete(canon);
        res.json(canonicalToResponsesResponse(resp));
        metric(200, { tokensIn: resp.usage?.promptTokens, tokensOut: resp.usage?.completionTokens });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const hint = errorHint(raw);
      const message = hint ? `${raw}\n${hint}` : raw;
      // Terminal upstream 4xx → its real status; retriable (5xx/network/429) → 502. Fast-fail (#50 P1).
      // The Responses error shape stays a flat {type:"error"} (Codex's contract); the STATUS carries
      // the fast-fail — a non-stream 400 no longer masquerades as a retriable 502.
      const { status } = classifyError(err);
      if (!res.headersSent) {
        res.status(status).json({ error: { type: "error", message } });
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.end();
      }
      metric(status, { error: message });
    }
  });
}
