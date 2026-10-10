// Datadog /api/v1/query response → recharts rows (one column per series), plus range math.
import dayjs from "dayjs";

export const RANGES: { key: string; label: string; seconds: number }[] = [
  { key: "15m", label: "15m", seconds: 15 * 60 },
  { key: "1h", label: "1h", seconds: 3600 },
  { key: "4h", label: "4h", seconds: 4 * 3600 },
  { key: "1d", label: "1d", seconds: 86400 },
  { key: "7d", label: "7d", seconds: 7 * 86400 },
];
export const MAX_SERIES = 10;
// Datadog-ish categorical palette, purple first.
export const COLORS = ["#632ca6", "#1c7ed6", "#e8590c", "#2b8a3e", "#c2255c", "#0c8599", "#f08c00", "#5f3dc4", "#868e96", "#a61e4d"];

export type Series = {
  scope?: string;
  expression?: string;
  display_name?: string;
  metric?: string;
  pointlist?: [number, number | null][];
  unit?: ({ short_name?: string; name?: string } | null)[] | null;
};
export type QueryResult = { status?: string; error?: string; series?: Series[]; from_date?: number; to_date?: number };


// "metric {scope}": two metrics sharing a scope stay distinguishable.
export function seriesLabel(s: Series, i: number): string {
  const scope = s.scope && s.scope !== "*" ? s.scope : "";
  const name = s.metric || s.display_name || s.expression || "";
  if (name && scope) return `${name} {${scope}}`;
  return name || scope || `series ${i + 1}`;
}

// A valid point with no valid neighbour is drawn as a dot — the line can't reach it.
export function isIsolated(points: Point[], index: number): boolean {
  const ok = (j: number) => j >= 0 && j < points.length && points[j].v !== null;
  return ok(index) && !ok(index - 1) && !ok(index + 1);
}

// Datadog sends unit = [unit, per_unit]: bytes + second → "B/s".
export function unitOf(s: Series): string {
  const name = (u: { short_name?: string; name?: string } | null | undefined) => u?.short_name || u?.name || "";
  const [base, per] = [name(s.unit?.[0]), name(s.unit?.[1])];
  return base && per ? `${base}/${per}` : base || (per ? `/${per}` : "");
}

// A shared y-axis unit only when every series agrees.
export function axisUnit(series: Series[]): string {
  const units = new Set(series.map(unitOf));
  return units.size === 1 ? Array.from(units)[0] : "";
}

// Each series keeps its own timestamps (sampling differs between series); a null point stays a gap.
export type Point = { t: number; v: number | null };
export type Line = { key: string; label: string; color: string; unit: string; points: Point[] };

export function toLines(series: Series[]): Line[] {
  return series.map((s, i) => ({
    key: `s${i}`,
    label: seriesLabel(s, i),
    color: COLORS[i % COLORS.length],
    unit: unitOf(s),
    points: (s.pointlist ?? [])
      .map(([t, v]) => ({ t, v: typeof v === "number" && Number.isFinite(v) ? v : null }))
      .sort((a, b) => a.t - b.t),
  }));
}

export function hasData(lines: Line[]): boolean {
  return lines.some((l) => l.points.some((p) => p.v !== null));
}

export function tickTime(ms: number, spanSeconds: number): string {
  const d = dayjs(ms);
  if (spanSeconds <= 86400) return d.format("HH:mm");
  return d.format("MMM D");
}

export function fullTime(ms: number): string {
  return dayjs(ms).format("MMM D, YYYY HH:mm:ss");
}

// 1234567 → 1.23M; small values keep up to 3 significant decimals.
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a === 0) return "0";
  if (a < 0.01) return v.toExponential(1);
  return String(Number(v.toPrecision(3)));
}

// Stable JSON (sorted keys) — a re-sent tangram:init with the same inputs must not reset the view.
export function stableKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
