import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "../components/select.js";
import { theme } from "../theme.js";
import { modelLabel } from "../screens/model.js";
import type { Scope, ApplyResult } from "./apply.js";

export type SetupClient = "claude" | "codex";
type Step = "loading" | "model" | "scope" | "applying" | "done" | "error";

export interface WizardProps {
  client: SetupClient;
  loadModels: () => Promise<string[]>;
  limits?: Record<string, number>;
  labels?: Record<string, string>;
  apply: (scope: Scope, model: string) => Promise<ApplyResult>;
  onDone: (result: ApplyResult, model: string) => void;
  onCancel: () => void;
}

function Dismiss({ onDismiss }: { onDismiss: () => void }) {
  useInput(() => onDismiss());
  return <Text color={theme.muted}>press any key to continue</Text>;
}

export function SetupWizard({ client, loadModels, limits, labels, apply, onDone, onCancel }: WizardProps) {
  const [step, setStep] = useState<Step>("loading");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    loadModels().then((m) => { setModels(m); setStep("model"); }).catch((e) => { setErr(String(e)); setStep("error"); });
  }, []);

  async function doApply(scope: Scope) {
    setStep("applying");
    try { const r = await apply(scope, model); setResult(r); setStep("done"); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStep("error"); }
  }

  const heading = step === "model" ? "choose a model" : step === "scope" ? "choose scope" : "";
  // In Claude setup, mapped native aliases are the compatibility feature the user came here to select.
  // Keep both partitions stable: mapped rows first, then every other discovered model in upstream order.
  const orderedModels = client === "claude" && labels
    ? [...models.filter((m) => labels[m]?.includes(" → ")), ...models.filter((m) => !labels[m]?.includes(" → "))]
    : models;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>setup {client}{heading ? `  ·  ${heading}` : ""}</Text>

      {step === "loading" && <Text color={theme.muted}>loading models from Copilot…</Text>}

      {step === "model" && (
        <Select
          items={orderedModels.map((m) => ({ label: modelLabel(m, "", limits, labels?.[m]), value: m }))}
          onSubmit={(v) => { setModel(v.value); setStep("scope"); }}
          onCancel={onCancel}
        />
      )}

      {step === "scope" && (
        <Select
          items={[
            { label: "global   — this machine, all projects", value: "global" },
            { label: "project  — current directory only", value: "project" },
          ]}
          onSubmit={(v) => void doApply(v.value as Scope)}
          onCancel={onCancel}
        />
      )}

      {step === "applying" && <Text color={theme.muted}>applying…</Text>}

      {step === "done" && result && (
        <Box flexDirection="column">
          <Text color={theme.ready}>✓ configured · model {model}</Text>
          <Text color={theme.output}>wrote {result.path}</Text>
          <Text color={theme.muted}>keys: {result.changed.join(", ") || "(no change)"}</Text>
          <Dismiss onDismiss={() => onDone(result, model)} />
        </Box>
      )}

      {step === "error" && (
        <Box flexDirection="column">
          <Text color={theme.error}>failed: {err}</Text>
          <Dismiss onDismiss={onCancel} />
        </Box>
      )}
    </Box>
  );
}
