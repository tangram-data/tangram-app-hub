import { WriteQueue, Writer } from "../manifests/ui/components/page-viewer/write-queue";
import assert from "node:assert/strict";
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
// Fake server: each send waits for manual resolve/reject; done/errors are logged.
function fake(log: string[], tag = "") {
  const waits: { v: string; ok: () => void; fail: () => void }[] = [];
  const done: string[] = []; const errs: string[] = [];
  const w = (): Writer => ({
    send: (v) => new Promise<unknown>((ok, no) => { log.push(tag + v); waits.push({ v, ok: () => ok({ v }), fail: () => no(new Error("x")) }); }),
    onDone: (v) => done.push(v),
    onError: () => errs.push(tag || "err"),
  });
  return { w, waits, done, errs };
}

async function identicalBlur() {
  const q = new WriteQueue(); const log: string[] = []; const f = fake(log);
  q.submit("k", "A", "O", f.w());                    // in flight A
  q.submit("k", "B", "O", f.w());                    // queued B
  q.submit("k", "B", "O", f.w());                    // identical blur: keep B
  assert.equal(q.pending("k"), "B");
  f.waits[0].ok(); await tick();
  assert.deepEqual(log, ["A", "B"]);
  f.waits[1].ok(); await tick();
  q.submit("k", "B", "B", f.w());                    // nothing queued, equals last sent
  assert.deepEqual(log, ["A", "B"]);
  assert.deepEqual(f.done, ["A", "B"]);
}
async function revertWhilePending() {
  const q = new WriteQueue(); const log: string[] = []; const f = fake(log);
  q.submit("k", "X", "O", f.w());                    // in flight X
  q.submit("k", "O", "O", f.w());                    // revert: must send O after X
  assert.equal(q.pending("k"), "O");
  f.waits[0].ok(); await tick();
  assert.deepEqual(log, ["X", "O"]);
  f.waits[1].ok(); await tick();
}
async function holdRelease() {
  const q = new WriteQueue(); const log: string[] = []; const f = fake(log);
  q.hold("k", "full", "head", f.w(), 1);
  q.submit("k", "head2", "full", f.w());             // later typing while held
  await tick(); assert.deepEqual(log, []);
  q.release("k"); await tick();
  assert.deepEqual(log, ["head2"]);
  f.waits[0].ok(); await tick();
  // hold with value equal to latest still queues and dedupes in pump.
  const q2 = new WriteQueue(); const log2: string[] = []; const f2 = fake(log2);
  q2.submit("k", "X", "O", f2.w());                  // in flight X
  q2.submit("k", "Y", "O", f2.w());                  // queued Y
  q2.hold("k", "O", "X", f2.w(), 2);                 // split head == latest: replaces Y
  assert.equal(q2.pending("k"), "X");
  f2.waits[0].ok(); await tick(); q2.release("k"); await tick();
  assert.deepEqual(log2, ["X"]);                     // X confirmed: no resend, Y never sent
}
async function splitFailureNewerEdit() {
  const q = new WriteQueue(); const log: string[] = []; const f = fake(log);
  q.hold("k", "full", "head", f.w(), 7);
  q.submit("k", "full+edit", "full", f.w());         // newer visit's edit
  assert.equal(q.dropIf("k", 7), false);             // not ours: kept
  q.release("k"); await tick();
  assert.deepEqual(log, ["full+edit"]);
  f.waits[0].ok(); await tick();
  const q2 = new WriteQueue(); const log2: string[] = []; const f2 = fake(log2);
  q2.hold("k", "full", "head", f2.w(), 8);
  assert.equal(q2.dropIf("k", 8), true);             // ours: rolled back
  q2.release("k"); await tick();
  assert.deepEqual(log2, []);
}
async function abaCallbacks() {
  const q = new WriteQueue(); const log: string[] = [];
  const old = fake(log, "old:"); const cur = fake(log, "new:");
  q.submit("A:b", "v1", "O", old.w());               // visit 1 in flight
  q.submit("A:b", "v2", "O", cur.w());               // visit 3 edit
  old.waits[0].ok(); await tick();
  assert.deepEqual(log, ["old:v1", "new:v2"]);
  cur.waits[0].fail(); await tick();
  assert.deepEqual(cur.errs, ["new:"]); assert.deepEqual(old.errs, []);
  q.submit("A:b", "v3", "O", cur.w());               // in flight
  q.submit("A:b", "v4", "O", old.w());               // queued with old callbacks
  q.submit("A:b", "v4", "O", cur.w());               // identical: callbacks refreshed
  cur.waits[1].ok(); await tick();
  assert.deepEqual(log.slice(-2), ["new:v3", "new:v4"]);
}
// Round 4 #1: identical resubmission clears the split token.
async function identicalClearsToken() {
  const q = new WriteQueue(); const log: string[] = []; const f = fake(log);
  q.hold("k", "full", "head", f.w(), 9);             // old visit's split
  q.submit("k", "head", "full", f.w());              // new visit types the same text
  assert.equal(q.dropIf("k", 9), false);             // old split failure can't delete it
  assert.equal(q.pending("k"), "head");
  q.release("k"); await tick();
  assert.deepEqual(log, ["head"]);
}
// Round 4 #2: a deduped value still completes with the newer visit's callbacks.
async function dedupStillCompletes() {
  const q = new WriteQueue(); const log: string[] = [];
  const old = fake(log, "old:"); const cur = fake(log, "new:");
  q.submit("A:b", "X", "O", old.w());                // old visit's write in flight
  q.submit("A:b", "Y", "O", cur.w());                // new visit edits to Y...
  q.submit("A:b", "X", "O", cur.w());                // ...then back to X (queued X)
  old.waits[0].ok(); await tick();
  assert.deepEqual(log, ["old:X"]);                  // X not resent
  assert.deepEqual(old.done, ["X"]);
  assert.deepEqual(cur.done, ["X"]);                 // but the new visit is completed
}
// Round 5: identical resubmission while that value is IN FLIGHT completes the
// current visit on success and retries with its callbacks on failure.
async function identicalWhileInflight() {
  const q = new WriteQueue(); const log: string[] = [];
  const old = fake(log, "old:"); const cur = fake(log, "new:");
  q.submit("A:b", "X", "O", old.w());                // old visit's X in flight
  q.submit("A:b", "X", "O", cur.w());                // new visit blurs with X
  assert.equal(q.pending("A:b"), "X");
  old.waits[0].ok(); await tick();
  assert.deepEqual(log, ["old:X"]);                  // not resent
  assert.deepEqual(cur.done, ["X"]);                 // current visit completed
  const q2 = new WriteQueue(); const log2: string[] = [];
  const old2 = fake(log2, "old:"); const cur2 = fake(log2, "new:");
  q2.submit("A:b", "X", "O", old2.w());
  q2.submit("A:b", "X", "O", cur2.w());
  old2.waits[0].fail(); await tick();
  assert.deepEqual(old2.errs, ["old:"]);
  assert.deepEqual(log2, ["old:X", "new:X"]);        // retried with current callbacks
  cur2.waits[0].ok(); await tick();
  assert.deepEqual(cur2.done, ["X"]);
}

(async () => {
  for (const t of [identicalBlur, revertWhilePending, holdRelease, splitFailureNewerEdit, abaCallbacks, identicalClearsToken, dedupStillCompletes, identicalWhileInflight]) {
    await t(); console.log("ok", t.name);
  }
})().catch((e) => { console.error(e); process.exit(1); });
