// Datadog fixtures: monitors (search + detail with groups) and deterministic metric timeseries.
import { Args, missing, UpstreamError } from "../mock-tangram";

export const previews = [
  { component: "monitor-list", title: "Alerting monitors (default query) — expand a row for failing groups", inputs: {}, height: 560 },
  { component: "monitor-list", title: "All monitors for service:checkout", inputs: { query: "service:checkout" }, height: 520 },
  { component: "metric-chart", title: "Network bytes per host (B/s), one sparse series with gaps", inputs: { query: "avg:system.net.bytes_rcvd{env:prod} by {host}", range: "4h" }, height: 480 },
  { component: "metric-chart", title: "Empty result — no data in range", inputs: { query: "avg:legacy.queue.depth{env:prod}", range: "1h" }, height: 260 },
  { component: "metric-chart", title: "Error — malformed query", inputs: { query: "avg:system.cpu.user{env:prod by {host}", range: "1h" }, height: 260 },
];

const NOW = Math.floor(Date.UTC(2026, 9, 10, 15, 0, 0) / 1000);
const ago = (min: number) => NOW - min * 60;

type Mon = {
  id: number; name: string; status: string; type: string; tags: string[]; last_triggered_ts: number | null;
  query: string; message: string; thresholds: Record<string, number>; groups: [string, string, number | null][];
};

const MONITORS: Mon[] = [
  { id: 4401, name: "[checkout] p95 latency above 800ms", status: "Alert", type: "metric alert", tags: ["service:checkout", "env:prod", "team:payments"],
    last_triggered_ts: ago(12), query: "avg(last_5m):p95:trace.http.request.duration{service:checkout,env:prod} by {host} > 0.8",
    message: "p95 latency on {{host.name}} is {{value}}s.\n@pagerduty-payments @slack-payments-alerts",
    thresholds: { critical: 0.8, warning: 0.6 },
    groups: [["host:web-prod-03", "Alert", ago(12)], ["host:web-prod-07", "Alert", ago(9)], ["host:web-prod-01", "Warn", ago(30)], ["host:web-prod-02", "OK", ago(300)], ["host:web-prod-04", "OK", null]] },
  { id: 4402, name: "[checkout] 5xx error rate", status: "Warn", type: "query alert", tags: ["service:checkout", "env:prod"],
    last_triggered_ts: ago(44), query: "sum(last_10m):sum:trace.http.request.errors{service:checkout}.as_count() / sum:trace.http.request.hits{service:checkout}.as_count() > 0.05",
    message: "Error rate is {{value}}. Check recent deploys.", thresholds: { critical: 0.05, warning: 0.02 },
    groups: [["*", "Warn", ago(44)]] },
  { id: 4403, name: "Disk space low on db nodes", status: "Alert", type: "metric alert", tags: ["role:db", "env:prod", "team:platform"],
    last_triggered_ts: ago(95), query: "avg(last_15m):avg:system.disk.in_use{role:db} by {host,device} > 0.9",
    message: "{{host.name}} {{device.name}} is {{value}} full.", thresholds: { critical: 0.9, warning: 0.8, critical_recovery: 0.85 },
    groups: [["host:db-prod-1,device:/dev/nvme1n1", "Alert", ago(95)], ["host:db-prod-2,device:/dev/nvme1n1", "Warn", ago(140)], ["host:db-prod-3,device:/dev/nvme1n1", "OK", null]] },
  { id: 4404, name: "Kafka consumer lag — orders", status: "No Data", type: "metric alert", tags: ["service:orders", "env:prod"],
    last_triggered_ts: ago(600), query: "max(last_10m):max:kafka.consumer_lag{consumer_group:orders} > 50000",
    message: "Consumer lag high.", thresholds: { critical: 50000 }, groups: [] },
  { id: 4405, name: "[checkout] synthetic: cart → pay flow", status: "OK", type: "synthetics alert", tags: ["service:checkout", "env:prod"],
    last_triggered_ts: ago(4300), query: "Synthetics: cart-to-pay browser test", message: "Checkout flow failing.", thresholds: {},
    groups: [["location:aws:us-east-1", "OK", null], ["location:aws:eu-west-1", "OK", null]] },
  { id: 4406, name: "API gateway CPU", status: "OK", type: "metric alert", tags: ["service:gateway", "env:prod"],
    last_triggered_ts: null, query: "avg(last_5m):avg:system.cpu.user{service:gateway} by {host} > 85",
    message: "CPU high.", thresholds: { critical: 85, warning: 70 }, groups: [["host:gw-1", "OK", null]] },
];

// Monitor query: status:(a OR b) / status:a filters, other tokens (k:v or words) must appear in name or tags.
function matches(m: Mon, q: string): boolean {
  let rest = q;
  const statusGroup = /status:\(([^)]*)\)|status:("[^"]*"|\S+)/gi;
  const wanted: string[] = [];
  rest = rest.replace(statusGroup, (_all, group, single) => {
    const raw = (group ?? single ?? "") as string;
    raw.split(/\s+OR\s+/i).forEach((s) => wanted.push(s.replace(/"/g, "").trim().toLowerCase()));
    return " ";
  });
  if (wanted.length && !wanted.includes(m.status.toLowerCase())) return false;
  const hay = `${m.name} ${m.tags.join(" ")}`.toLowerCase();
  return rest
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok.replace(/^tag:/, "").toLowerCase()));
}

function search(p: Record<string, unknown>) {
  const q = String(p.query ?? "");
  const page = Number(p.page ?? 0);
  const per = Number(p.per_page ?? 30);
  const rank: Record<string, number> = { alert: 0, warn: 1, "no data": 2, ok: 3 };
  const hits = MONITORS.filter((m) => matches(m, q)).sort((a, b) => rank[a.status.toLowerCase()] - rank[b.status.toLowerCase()]);
  return {
    monitors: hits.slice(page * per, page * per + per).map((m) => ({
      id: m.id, name: m.name, status: m.status, type: m.type, tags: m.tags, last_triggered_ts: m.last_triggered_ts,
      classification: "metric", creator: { name: "Preview Bot", handle: "preview@example.com" },
    })),
    metadata: { page, per_page: per, page_count: Math.max(1, Math.ceil(hits.length / per)), total_count: hits.length },
    counts: {},
  };
}

function getMonitor(p: Record<string, unknown>) {
  const m = MONITORS.find((x) => x.id === Number(p.monitor_id));
  if (!m) throw new UpstreamError(404, { errors: ["Monitor not found"] });
  const groups: Record<string, unknown> = {};
  for (const [name, status, ts] of m.groups) groups[name] = { name, status, last_triggered_ts: ts, last_nodata_ts: null };
  return {
    id: m.id, name: m.name, type: m.type, query: m.query, message: m.message, tags: m.tags,
    overall_state: m.status, options: { thresholds: m.thresholds, notify_no_data: false },
    state: p.group_states ? { groups } : undefined,
  };
}

// Deterministic pseudo-noise from (seed, t) so every range renders the same shape.
function noise(seed: number, t: number): number {
  const x = Math.sin(seed * 12.9898 + t * 0.000078233) * 43758.5453;
  return x - Math.floor(x);
}

function metricQuery(p: Record<string, unknown>) {
  const query = String(p.query ?? "");
  const from = Number(p.from);
  const to = Number(p.to);
  if ((query.match(/{/g) ?? []).length !== (query.match(/}/g) ?? []).length)
    throw new UpstreamError(400, { errors: [`Error parsing query: unbalanced braces in "${query}"`] });
  if (query.includes("legacy.")) return { status: "ok", res_type: "time_series", series: [], from_date: from * 1000, to_date: to * 1000, query };
  const span = Math.max(60, to - from);
  const step = Math.max(20, Math.round(span / 150));
  const hosts = ["web-prod-01", "web-prod-02", "web-prod-03", "batch-prod-01"];
  const unit = [{ family: "bytes", name: "byte", short_name: "B" }, { family: "time", name: "second", short_name: "s" }];
  const series = hosts.map((host, i) => {
    const base = [2.4e6, 1.8e6, 3.1e6, 0.6e6][i];
    const points: [number, number | null][] = [];
    for (let t = from - (from % step); t <= to; t += step) {
      const daily = 1 + 0.35 * Math.sin((t / 86400) * 2 * Math.PI);
      let v: number | null = base * daily * (0.85 + 0.3 * noise(i + 1, t));
      // The batch host reports sparsely, with gaps and an isolated sample.
      if (host.startsWith("batch")) {
        const slot = Math.floor(t / step) % 12;
        v = slot < 4 ? v : slot === 7 ? v * 1.6 : null;
      }
      points.push([t * 1000, v === null ? null : Math.round(v)]);
    }
    return {
      metric: "system.net.bytes_rcvd", display_name: "system.net.bytes_rcvd", scope: `env:prod,host:${host}`,
      expression: `avg:system.net.bytes_rcvd{env:prod,host:${host}}`, pointlist: points, length: points.length,
      interval: step, unit, aggr: "avg", start: from * 1000, end: to * 1000, tag_set: [`host:${host}`, "env:prod"],
    };
  });
  return { status: "ok", res_type: "time_series", series, from_date: from * 1000, to_date: to * 1000, query };
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const p = args.parameters ?? {};
  if (resourceType === "Monitor" && action === "Search") return search(p);
  if (resourceType === "Monitor" && action === "Get") return getMonitor(p);
  if (resourceType === "Metric" && action === "Query") return metricQuery(p);
  return missing(resourceType, action);
}
