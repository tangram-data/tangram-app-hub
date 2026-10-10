// Write/reconcile bookkeeping for the invoice composer, kept for the component's lifetime (across input changes):
//   - one write in flight per lock (invoice id, or "create");
//   - an invoice that had a write is "unreconciled" until a read that started after every write on it settled;
//   - a Delete without a clear answer is remembered, so a not-found on reconcile means it went through;
//   - drafts created here, by create payload, offered as a resume instead of a duplicate create;
//   - successful sends per invoice (Send becomes Resend; each resend is a new request);
//   - lines added whose `saved` is due once the invoice is read back.
export type ReadToken = { id: string; epoch: number; clean: boolean };

export class WriteBook {
  private inFlight = new Set<string>();
  private unreconciled = new Set<string>();
  private epochs = new Map<string, number>();
  private pendingDeletes = new Set<string>();
  private drafts = new Map<string, string>();
  private sends = new Map<string, number>();
  private savedDue = new Set<string>();

  /** Takes the lock; false when a write already holds it. */
  begin(lock: string): boolean {
    if (this.inFlight.has(lock)) return false;
    this.inFlight.add(lock);
    if (lock !== "create") {
      this.unreconciled.add(lock);
      this.epochs.set(lock, (this.epochs.get(lock) ?? 0) + 1);
    }
    return true;
  }

  end(lock: string) {
    this.inFlight.delete(lock);
  }

  busy(lock: string): boolean {
    return this.inFlight.has(lock);
  }

  /** Writes on this invoice must wait: one is running, or its outcome hasn't been read back yet. */
  locked(id: string): boolean {
    return this.inFlight.has(id) || this.unreconciled.has(id);
  }

  needsReconcile(id: string): boolean {
    return this.unreconciled.has(id) && !this.inFlight.has(id);
  }

  readStarted(id: string): ReadToken {
    return { id, epoch: this.epochs.get(id) ?? 0, clean: !this.inFlight.has(id) };
  }

  /** A read that saw the result of every write on the invoice reconciles it; true when it did. */
  readSucceeded(t: ReadToken, status: string): boolean {
    const reconciled = t.clean && !this.inFlight.has(t.id) && (this.epochs.get(t.id) ?? 0) === t.epoch;
    // only a read that started after the Delete settled proves the invoice survived it
    if (reconciled) {
      this.unreconciled.delete(t.id);
      this.pendingDeletes.delete(t.id);
    }
    if (status !== "draft") this.retireDraft(t.id);
    return reconciled;
  }

  /** A line was added: `saved` goes out once a reconciling read shows it. */
  savedAfterReconcile(id: string) {
    this.savedDue.add(id);
  }

  takeSavedDue(id: string): boolean {
    return this.savedDue.delete(id);
  }

  sendCount(id: string): number {
    return this.sends.get(id) ?? 0;
  }

  sendSucceeded(id: string) {
    this.sends.set(id, this.sendCount(id) + 1);
  }

  deleteStarted(id: string) {
    this.pendingDeletes.add(id);
  }

  /** The invoice is gone (deleted here, or a confirmed not-found). */
  gone(id: string) {
    this.pendingDeletes.delete(id);
    this.unreconciled.delete(id);
    this.retireDraft(id);
  }

  deletePending(id: string): boolean {
    return this.pendingDeletes.has(id);
  }

  recordDraft(payload: string, id: string) {
    this.drafts.set(payload, id);
  }

  draftFor(payload: string): string | undefined {
    return this.drafts.get(payload);
  }

  retireDraft(id: string) {
    for (const [k, v] of this.drafts) if (v === id) this.drafts.delete(k);
  }
}
