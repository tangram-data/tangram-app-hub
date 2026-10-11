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

export const UNITS = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

// Week buckets are 7-day intervals: the segmentation unit itself has no week.
export function unitParams(unit: string): Record<string, unknown> {
  if (unit === "week") return { unit: "day", interval: 7 };
  return { unit: unit === "month" ? "month" : "day" };
}

export function normalizeUnit(v: unknown): string {
  return UNITS.some((u) => u.key === v) ? String(v) : "day";
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
