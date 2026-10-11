// Date windows and number formatting shared by the Mixpanel components.
import dayjs from "dayjs";

export const RANGES = [
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A preset ending today, or "custom" with explicit YYYY-MM-DD dates from render inputs.
export type DateWindow = { range: string; from?: string; to?: string };

export function windowFromInputs(inputs: Record<string, unknown>, fallback = "30d"): DateWindow {
  const from = String(inputs.from_date ?? "");
  const to = String(inputs.to_date ?? "");
  if (DAY.test(from) && DAY.test(to) && dayjs(from).isValid() && dayjs(to).isValid() && from <= to)
    return { range: "custom", from, to };
  const r = String(inputs.range ?? fallback);
  return { range: RANGES.some((x) => x.key === r) ? r : fallback };
}

// Inclusive YYYY-MM-DD bounds; presets end today in the viewer's timezone (Mixpanel reads them in project time).
export function resolveWindow(w: DateWindow): { from: string; to: string; days: number } {
  if (w.range === "custom" && w.from && w.to) {
    return { from: w.from, to: w.to, days: dayjs(w.to).diff(dayjs(w.from), "day") + 1 };
  }
  const days = RANGES.find((r) => r.key === w.range)?.days ?? 30;
  const to = dayjs();
  return { from: to.subtract(days - 1, "day").format("YYYY-MM-DD"), to: to.format("YYYY-MM-DD"), days };
}

export function windowLabel(w: { from: string; to: string }): string {
  const a = dayjs(w.from);
  const b = dayjs(w.to);
  return a.year() === b.year() ? `${a.format("MMM D")} – ${b.format("MMM D, YYYY")}` : `${a.format("MMM D, YYYY")} – ${b.format("MMM D, YYYY")}`;
}

// 1234567 → 1.23M
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (Number.isInteger(v) || a >= 100) return Math.round(v).toLocaleString();
  return String(Number(v.toPrecision(3)));
}

export function percent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  const p = ratio * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

// Seconds → "2h 5m" / "45s".
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

// performAction rejects with Error("Upstream API error NNN: {json}") — surface Mixpanel's own "error" text.
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/^Upstream API error (\d+): ([\s\S]*)$/);
  if (!m) return raw;
  try {
    const body = JSON.parse(m[2]);
    const msg = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
    if (m[1] === "429") return "Mixpanel's query limit for this project was reached (60 queries/hour) — try again later.";
    return msg ? `${msg} (HTTP ${m[1]})` : raw;
  } catch {
    return m[1] === "429" ? "Mixpanel's query limit for this project was reached (60 queries/hour) — try again later." : raw;
  }
}
