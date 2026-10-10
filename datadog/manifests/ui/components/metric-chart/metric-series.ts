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

export type Line = { key: string; label: string; color: string };
export type Row = { t: number } & Record<string, number | null>;

export function seriesLabel(s: Series, i: number): string {
  const scope = s.scope && s.scope !== "*" ? s.scope : "";
  return scope || s.display_name || s.expression || s.metric || `series ${i + 1}`;
}

export function unitOf(series: Series[]): string {
  for (const s of series) {
    const u = s.unit?.[0];
    if (u?.short_name) return u.short_name;
  }
  return "";
}

// Merge every series' points onto one timestamp axis; missing points stay null (line gaps).
export function toRows(series: Series[]): { rows: Row[]; lines: Line[] } {
  const lines = series.map((s, i) => ({ key: `s${i}`, label: seriesLabel(s, i), color: COLORS[i % COLORS.length] }));
  const byTime = new Map<number, Row>();
  series.forEach((s, i) => {
    for (const [t, v] of s.pointlist ?? []) {
      const row = byTime.get(t) ?? ({ t } as Row);
      row[`s${i}`] = typeof v === "number" && Number.isFinite(v) ? v : null;
      byTime.set(t, row);
    }
  });
  const rows = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  return { rows, lines };
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
