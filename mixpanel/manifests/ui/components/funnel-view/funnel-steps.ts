// Mixpanel /api/query/funnels response → one set of steps summed over every date bucket.
export type RawStep = {
  count?: number;
  avg_time?: number | null;
  goal?: string;
  event?: string;
  step_label?: string;
};
export type FunnelResult = { meta?: { dates?: string[] }; data?: Record<string, { steps?: RawStep[] }>; error?: string };
export type FunnelRef = { funnel_id: number; name: string };

export type Step = { label: string; count: number; avgTime: number | null };

export function toSteps(r: FunnelResult): Step[] {
  const steps: { label: string; count: number; timeWeight: number; timeCount: number }[] = [];
  Object.values(r.data ?? {}).forEach((bucket) => {
    (bucket?.steps ?? []).forEach((s, i) => {
      const count = typeof s.count === "number" && Number.isFinite(s.count) ? s.count : 0;
      const cur = (steps[i] ??= { label: s.step_label || s.goal || s.event || `Step ${i + 1}`, count: 0, timeWeight: 0, timeCount: 0 });
      cur.count += count;
      // avg_time is the bucket's mean time from the previous step — weight it by the users who made it
      if (i > 0 && typeof s.avg_time === "number" && Number.isFinite(s.avg_time) && count > 0) {
        cur.timeWeight += s.avg_time * count;
        cur.timeCount += count;
      }
    });
  });
  return steps.map((s) => ({ label: s.label, count: s.count, avgTime: s.timeCount ? s.timeWeight / s.timeCount : null }));
}

export function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

export function parseFunnelId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
