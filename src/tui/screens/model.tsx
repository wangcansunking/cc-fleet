import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Select } from "../components/select.js";
import { theme } from "../theme.js";
import { formatContextWindow } from "../../shared/format.js";

// Label a model with its context window (e.g. "claude-opus-4-8  · 200K") and a (current) marker.
export function modelLabel(m: string, current: string, limits?: Record<string, number>, display = m): string {
  const win = formatContextWindow(limits?.[m]);
  return `${display}${win ? `  · ${win}` : ""}${m === current ? "  (current)" : ""}`;
}

export function ModelScreen({ loadModels, limits, labels, current, onPick, onCancel }: {
  loadModels: () => Promise<string[]>;
  limits?: Record<string, number>;
  labels?: Record<string, string>;
  current: string;
  onPick: (model: string) => void;
  onCancel: () => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  useEffect(() => { loadModels().then(setModels).catch(() => setModels([])); }, []);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>select chat model</Text>
      {!models ? (
        <Text color={theme.muted}>loading models from Copilot…</Text>
      ) : (
        <Select
          items={models.map((m) => ({ label: modelLabel(m, current, limits, labels?.[m]), value: m }))}
          onSubmit={(v) => onPick(v.value)}
          onCancel={onCancel}
        />
      )}
    </Box>
  );
}
