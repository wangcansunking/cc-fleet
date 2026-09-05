// A controllable fake worker for WorkerMonitor lifecycle tests. Forked by monitor.test.
// Behavior is driven by env:
//   FAKE_MODE=ready    -> send {ready} and stay alive until {shutdown}
//   FAKE_MODE=crash    -> send {ready}, then exit(1) after FAKE_CRASH_MS
//   FAKE_MODE=instant  -> exit(1) immediately (never ready) — exercises crash-before-ready
//   FAKE_MODE=metric   -> send {ready} then a {request-metric}, stay alive
const mode = process.env.FAKE_MODE || "ready";
const send = (m) => process.send && process.send(m);

if (mode === "instant") {
  process.exit(1);
} else {
  // Echo BIND_HOST back so monitor tests can assert the supervisor handed the worker the right bind
  // host for the active access mode (loopback vs 0.0.0.0).
  send({ type: "ready", port: Number(process.env.WORKER_PORT || 0), bindHost: process.env.BIND_HOST });
  if (mode === "metric") send({ type: "request-metric", endpoint: "/v1/messages", model: "m", status: 200, latencyMs: 3 });
  if (mode === "crash") setTimeout(() => process.exit(1), Number(process.env.FAKE_CRASH_MS || 20));
  process.on("message", (m) => { if (m && m.type === "shutdown") process.exit(0); });
  // Parent-death guard, mirroring the real worker (src/worker/index.ts): when the supervisor dies
  // abnormally the IPC channel drops and 'disconnect' fires — exit so we don't orphan and squat :7991.
  process.on("disconnect", () => process.exit(0));
  // keep the event loop alive
  setInterval(() => {}, 1000);
}
