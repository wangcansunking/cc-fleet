import express, { type Express, type RequestHandler } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { keysMatch } from "../worker/auth.js";

export interface FleetGatewayOptions {
  control: RequestHandler;
  workerBaseUrl: string | (() => string);
  llmKey: () => string | null;
}

function presentedKey(req: { get(name: string): string | undefined }): string | null {
  const auth = req.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return req.get("x-api-key")?.trim() || null;
}

export function createFleetGateway(opts: FleetGatewayOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  // Control owns its own parser and per-device authorization. Mount it before any proxy/body parser so
  // its SSE stream is never buffered and the public gateway has exactly one implementation of the flow.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/control/")) { next(); return; }
    opts.control(req, res, next);
  });

  const requireLlmKey: RequestHandler = (req, res, next) => {
    const configured = opts.llmKey();
    if (!configured) {
      res.status(503).json({ error: { message: "fleet LLM access is not configured — refusing to serve" } });
      return;
    }
    const got = presentedKey(req);
    if (!got || !keysMatch(got, configured)) {
      res.status(401).json({ error: { message: "missing or invalid fleet LLM access key" } });
      return;
    }
    next();
  };

  const workerBaseProvider = typeof opts.workerBaseUrl === "function" ? opts.workerBaseUrl : undefined;
  const target = typeof opts.workerBaseUrl === "string" ? opts.workerBaseUrl : "http://127.0.0.1";
  const proxy = createProxyMiddleware({
    target,
    router: workerBaseProvider ? () => workerBaseProvider() : undefined,
    changeOrigin: false,
    proxyTimeout: 0,
    timeout: 0,
    on: {
      // Normally the proxy receives an untouched byte stream. fixRequestBody is harmless there, and
      // also keeps injected/test middleware from stalling a parsed JSON request.
      proxyReq: fixRequestBody,
      error: (_err, _req, res) => {
        const response = res as import("node:http").ServerResponse;
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fleet worker is unavailable" } }));
      },
    },
  });
  app.use((req, res, next) => {
    if (!req.path.startsWith("/anthropic/") && !req.path.startsWith("/openai/")) { next(); return; }
    requireLlmKey(req, res, () => proxy(req, res, next));
  });

  // Deliberately no dashboard/API fallback. The tunnel maps this app, not the supervisor app.
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  return app;
}
