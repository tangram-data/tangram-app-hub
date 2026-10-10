// Idempotency keys per logical request, keyed by (operation slot, payload): the same request retried reuses its
// key (Stripe returns the first result instead of acting twice); a different payload gets its own key, and keys of
// other unresolved requests stay put. A key is released only when its own request succeeds.
export class IdempotencyKeys {
  private keys = new Map<string, string>();

  keyFor(slot: string, body: unknown): string {
    const id = `${slot}\u0000${JSON.stringify(body ?? null)}`;
    let key = this.keys.get(id);
    if (!key) {
      key = newKey();
      this.keys.set(id, key);
    }
    return key;
  }

  done(slot: string, body: unknown) {
    this.keys.delete(`${slot}\u0000${JSON.stringify(body ?? null)}`);
  }
}

function newKey(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
