import type { ProviderAdapter } from "../providers/types.js";
import { bestModelMatch } from "../core/fuzzy.js";
import { FALLBACK_MODELS } from "../providers/copilot/models.js";
import { stripOneM, DEFAULT_ONE_M_MODELS, toCanonical, type CanonicalModel } from "../core/model-canonical.js";
import { availableClaudeMappings, backendForClaudeAlias } from "../core/claude-model-map.js";

export interface RouterOptions {
  claudeMapEnabled?: boolean;
}

// M1: single provider. Model name is remapped to the provider's actual id.
export class Router {
  private available: string[] = [];
  // Dashed canonical ids advertising a ~1M window, from live discovery. Empty until the fetch resolves.
  private oneM = new Set<string>();
  private limits: Record<string, number> = {};
  private liveDiscovery = false;
  constructor(private providers: ProviderAdapter[], private modelMap: Record<string, string>, private opts: RouterOptions = {}) {}
  // The live Copilot model list, used for fuzzy matching (set once fetched at worker startup).
  setAvailableModels(ids: string[], live = true): void { this.available = ids; this.liveDiscovery = live; }
  setModelLimits(limits: Record<string, number>): void { this.limits = { ...limits }; }
  // The set of models with a 1M window, from discovery. Ids arrive in Copilot's DOTTED form; store them
  // DASHED so is1M can compare against the canonical dashed ids the /v1/models mapper works with.
  setOneMModels(dottedIds: Iterable<string>): void {
    this.oneM = new Set([...dottedIds].map((id) => id.replace(/\./g, "-")));
  }
  // Oracle for toCanonical: is this DASHED canonical id a 1M model? Uses the live set once discovery has
  // populated it; before that (empty set) it falls back to the hardcoded defaults, so a known 1M model
  // never briefly loses its badge during startup — mirrors the reasoning gate's "empty ⇒ default" guard.
  is1M(dashed: string): boolean {
    return this.oneM.size ? this.oneM.has(dashed) : DEFAULT_ONE_M_MODELS.has(dashed);
  }
  // Real model ids only. OpenAI/Codex discovery must never see synthesized Claude aliases.
  listModels(): string[] { return this.available.length ? this.available : FALLBACK_MODELS; }

  // Anthropic discovery starts with the exact existing canonicalized list. When compatibility is enabled,
  // append only aliases whose exact GPT targets were observed in LIVE discovery. The fallback table is not
  // enough evidence to promise a backend that this account may not have.
  listAnthropicModels(): CanonicalModel[] {
    const real = this.listModels().map((id) => toCanonical(id, (d) => this.is1M(d)));
    if (!this.opts.claudeMapEnabled || !this.liveDiscovery) return real;
    for (const { alias, backend } of availableClaudeMappings(this.available)) {
      const limit = this.limits[backend];
      const mapped = toCanonical(alias, limit === undefined ? undefined : () => limit > 800_000);
      const existing = real.findIndex((model) => stripOneM(model.id) === alias);
      // If Copilot also advertises the real Claude id, there can still be only one picker entry. In map
      // mode that identity routes to GPT, so replace its metadata with the GPT backend-derived window.
      if (existing >= 0) real[existing] = mapped;
      else real.push(mapped);
    }
    return real;
  }

  modelLimit(model: string): number | undefined {
    const backend = this.opts.claudeMapEnabled && this.liveDiscovery ? backendForClaudeAlias(model, this.available) : undefined;
    return this.limits[backend ?? stripOneM(model)];
  }

  resolveModel(requested: string): string {
    // Claude Code appends [1m] to signal its 1M context window; Copilot doesn't know that id, so
    // strip it back to the canonical model before mapping/forwarding.
    requested = stripOneM(requested);
    if (this.opts.claudeMapEnabled && this.liveDiscovery) {
      const backend = backendForClaudeAlias(requested, this.available);
      if (backend) return backend;
    }
    const mapped = this.modelMap[requested];
    if (mapped) return mapped;
    // Fuzzy-match a near-miss id (e.g. canonical claude-opus-4-8 -> Copilot claude-opus-4.8) to a real model.
    if (this.available.length) {
      const match = bestModelMatch(requested, this.available);
      if (match) return match;
    }
    return this.modelMap["*"] ?? requested;
  }
  pick(_model: string): ProviderAdapter {
    const p = this.providers[0];
    if (!p) throw new Error("no provider registered");
    return p;
  }
}
