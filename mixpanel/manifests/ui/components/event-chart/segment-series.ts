// Mixpanel /api/query/segmentation response → recharts rows (one column per series), top series first.
export type SegmentResult = {
  data?: { series?: string[]; values?: Record<string, Record<string, number | null>> };
  legend_size?: number;
  error?: string;
};

export const MAX_SERIES = 10;
// Mixpanel-ish categorical palette, violet first.
export const COLORS = ["#7856ff", "#ff7557", "#80e1d9", "#f8bc3b", "#b2596e", "#72bef4", "#ffb27a", "#0d9488", "#c86fd0", "#8d8a9c"];

export type Line = { key: string; label: string; color: string; total: number };
export type Row = { date: string } & Record<string, number | string | null>;

export type Unit = { key: string; label: string };
export const BASE_UNITS: Unit[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

// The call's own bucket (hour, minute, or an N-day interval) stays selectable next to day/week/month.
export function unitFromInputs(unit: unknown, interval: unknown): Unit {
  const n = Number(interval);
  if (Number.isInteger(n) && n > 1 && unit !== "month") return n === 7 ? BASE_UNITS[1] : { key: `${n}d`, label: `${n} days` };
  if (unit === "hour") return { key: "hour", label: "Hour" };
  if (unit === "minute") return { key: "minute", label: "Minute" };
  return BASE_UNITS.find((u) => u.key === unit) ?? BASE_UNITS[0];
}

export function unitsFor(current: Unit): Unit[] {
  return BASE_UNITS.some((u) => u.key === current.key) ? BASE_UNITS : [current, ...BASE_UNITS];
}

/**
 * Request bucketing. Mixpanel applies `interval` only to unique/average queries, so weekly totals are asked for by
 * day and rolled up here ([[rollUp]]); weekly uniques must come from Mixpanel (summing daily uniques double-counts).
 */
export function unitParams(unit: string, type: string): { params: Record<string, unknown>; rollUpDays: number } {
  const n = /^(\d+)d$/.exec(unit)?.[1];
  const days = unit === "week" ? 7 : n ? Number(n) : 0;
  if (days) return type === "general" ? { params: { unit: "day" }, rollUpDays: days } : { params: { unit: "day", interval: days }, rollUpDays: 0 };
  return { params: { unit: ["minute", "hour", "month"].includes(unit) ? unit : "day" }, rollUpDays: 0 };
}

// Daily totals → `days`-day buckets starting at `from` (each labelled with its first day).
export function rollUp(r: SegmentResult, from: string, days: number): SegmentResult {
  const start = Date.parse(`${from}T00:00:00Z`);
  const bucketOf = (d: string) => {
    const i = Math.max(0, Math.floor((Date.parse(`${d.slice(0, 10)}T00:00:00Z`) - start) / (days * 86400000)));
    return new Date(start + i * days * 86400000).toISOString().slice(0, 10);
  };
  const series = Array.from(new Set((r.data?.series ?? []).map(bucketOf))).sort();
  const values: Record<string, Record<string, number | null>> = {};
  Object.entries(r.data?.values ?? {}).forEach(([name, byDate]) => {
    const out: Record<string, number | null> = {};
    series.forEach((d) => (out[d] = 0));
    Object.entries(byDate ?? {}).forEach(([d, v]) => {
      if (typeof v === "number" && Number.isFinite(v)) out[bucketOf(d)] = (out[bucketOf(d)] ?? 0) + v;
    });
    values[name] = out;
  });
  return { ...r, data: { series, values } };
}

export function toChart(r: SegmentResult): { rows: Row[]; lines: Line[]; more: number } {
  const dates = [...(r.data?.series ?? [])].sort();
  const values = r.data?.values ?? {};
  const all = Object.entries(values).map(([name, byDate]) => ({
    name,
    byDate: byDate ?? {},
    total: Object.values(byDate ?? {}).reduce<number>((a, v) => a + (typeof v === "number" && Number.isFinite(v) ? v : 0), 0),
  }));
  all.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const kept = all.slice(0, MAX_SERIES);
  const lines = kept.map((s, i) => ({ key: `s${i}`, label: s.name, color: COLORS[i % COLORS.length], total: s.total }));
  const rows = dates.map((date) => {
    const row: Row = { date };
    kept.forEach((s, i) => {
      const v = s.byDate[date];
      row[`s${i}`] = typeof v === "number" && Number.isFinite(v) ? v : null;
    });
    return row;
  });
  return { rows, lines, more: Math.max(0, all.length - kept.length) };
}

// Mixpanel fills empty buckets with 0, so an all-zero result means no events.
export function hasData(rows: Row[], lines: Line[]): boolean {
  return rows.some((r) => lines.some((l) => typeof r[l.key] === "number" && r[l.key] !== 0));
}
