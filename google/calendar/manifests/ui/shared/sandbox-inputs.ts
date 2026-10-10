// Sandbox render inputs. Source of truth: design/kits/sandbox-inputs.ts — run scripts/sync-ui-kits.sh after editing.
// tangram.getInputs() is a promise, and tangram.onInput fires on init and again on every token renewal with the
// same inputs, so components subscribe here: called once per distinct inputs, never with a stale or empty first set.

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function onNewInputs(apply: (inputs: Record<string, unknown>) => void): void {
  let last: string | undefined;
  (window as any).tangram.onInput((inputs: Record<string, unknown> | null | undefined) => {
    const next = inputs ?? {};
    const key = stableJson(next);
    if (key === last) return;
    last = key;
    apply(next);
  });
}
