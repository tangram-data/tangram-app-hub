// Per-key serialized writes (one block's text, the page title): at most one
// request in flight per key; newer values wait and only the latest is sent.
// A value equal to what was last sent (or confirmed) is skipped, so reverting
// while an earlier save is pending still sends the corrective write.
type Slot = {
  inflight: boolean;
  held: boolean;
  desired?: string;
  // Last value sent successfully or in flight; reset to `confirmed` on failure.
  latest: string;
  confirmed: string;
};

export class WriteQueue {
  private slots = new Map<string, Slot>();

  private slot(key: string, server: string): Slot {
    let s = this.slots.get(key);
    if (!s) {
      s = { inflight: false, held: false, latest: server, confirmed: server };
      this.slots.set(key, s);
    } else if (!s.inflight && !s.held && s.desired === undefined) {
      // Idle: the server value (e.g. after a refresh) is the new baseline.
      s.latest = s.confirmed = server;
    }
    return s;
  }

  // `send` performs the write; it rejects on failure. `onError` sees failures.
  submit(
    key: string,
    value: string,
    server: string,
    send: (v: string) => Promise<void>,
    onError: (e: unknown) => void,
  ) {
    const s = this.slot(key, server);
    if (value === (s.desired ?? s.latest)) {
      s.desired = undefined;
      return;
    }
    s.desired = value;
    void this.pump(s, send, onError);
  }

  // Holds a key: submissions queue but nothing is sent until release().
  hold(key: string, server: string) {
    this.slot(key, server).held = true;
  }

  release(key: string, send: (v: string) => Promise<void>, onError: (e: unknown) => void) {
    const s = this.slots.get(key);
    if (!s) return;
    s.held = false;
    void this.pump(s, send, onError);
  }

  // The value a held key would send (its queued edit), if any.
  pending(key: string): string | undefined {
    return this.slots.get(key)?.desired;
  }

  drop(key: string) {
    const s = this.slots.get(key);
    if (s) s.desired = undefined;
  }

  private async pump(s: Slot, send: (v: string) => Promise<void>, onError: (e: unknown) => void) {
    if (s.inflight || s.held) return;
    while (s.desired !== undefined && !s.held) {
      const v = s.desired;
      s.desired = undefined;
      if (v === s.latest && v === s.confirmed) continue;
      s.inflight = true;
      s.latest = v;
      try {
        await send(v);
        s.confirmed = v;
      } catch (e) {
        s.latest = s.confirmed;
        onError(e);
      } finally {
        s.inflight = false;
      }
    }
  }
}
