// Per-key serialized writes (one block's text, the page title): at most one
// request in flight per key; newer values wait and only the latest is sent.
// Each queued value carries its own callbacks, so a write queued by a later
// visit (A→B→A) reports to that visit. Keys are `${pageId}:${blockId|"title"}`;
// one shared instance (below) outlives navigation, so A's in-flight writes
// stay ordered before new edits.
// `send` persists; `onDone` applies the result to the caller's state — also
// when the value is deduped as already confirmed (result then undefined).
export type Writer = {
  send: (v: string) => Promise<unknown>;
  onDone: (v: string, result: unknown) => void;
  onError: (e: unknown) => void;
};
type Entry = { value: string; w: Writer; token?: number };
type Slot = {
  inflight: boolean;
  holds: number;
  desired?: Entry;
  // Last value sent successfully or in flight; reset to `confirmed` on failure.
  latest: string;
  confirmed: string;
};

export class WriteQueue {
  private slots = new Map<string, Slot>();

  private slot(key: string, server: string): Slot {
    let s = this.slots.get(key);
    if (!s) {
      s = { inflight: false, holds: 0, latest: server, confirmed: server };
      this.slots.set(key, s);
    } else if (!s.inflight && !s.holds && !s.desired) {
      // Idle: the server value (e.g. after a refresh) is the new baseline.
      s.latest = s.confirmed = server;
    }
    return s;
  }

  // Queue `value`. Identical to what's queued: keep the value, take the new
  // callbacks, and drop any split token (the entry is no longer the split's).
  // Nothing queued and equal to the last sent value: nothing to do.
  submit(key: string, value: string, server: string, w: Writer) {
    const s = this.slot(key, server);
    if (s.desired && s.desired.value === value) {
      s.desired = { value, w };
      return;
    }
    if (!s.desired && value === s.latest) return;
    s.desired = { value, w };
    void this.pump(s);
  }

  // Holds a key and queues `value` (always — pump dedupes against last sent);
  // nothing is sent until every hold is released. `token` tags the entry.
  hold(key: string, server: string, value: string, w: Writer, token: number) {
    const s = this.slot(key, server);
    s.holds++;
    s.desired = { value, w, token };
  }

  release(key: string) {
    const s = this.slots.get(key);
    if (!s) return;
    s.holds = Math.max(0, s.holds - 1);
    void this.pump(s);
  }

  // The queued (unsent) value, if any.
  pending(key: string): string | undefined {
    return this.slots.get(key)?.desired?.value;
  }

  // Drops the queued value only if it is still the one tagged `token`.
  dropIf(key: string, token: number): boolean {
    const s = this.slots.get(key);
    if (!s?.desired || s.desired.token !== token) return false;
    s.desired = undefined;
    return true;
  }

  private async pump(s: Slot) {
    if (s.inflight || s.holds) return;
    while (s.desired && !s.holds) {
      const e = s.desired;
      s.desired = undefined;
      if (e.value === s.latest && e.value === s.confirmed) {
        // Already persisted (e.g. by an older visit's write): still complete.
        e.w.onDone(e.value, undefined);
        continue;
      }
      s.inflight = true;
      s.latest = e.value;
      let result: unknown;
      try {
        result = await e.w.send(e.value);
        s.confirmed = e.value;
      } catch (err) {
        s.latest = s.confirmed;
        s.inflight = false;
        e.w.onError(err);
        continue;
      }
      s.inflight = false;
      e.w.onDone(e.value, result);
    }
  }
}

export const sharedWrites = new WriteQueue();
export const writeKey = (pageId: string, id: string) => `${pageId}:${id}`;
