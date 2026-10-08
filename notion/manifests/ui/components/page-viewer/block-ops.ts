// Block write operations for the page viewer: serialized text saves, to-do
// toggles, new-block creation, and the coordinated Enter-split. Pure functions
// over the viewer's state setters/refs (passed in as `ctx`).
import { MutableRefObject } from "react";
import { continueType } from "./block-row";
import { editableIn, focusEnd, focusStart, NewBlock } from "./editable";
import { Block, echoRich, errText, newBlockOf, payload, plainText, spansOf } from "./notion-blocks";
import { WriteQueue, writeKey, Writer } from "./write-queue";

export type Guard = { target: string; stale: () => boolean };

export type OpsCtx = {
  act: (resourceType: string, action: string, req: Record<string, unknown>) => Promise<any>;
  tracked: <T>(fn: () => Promise<T>) => Promise<T>;
  guard: () => Guard;
  patchBlocks: (fn: (blocks: Block[], truncated: boolean) => Block[]) => void;
  patchBlock: (id: string, fn: (b: Block) => Block) => void;
  setBlockError: (msg: string) => void;
  setNewBlock: (fn: (cur: NewBlock | null) => NewBlock | null) => void;
  load: (id: string, quiet?: boolean) => void;
  writes: MutableRefObject<WriteQueue>;
  // Live text of the unsaved new block (decides whether it may be replaced).
  draftText: MutableRefObject<string>;
  todoInflight: MutableRefObject<Set<string>>;
  nbKey: MutableRefObject<number>;
  nbRef: MutableRefObject<NewBlock | null>;
};

// Tags each split's queued head so a failed split rolls back only its own value.
let splitToken = 0;

export function blockOps(ctx: OpsCtx) {
  const { act, tracked, guard, patchBlocks, patchBlock, setBlockError, load, writes, draftText, todoInflight, nbKey, nbRef } = ctx;
  const setNewBlock = (v: NewBlock | null | ((cur: NewBlock | null) => NewBlock | null)) =>
    ctx.setNewBlock(typeof v === "function" ? v : () => v);

  // Block.Update for one block's text as a queue writer: a completed value
  // patches rich_text only when no different edit is still queued.
  function textWriter(block: Block, g: Guard, q: WriteQueue, onError?: (e: unknown) => void): Writer {
    return {
      send: (v) =>
        tracked(() =>
          act("Block", "Update", {
            parameters: { block_id: block.id },
            requestBody: { [block.type]: { rich_text: spansOf(v) } },
          }),
        ),
      onDone: (v, result) => {
        const queued = q.pending(writeKey(g.target, block.id));
        if (g.stale() || (queued !== undefined && queued !== v)) return;
        // Patch only rich_text so a concurrent to-do toggle can't be undone.
        const updated = result as Block | undefined;
        const rich = updated?.type === block.type ? payload(updated).rich_text : undefined;
        patchBlock(block.id, (b) => ({ ...b, [b.type]: { ...payload(b), rich_text: rich ?? echoRich(v) } }));
      },
      onError:
        onError ??
        ((e) => {
          // The typed text stays in the line; the next blur retries.
          if (!g.stale()) setBlockError(`Couldn't save a block: ${errText(e)} — your text is kept; click in and out of it to retry.`);
        }),
    };
  }

  // Serialized per block: one Update in flight, the latest edit sent next.
  function saveText(block: Block, text: string) {
    const g = guard();
    const q = writes.current;
    q.submit(writeKey(g.target, block.id), text, plainText(block), textWriter(block, g, q));
  }

  async function toggleTodo(block: Block) {
    if (todoInflight.current.has(block.id)) return;
    todoInflight.current.add(block.id);
    const g = guard();
    const next = !payload(block).checked;
    const setChecked = (v: boolean) => patchBlock(block.id, (b) => ({ ...b, to_do: { ...payload(b), checked: v } }));
    setChecked(next);
    try {
      await tracked(() =>
        act("Block", "Update", { parameters: { block_id: block.id }, requestBody: { to_do: { checked: next } } }),
      );
    } catch (e) {
      if (g.stale()) return;
      setChecked(!next);
      setBlockError(`Couldn't update the to-do: ${errText(e)}`);
    } finally {
      todoInflight.current.delete(block.id);
    }
  }

  // One new block at a time: a busy one, or one holding text (failed append,
  // slash-menu filter), keeps focus instead of being replaced.
  function draftBlocked(): boolean {
    const cur = nbRef.current;
    if (!cur || (!cur.busy && !draftText.current.trim())) return false;
    focusEnd(editableIn("[data-draft]"));
    return true;
  }

  function openDraft(after: string, type: string, initial: string): boolean {
    if (draftBlocked()) return false;
    draftText.current = initial;
    setNewBlock({ key: ++nbKey.current, after, type, initial, busy: false });
    return true;
  }

  const singleCreated = (res: { results?: Block[] } | undefined, type: string) => {
    const r = res?.results;
    return r?.length === 1 && r[0]?.id && r[0].type === type ? r[0] : undefined;
  };

  function insertLocal(after: string, created: Block) {
    patchBlocks((bs, truncated) => {
      if (!after) return truncated ? bs : [...bs, created];
      const i = bs.findIndex((b) => b.id === after);
      return i < 0 ? bs : [...bs.slice(0, i + 1), created, ...bs.slice(i + 1)];
    });
  }

  async function createBlock(nb: NewBlock, text: string, opts: { next: boolean; type?: string; tail?: string }) {
    const type = opts.type ?? nb.type;
    const tail = opts.tail ?? "";
    setNewBlock((cur) => (cur?.key === nb.key ? { ...cur, type, initial: type === "divider" ? "" : cur.initial, busy: true } : cur));
    const g = guard();
    try {
      const res: { results?: Block[] } = await tracked(() =>
        act("Block", "Append", {
          parameters: { block_id: g.target },
          requestBody: { children: [newBlockOf(type, text)], ...(nb.after ? { after: nb.after } : {}) },
        }),
      );
      if (g.stale()) return;
      const created = singleCreated(res, type);
      if (created) insertLocal(nb.after, created);
      else load(g.target, true);
      const nextType = continueType(type);
      // Enter mid-text: the tail starts the successor; without the created id
      // it can only wait at the end of the page.
      const successor: NewBlock | null =
        opts.next && created
          ? { key: ++nbKey.current, after: created.id, type: nextType, initial: tail, busy: false }
          : tail
            ? { key: ++nbKey.current, after: "", type: nextType, initial: tail, busy: false }
            : null;
      draftText.current = successor?.initial ?? "";
      setNewBlock((cur) => (cur?.key !== nb.key ? cur : successor));
    } catch (e) {
      if (g.stale()) return;
      setNewBlock((cur) => (cur?.key === nb.key ? { ...cur, busy: false } : cur));
      setBlockError(`Couldn't add the block: ${errText(e)}`);
    }
  }

  // Enter mid-block on an existing line. The tail is appended FIRST (after
  // the original); only then does the head shrink, through the block's write
  // queue (held meanwhile so the head's blur can't save early). The server
  // writes finish even if the page switches; only local patches are guarded.
  function splitBlock(block: Block, before: string, after: string): boolean {
    if (draftBlocked()) return false;
    const g = guard();
    const q = writes.current;
    const headWriter = textWriter(block, g, q, (e) => {
      if (!g.stale()) setBlockError(`Split saved the new block, but shortening the original failed: ${errText(e)} — click in and out of it to retry.`);
    });
    const key = writeKey(g.target, block.id);
    const token = ++splitToken;
    // Queue the shortened head now (held until the tail lands); later edits
    // to the head are simply newer queued values on the same key.
    q.hold(key, plainText(block), before, headWriter, token);
    const type = continueType(block.type);
    const nb: NewBlock = { key: ++nbKey.current, after: block.id, type, initial: after, busy: true };
    draftText.current = after;
    setNewBlock(nb);
    void (async () => {
      let res: { results?: Block[] } | undefined;
      try {
        res = await tracked(() =>
          act("Block", "Append", {
            parameters: { block_id: g.target },
            requestBody: { children: [newBlockOf(type, after)], after: block.id },
          }),
        );
      } catch (e) {
        if (g.stale()) {
          // Visit gone: undo only our own shrink; a newer visit's edit stays.
          q.dropIf(key, token);
          q.release(key);
          return;
        }
        // Same visit: the tail goes back onto the head line, and that text
        // replaces whatever is queued (equal to the server text → no write).
        const head = editableIn(`#blk-${CSS.escape(block.id)}`);
        if (head) {
          const restored = (head.textContent ?? "") + after;
          head.textContent = restored;
          q.submit(key, restored, plainText(block), textWriter(block, g, q));
        } else {
          q.dropIf(key, token);
        }
        q.release(key);
        draftText.current = "";
        setNewBlock((cur) => (cur?.key === nb.key ? null : cur));
        setBlockError(`Couldn't split the block: ${errText(e)}`);
        return;
      }
      // Tail landed: send the head's latest queued value.
      q.release(key);
      if (g.stale()) return;
      const created = singleCreated(res, type);
      if (created) insertLocal(block.id, created);
      else load(g.target, true);
      draftText.current = "";
      setNewBlock((cur) => (cur?.key === nb.key ? null : cur));
      if (created) requestAnimationFrame(() => focusStart(editableIn(`#blk-${CSS.escape(created.id)}`)));
    })();
    return true;
  }

  return { saveText, toggleTodo, openDraft, createBlock, splitBlock };
}
