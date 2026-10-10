// Write outcomes the components can't take at face value. A failure is
// definite only when the user declined, the platform refused, or Confluence
// answered 4xx (other than 408); network loss, timeouts, 5xx or no answer may
// have landed upstream, so the components look for the result before ever
// offering the same write again.

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function definiteFailure(e: unknown): boolean {
  const m = errText(e);
  if (/\b(408|5\d\d)\b|time(d)?\s?out|failed to fetch|load failed|network\s?error|abort/i.test(m)) return false;
  if (/declin|unauthori[sz]ed|forbidden|denied|not allowed|invalid|required|\b4\d\d\b/i.test(m)) return true;
  return false;
}

// Storage bodies compared as visible text: Confluence may normalize the markup it stores.
export function sameText(a: string, b: string): boolean {
  const plain = (s: string) =>
    s
      .replace(/<[^>]*>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  return plain(a) === plain(b);
}

// Created at or after the attempt (with a minute of clock skew).
export function since(iso: string | undefined, attemptMs: number): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= attemptMs - 60_000;
}

// Stable JSON (sorted keys): the shell re-sends init with the same inputs on token renewal, and that must not reset
// a component's edits or pending-write tracking.
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
