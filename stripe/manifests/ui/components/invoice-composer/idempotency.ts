// Idempotency keys per logical request: the same request retried reuses its key (Stripe returns the first
// result instead of acting twice); a changed request gets a fresh key (Stripe rejects a key reused with
// different parameters). A key is released only by the request that used it, so a late completion of an
// older request can't drop a newer request's key.
export class IdempotencyKeys {
  private slots = new Map<string, { body: string; key: string }>();

  keyFor(slot: string, body: unknown): string {
    const text = JSON.stringify(body ?? null);
    const cur = this.slots.get(slot);
    if (cur && cur.body === text) return cur.key;
    const key = newKey();
    this.slots.set(slot, { body: text, key });
    return key;
  }

  done(slot: string, key: string) {
    if (this.slots.get(slot)?.key === key) this.slots.delete(slot);
  }
}

function newKey(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
