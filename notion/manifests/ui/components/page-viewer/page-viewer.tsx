// Notion-native page view/editor over the connector's Page.Get/Update +
// Block.List/Append/Update/Delete actions. Viewing is editing: plain-text
// blocks are contentEditable lines that save on blur (Block.Update, rich_text
// replaced), to-do boxes toggle immediately, hover handles add blocks below or
// delete (host-confirmed), Enter splits/continues into a new block, and "/" in
// a new block picks its type before it is created (Block.Append with `after`).
// Formatted text (links, mentions, annotations) and complex blocks stay
// read-only so nothing is ever flattened. Toggles/nested lists expand lazily;
// layout containers auto-expand. An agent `draft` input shows as a pending
// insertion the user confirms; it's exposed via provideState for refinement.
import { LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button } from "antd";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/notion.css";
import "../../shared/tangram-buttons.css";
import { PageProps, renderRich, SideNav, tocEntries } from "./block-render";
import { BlockRow, continueType, RowApi } from "./block-row";
import { DraftBlock, Editable, focusEnd, NewBlock } from "./editable";
import { PendingDraft } from "./pending-draft";
import {
  AppendFailure,
  appendBlocks,
  Block,
  echoRich,
  errText,
  fetchBlockChildren,
  isPlainRich,
  MAX_BLOCK_PAGES,
  newBlockOf,
  openExternal,
  Page,
  pageTitle,
  parseContent,
  payload,
  remainingContent,
  safeHref,
  spansOf,
  tangram,
  titleProp,
} from "./notion-blocks";

type State =
  | { kind: "init" }
  | { kind: "loading" }
  | { kind: "ready"; page: Page; blocks: Block[]; truncated: boolean }
  | { kind: "error"; message: string };

const act = (resourceType: string, action: string, req: Record<string, unknown>) =>
  tangram.performAction({ resourceType, action }, req);

export default function PageViewer() {
  const [pageId, setPageId] = useState("");
  const [state, setState] = useState<State>({ kind: "init" });
  // Agent-proposed content awaiting the user's confirm (`draft` input).
  const [draft, setDraft] = useState("");
  const [pendingOpen, setPendingOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // The one unsaved new block (slash menu / Enter / + handle).
  const [newBlock, setNewBlock] = useState<NewBlock | null>(null);
  const [deletingId, setDeletingId] = useState("");
  const [blockError, setBlockError] = useState("");
  const [inflight, setInflight] = useState(0);
  const [flash, setFlash] = useState<"" | "saved" | "error">("");
  // Guards stale responses when the target page changes mid-fetch.
  const loadSeq = useRef(0);
  // Current target page, so async saves can tell the page changed under them.
  const pageIdRef = useRef("");
  // Bumped on every page switch; block writes started under an older
  // generation never patch local state (covers A→B→A).
  const pageGenRef = useRef(0);
  // Bumped on every page switch or agent draft replacement; a save that started
  // under an older generation must not clear or replace the editor (covers A→B→A).
  const editorGenRef = useRef(0);
  // Latest Block.Update per block id: only the newest response patches state.
  const updateSeq = useRef(new Map<string, number>());
  const todoInflight = useRef(new Set<string>());
  const nbKey = useRef(0);
  const nbRef = useRef<NewBlock | null>(null);
  nbRef.current = newBlock;

  function load(id: string, quiet = false) {
    if (!id) {
      setState({ kind: "error", message: "No pageId provided." });
      return;
    }
    const seq = ++loadSeq.current;
    if (!quiet) setState({ kind: "loading" });
    Promise.all([
      act("Page", "Get", { parameters: { page_id: id } }) as Promise<Page>,
      fetchBlockChildren(id, MAX_BLOCK_PAGES),
    ])
      .then(([page, { blocks, truncated }]) => {
        if (seq !== loadSeq.current) return;
        setState({ kind: "ready", page, blocks, truncated });
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        if (quiet) setBlockError(`Couldn't refresh the page: ${errText(e)}`);
        else setState({ kind: "error", message: errText(e) });
      });
  }

  useEffect(() => {
    // Track applied values locally (not via state updaters — those must stay
    // side-effect free) so token-renewal replays of the same inputs don't
    // refetch or wipe in-progress edits.
    let lastId = "";
    let lastDraft = "";
    const apply = (inputs: Record<string, unknown>) => {
      const id = String(inputs?.pageId ?? "").trim();
      const pageChanged = id !== "" && id !== lastId;
      if (pageChanged) {
        // New page: drop the previous page's draft and block edits.
        pageIdRef.current = id;
        pageGenRef.current += 1;
        editorGenRef.current += 1;
        setDraft("");
        setPendingOpen(false);
        setNewBlock(null);
        setDeletingId("");
        setSaveError("");
        setBlockError("");
      }
      // Agent-supplied draft: show it as a pending insertion. Dedup per page
      // so a renewal replay can't clobber what the user edited since.
      const agentDraft = String(inputs?.draft ?? "");
      const draftKey = `${id || lastId}\n${agentDraft}`;
      if (draftKey !== lastDraft) {
        lastDraft = draftKey;
        if (agentDraft.trim()) {
          editorGenRef.current += 1;
          setDraft(agentDraft);
          setPendingOpen(true);
          setSaveError("");
        }
      }
      // Inputs arrived without a pageId: surface it instead of spinning forever.
      if (!id) {
        if (!lastId) setState({ kind: "error", message: "No pageId provided." });
        return;
      }
      if (!pageChanged) return;
      lastId = id;
      setPageId(id);
      load(id);
    };
    // getInputs() resolves after the host's init handshake delivers the inputs.
    Promise.resolve(tangram.getInputs()).then((inputs: Record<string, unknown>) =>
      apply(inputs ?? {}),
    );
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, []);

  const ready = state.kind === "ready" ? state : null;
  const title = ready ? pageTitle(ready.page) : "";
  const editable = Boolean(ready && !ready.page.archived && !ready.page.in_trash);

  // Snapshot for the agent's tangram_get_component_state tool: what page is
  // shown and what the user is drafting, so the agent can assist the edit.
  const stateRef = useRef<Record<string, unknown>>({});
  stateRef.current = {
    pageId,
    title,
    mode: pendingOpen ? "edit" : "view",
    ...(pendingOpen ? { draft } : {}),
  };
  useEffect(() => {
    tangram.provideState?.(() => stateRef.current);
  }, []);

  useEffect(() => {
    if (pendingOpen) requestAnimationFrame(() => document.getElementById("n-pending")?.scrollIntoView({ block: "nearest" }));
  }, [pendingOpen, ready !== null]);

  useEffect(() => {
    if (flash !== "saved") return;
    const t = setTimeout(() => setFlash(""), 1800);
    return () => clearTimeout(t);
  }, [flash, inflight]);

  // Wraps a write so the quiet "Saving…/Saved" indicator tracks it.
  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    setInflight((n) => n + 1);
    setFlash("");
    try {
      const r = await fn();
      setFlash("saved");
      return r;
    } catch (e) {
      setFlash("error");
      throw e;
    } finally {
      setInflight((n) => n - 1);
    }
  }

  const guard = () => {
    const target = pageIdRef.current;
    const gen = pageGenRef.current;
    return { target, stale: () => pageIdRef.current !== target || pageGenRef.current !== gen };
  };

  function patchBlocks(fn: (blocks: Block[], truncated: boolean) => Block[]) {
    setState((s) => (s.kind === "ready" ? { ...s, blocks: fn(s.blocks, s.truncated) } : s));
  }
  const patchBlock = (id: string, fn: (b: Block) => Block) =>
    patchBlocks((bs) => bs.map((b) => (b.id === id ? fn(b) : b)));

  async function saveDraft() {
    if (!draft.trim() || !pageId || saving) return;
    setSaving(true);
    setSaveError("");
    const parsed = parseContent(draft);
    const target = pageId;
    const gen = editorGenRef.current;
    try {
      await tracked(() => appendBlocks(target, parsed.map((p) => p.block)));
      if (pageIdRef.current !== target || editorGenRef.current !== gen) return;
      setDraft("");
      setPendingOpen(false);
      load(target, true);
    } catch (e) {
      if (pageIdRef.current !== target || editorGenRef.current !== gen) return;
      if (e instanceof AppendFailure && e.appendedBlocks > 0) {
        setDraft(remainingContent(draft, parsed, e.appendedBlocks));
        setSaveError(`Partially appended; the draft keeps only the unwritten lines. ${e.message}`);
        load(target, true);
      } else {
        setSaveError(errText(e));
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveText(block: Block, text: string) {
    const g = guard();
    const seq = (updateSeq.current.get(block.id) ?? 0) + 1;
    updateSeq.current.set(block.id, seq);
    const latest = () => updateSeq.current.get(block.id) === seq;
    try {
      const updated: Block = await tracked(() =>
        act("Block", "Update", {
          parameters: { block_id: block.id },
          requestBody: { [block.type]: { rich_text: spansOf(text) } },
        }),
      );
      if (g.stale() || !latest()) return;
      // Patch only rich_text so a concurrent to-do toggle can't be undone.
      const rich = updated?.type === block.type ? payload(updated).rich_text : undefined;
      patchBlock(block.id, (b) => ({ ...b, [b.type]: { ...payload(b), rich_text: rich ?? echoRich(text) } }));
    } catch (e) {
      if (g.stale() || !latest()) return;
      // The typed text stays in the line; the next blur retries.
      setBlockError(`Couldn't save a block: ${errText(e)} — your text is kept; click in and out of it to retry.`);
    }
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

  function openDraft(after: string, type: string, initial: string): boolean {
    if (nbRef.current?.busy) return false;
    setNewBlock({ key: ++nbKey.current, after, type, initial, busy: false });
    return true;
  }

  async function createBlock(nb: NewBlock, text: string, opts: { next: boolean; type?: string }) {
    const type = opts.type ?? nb.type;
    setNewBlock((cur) => (cur?.key === nb.key ? { ...cur, type, initial: type === "divider" ? "" : text, busy: true } : cur));
    const g = guard();
    try {
      const res: { results?: Block[] } = await tracked(() =>
        act("Block", "Append", {
          parameters: { block_id: g.target },
          requestBody: { children: [newBlockOf(type, text)], ...(nb.after ? { after: nb.after } : {}) },
        }),
      );
      if (g.stale()) return;
      const r = res?.results;
      const created = r?.length === 1 && r[0]?.id && r[0].type === type ? r[0] : undefined;
      if (created) {
        patchBlocks((bs, truncated) => {
          if (!nb.after) return truncated ? bs : [...bs, created];
          const i = bs.findIndex((b) => b.id === nb.after);
          return i < 0 ? bs : [...bs.slice(0, i + 1), created, ...bs.slice(i + 1)];
        });
      } else {
        load(g.target, true);
      }
      setNewBlock((cur) =>
        cur?.key !== nb.key
          ? cur
          : opts.next && created
            ? { key: ++nbKey.current, after: created.id, type: continueType(type), initial: "", busy: false }
            : null,
      );
    } catch (e) {
      if (g.stale()) return;
      setNewBlock((cur) => (cur?.key === nb.key ? { ...cur, busy: false } : cur));
      setBlockError(`Couldn't add the block: ${errText(e)}`);
    }
  }

  async function removeBlock(block: Block) {
    if (deletingId) return;
    setDeletingId(block.id);
    setBlockError("");
    const g = guard();
    try {
      // Block.Delete is confirmation-gated by its resource action policy; the
      // trusted host prompts outside the sandbox before execution resumes.
      await tracked(() => act("Block", "Delete", { parameters: { block_id: block.id } }));
      if (g.stale()) return;
      patchBlocks((bs) => bs.filter((b) => b.id !== block.id));
      setNewBlock((cur) => (cur && cur.after === block.id && !cur.busy ? null : cur));
    } catch (e) {
      if (!g.stale()) setBlockError(errText(e));
    } finally {
      if (!g.stale()) setDeletingId("");
    }
  }

  async function saveTitle(text: string) {
    const page = ready?.page;
    const tp = page ? titleProp(page) : null;
    if (!page || !tp || !isPlainRich(tp.rich) || text === pageTitle(page)) return;
    const g = guard();
    try {
      await tracked(() =>
        act("Page", "Update", {
          parameters: { page_id: g.target },
          requestBody: { properties: { [tp.key]: { title: spansOf(text) } } },
        }),
      );
      if (g.stale()) return;
      setState((s) => {
        if (s.kind !== "ready") return s;
        const props = s.page.properties ?? {};
        return { ...s, page: { ...s.page, properties: { ...props, [tp.key]: { ...props[tp.key], title: echoRich(text) } } } };
      });
    } catch (e) {
      if (!g.stale()) setBlockError(`Couldn't rename the page: ${errText(e)}`);
    }
  }

  const api: RowApi = { editable, deletingId, saveText, toggleTodo, openDraft, remove: removeBlock };

  function draftNode(nb: NewBlock, prevType: string, prevOrdinal: number) {
    const ordinal = nb.type !== "numbered_list_item" ? 0 : prevType === "numbered_list_item" ? prevOrdinal + 1 : 1;
    return (
      <DraftBlock
        key={`nb-${nb.key}`}
        nb={nb}
        ordinal={ordinal}
        onType={(type, text) =>
          setNewBlock((cur) => (cur?.key === nb.key ? { ...cur, type, initial: text } : cur))
        }
        onCreate={(text, opts) => createBlock(nb, text, opts)}
        onDrop={(focusPrev) => {
          setNewBlock((cur) => (cur?.key === nb.key ? null : cur));
          if (!focusPrev) return;
          const prevId = nb.after || ready?.blocks[ready.blocks.length - 1]?.id;
          const el = prevId ? document.querySelector<HTMLElement>(`#blk-${CSS.escape(prevId)} [contenteditable="true"], #blk-${CSS.escape(prevId)} [contenteditable="plaintext-only"]`) : null;
          focusEnd(el);
        }}
      />
    );
  }

  function body(r: NonNullable<typeof ready>) {
    const rows: React.ReactNode[] = [];
    let n = 0;
    let placed = false;
    let prevType = "";
    for (const b of r.blocks) {
      const ordinal = b.type === "numbered_list_item" ? ++n : (n = 0);
      rows.push(<BlockRow key={b.id} block={b} ordinal={ordinal} api={api} />);
      if (newBlock && newBlock.after === b.id) {
        rows.push(draftNode(newBlock, b.type, ordinal));
        placed = true;
      }
      prevType = b.type;
    }
    if (newBlock && !placed) rows.push(draftNode(newBlock, prevType, n));
    return rows;
  }

  const pageUrl = safeHref(ready?.page.url);
  const icon = ready?.page.icon?.type === "emoji" ? ready.page.icon.emoji : "";
  const tp = ready ? titleProp(ready.page) : null;
  const titleEditable = editable && Boolean(tp) && isPlainRich(tp?.rich);
  const status = inflight > 0 ? "Saving…" : flash === "saved" ? "Saved" : flash === "error" ? "Not saved" : "";

  return (
    <div className="n-root">
      <div className="n-topbar">
        <span className="crumb">
          {icon ? `${icon} ` : ""}
          {title || (ready ? "Untitled" : "Page")}
        </span>
        {status ? <span className={`n-saving${flash === "error" && !inflight ? " err" : ""}`}>{status}</span> : null}
        {pageUrl ? (
          <Button size="small" type="text" icon={<LinkOutlined />} href={pageUrl} onClick={(e) => { e.preventDefault(); openExternal(pageUrl); }}>
            Open in Notion
          </Button>
        ) : null}
        <Button
          size="small"
          type="text"
          icon={<ReloadOutlined />}
          title="Refresh"
          disabled={state.kind === "loading" || !pageId}
          onClick={() => load(pageId)}
        />
      </div>
      <div className="n-page">
        {state.kind === "loading" || state.kind === "init" ? <div className="n-note">Loading…</div> : null}
        {state.kind === "error" ? <div className="n-error">{state.message}</div> : null}
        {ready ? (
          <>
            {ready.page.archived || ready.page.in_trash ? (
              <div className="n-error">This page is in the trash — read-only.</div>
            ) : null}
            {icon ? <div className="n-icon">{icon}</div> : null}
            {titleEditable ? (
              <Editable className="n-title" text={title} placeholder="Untitled" onCommit={saveTitle} />
            ) : (
              <h1 className="n-title">{renderRich(tp?.rich, "title")}</h1>
            )}
            <PageProps page={ready.page} />
            <SideNav entries={tocEntries(ready.blocks)} />
            {blockError ? (
              <div className="n-error">
                <span>{blockError}</span>
                <button type="button" className="x" title="Dismiss" onClick={() => setBlockError("")}>
                  ×
                </button>
              </div>
            ) : null}
            <div style={{ wordBreak: "break-word" }}>{body(ready)}</div>
            {ready.truncated ? (
              <div className="n-note">Content truncated — open the page in Notion to see the rest.</div>
            ) : null}
            {editable && !(newBlock && !newBlock.after) ? (
              <div className="n-addline" onClick={() => openDraft("", "paragraph", "")}>
                + Click to add a block
              </div>
            ) : null}
            {pendingOpen && editable ? (
              <PendingDraft
                draft={draft}
                setDraft={setDraft}
                saving={saving}
                error={saveError}
                onAppend={saveDraft}
                onDiscard={() => {
                  setDraft("");
                  setPendingOpen(false);
                  setSaveError("");
                }}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
