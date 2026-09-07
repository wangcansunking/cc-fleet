import {
  BUILTIN_CLAUDE_MODEL_MAP,
  claudeMappingRows,
  type ClaudeMappingRow,
  type ClaudeMapUserEntry,
  type ClaudeModelMapping,
} from "../core/claude-model-map.js";
import {
  readClaudeMapConfig,
  replaceClaudeMapConfig,
  resetClaudeMapEntries,
  type ClaudeMapReplacement,
} from "../shared/claude-map-store.js";

export interface ClaudeMapAdminStatus {
  enabled: boolean;
  entries: ClaudeMappingRow[];
  userEntries: ClaudeMapUserEntry[];
  builtins: readonly ClaudeModelMapping[];
  liveBackendIds: string[];
  warning: string | null;
}

export interface ClaudeMapAdmin {
  status(): Promise<ClaudeMapAdminStatus>;
  replace(config: ClaudeMapReplacement): Promise<ClaudeMapAdminStatus>;
  reset(): Promise<ClaudeMapAdminStatus>;
}

export function createClaudeMapAdmin(dir: string, listBackendIds: () => Promise<string[]>): ClaudeMapAdmin {
  const status = async (): Promise<ClaudeMapAdminStatus> => {
    const config = readClaudeMapConfig(dir);
    let liveBackendIds: string[] = [];
    try { liveBackendIds = [...new Set(await listBackendIds())]; } catch { /* worker may be restarting */ }
    return {
      enabled: config.enabled,
      entries: claudeMappingRows(config.effectiveMappings, liveBackendIds),
      userEntries: config.entries,
      builtins: BUILTIN_CLAUDE_MODEL_MAP,
      liveBackendIds,
      warning: config.warning,
    };
  };
  return {
    status,
    replace: async (config) => { replaceClaudeMapConfig(dir, config); return status(); },
    reset: async () => { resetClaudeMapEntries(dir); return status(); },
  };
}
