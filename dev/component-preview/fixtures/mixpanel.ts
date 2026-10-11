// Mixpanel fixtures: deterministic segmentation series (with breakdowns) and saved funnels.
import { Args, missing, UpstreamError } from "../mock-tangram";

export const previews = [
  { component: "event-chart", title: "Sign Up, daily totals, last 30 days", inputs: { event: "Sign Up" }, height: 520 },
  { component: "event-chart", title: "Purchase uniques by country, weekly, 90 days (12 values → top 10)", inputs: { event: "Purchase", on: 'properties["$country_code"]', unit: "week", type: "unique", range: "90d" }, height: 560 },
  { component: "event-chart", title: "Empty — no events in range", inputs: { event: "Legacy Export" }, height: 260 },
  { component: "event-chart", title: "Error — hourly query limit (429)", inputs: { event: "Rate Limited" }, height: 260 },
  { component: "funnel-view", title: "Saved funnel by id (name filled in when the picker opens)", inputs: { funnelId: 7012 }, height: 560 },
  { component: "funnel-view", title: "No funnelId — pick a saved funnel", inputs: {}, height: 420 },
];

const DAY = 86400000;
const TODAY = Date.UTC(2026, 9, 11);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const noise = (seed: number, i: number) => {
  const x = Math.sin(seed * 9301 + i * 49297) * 233280;
  return x - Math.floor(x);
};

function buckets(from: string, to: string, unit: string, interval?: number): string[] {
  const out: string[] = [];
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (unit === "month") {
    const d = new Date(start);
    d.setUTCDate(1);
    while (d.getTime() <= end) {
      out.push(iso(d.getTime()));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out;
  }
  const step = (interval ?? 1) * DAY;
  for (let t = start; t <= end; t += step) out.push(iso(t));
  return out;
}

const COUNTRIES = ["US", "GB", "DE", "FR", "IN", "BR", "CA", "JP", "AU", "NL", "ES", "SE"];

function segmentation(p: Record<string, unknown>) {
  const event = String(p.event);
  if (event === "Rate Limited") throw new UpstreamError(429, { error: "Query rate limit exceeded", status: 0 });
  const from = String(p.from_date);
  const to = String(p.to_date);
  const unit = String(p.unit ?? "day");
  const interval = typeof p.interval === "number" ? p.interval : undefined;
  const dates = buckets(from, to, unit, interval);
  const scale = (unit === "month" ? 30 : interval ?? 1) * (p.type === "unique" ? 0.4 : 1);
  const base = event === "Purchase" ? 180 : 420;
  const names = typeof p.on === "string" ? COUNTRIES : [event];
  const values: Record<string, Record<string, number>> = {};
  names.forEach((name, i) => {
    const share = typeof p.on === "string" ? 0.42 / (i + 1) : 1;
    values[name] = {};
    dates.forEach((d, j) => {
      const weekday = new Date(d).getUTCDay();
      const weekend = unit === "day" && (weekday === 0 || weekday === 6) ? 0.7 : 1;
      const growth = 1 + (Date.parse(d) - (TODAY - 90 * DAY)) / (400 * DAY);
      values[name][d] = event === "Legacy Export" ? 0 : Math.round(base * share * scale * weekend * growth * (0.85 + 0.3 * noise(i + 1, j)));
    });
  });
  return { data: { series: dates, values }, legend_size: names.length };
}

const FUNNELS = [
  { funnel_id: 7012, name: "Onboarding: sign up → first report" },
  { funnel_id: 7013, name: "Checkout" },
  { funnel_id: 7020, name: "Trial → paid" },
];

const STEPS: Record<number, [string, number, number][]> = {
  7012: [["Sign Up", 1, 0], ["Verify Email", 0.78, 540], ["Create Project", 0.52, 3900], ["Run First Report", 0.31, 86400 * 1.4]],
  7013: [["View Cart", 1, 0], ["Start Checkout", 0.61, 95], ["Enter Payment", 0.44, 140], ["Purchase", 0.39, 30]],
  7020: [["Start Trial", 1, 0], ["Invite Teammate", 0.35, 86400 * 3], ["Upgrade", 0.12, 86400 * 9]],
};

function funnel(p: Record<string, unknown>) {
  const id = Number(p.funnel_id);
  const steps = STEPS[id];
  if (!steps) throw new UpstreamError(400, { error: `funnel ${id} not found`, status: 0 });
  const entered = Math.round(2400 * ((Number(p.interval) || 30) / 30));
  const date = String(p.from_date);
  return {
    meta: { dates: [date] },
    data: {
      [date]: {
        steps: steps.map(([event, conv, t], i) => ({
          count: Math.round(entered * conv),
          avg_time: i ? t : null,
          goal: event,
          event,
          step_label: event,
          overall_conv_ratio: conv,
          step_conv_ratio: i ? conv / steps[i - 1][1] : 1,
        })),
        analysis: {},
      },
    },
  };
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const p = args.parameters ?? {};
  if (resourceType === "Event" && action === "Segment") return segmentation(p);
  if (resourceType === "Funnel" && action === "Query") return funnel(p);
  if (resourceType === "Funnel" && action === "List") return FUNNELS;
  return missing(resourceType, action);
}
