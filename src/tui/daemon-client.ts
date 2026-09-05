import type { StatusResponse, DoctorCheck, MetricSample, MetricsResponse } from "../shared/control-types.js";

export class DaemonClient {
  private csrf?: string;
  constructor(private base: string, private fetchFn: typeof fetch = fetch) {}
  private async post(path: string): Promise<void> {
    if (!this.csrf) {
      const response = await this.fetchFn(`${this.base}/api/bootstrap`);
      this.csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
    }
    const url = new URL(this.base);
    const response = await this.fetchFn(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.base, host: url.host, "x-cc-fleet-csrf": this.csrf },
      body: "{}",
    });
    if (!response.ok) throw new Error(`${path} → ${response.status}`);
  }
  async status(): Promise<StatusResponse> { return (await (await this.fetchFn(`${this.base}/api/status`)).json()) as StatusResponse; }
  async restart(): Promise<void> { return this.post("/api/restart"); }
  async stop(): Promise<void> { return this.post("/api/stop"); }
  async start(): Promise<void> { return this.post("/api/start"); }
  // ping=true runs the slower per-configured-model connectivity probe; default (false) is the cheap
  // light check (also what the dashboard polls). The TUI /doctor passes true.
  async doctor(ping = false): Promise<DoctorCheck[]> { return ((await (await this.fetchFn(`${this.base}/api/doctor${ping ? "?ping=1" : ""}`)).json()) as { checks: DoctorCheck[] }).checks; }
  async requests(): Promise<MetricSample[]> { return ((await (await this.fetchFn(`${this.base}/api/requests`)).json()) as { requests: MetricSample[] }).requests; }
  // Real lifetime + 24h rollups computed server-side over the whole request_log. /metrics uses this
  // instead of aggregating a 100-row requests() fetch.
  async metrics(): Promise<MetricsResponse> { return (await (await this.fetchFn(`${this.base}/api/metrics`)).json()) as MetricsResponse; }
  eventsUrl(): string { return `${this.base}/api/events`; }
}
