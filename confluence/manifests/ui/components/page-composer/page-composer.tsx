// Confluence page composer, markdown-style drafts with a live preview (draft-preview.tsx):
//   - new page: the draft becomes the page (Page.Create into a chosen space, optionally under a parent);
//   - existing page, "Append section" (default): the draft is converted and appended to the page's storage body,
//     which is sent back byte-for-byte — nothing already on the page can be lost;
//   - existing page, "Edit whole page": offered only when the page round-trips through the draft without loss; an
//     unedited body is still sent back unchanged.
// Writes are confirmation-gated by the host. Uncertain creates are reconciled (composer-io titledPages snapshot),
// version conflicts reload the latest page and need an explicit re-save, identical inputs are ignored. The draft
// (with mode) is readable via provideState; a successful save emits `saved` {pageId, title, url}.
import { Button, Skeleton } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/atlassian.css";
import "../../shared/tangram-buttons.css";
import { definiteFailure, sameText, stableJson } from "../../shared/write-outcome";
import { CreateAttempt, Page, errText, findCreatedPage, getPage, openExternal, pageUrl, storedPage, titledPages } from "./composer-io";
import { SpacePicker } from "./space-picker";
import { ModeBar, Status, StatusBanners, reloadedNotice } from "./composer-banners";
import { DraftPreview } from "./draft-preview";
import { draftToStorage, sameStorage, storageToDraft } from "./storage-draft";
import { UpdateAttempt, isOurSave, reconcile, retryBody } from "./update-attempt";

const tangram = (window as any).tangram;

type Mode = "create" | "append" | "whole";
const SYNTAX = "# Heading   - bullet   1. step   > quote   ``` code";

export default function PageComposer() {
  const [mode, setMode] = useState<Mode>("create");
  const [spaceId, setSpaceId] = useState("");
  const [parentId, setParentId] = useState("");
  const [pageId, setPageId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(""); // the whole page (create / whole)
  const [section, setSection] = useState(""); // the appended part (append)
  const [version, setVersion] = useState(0);
  const [lossy, setLossy] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  // The page as loaded: storage is what gets sent back untouched (append, or an unedited whole body).
  const original = useRef({ storage: "", draft: "", title: "", version: 0, lossy: [] as string[] });
  // The baseline storage the whole-page draft (`body`) was derived from; a newer baseline makes it stale.
  const bodyBase = useRef("");
  // Input generation: recovery state belongs to one generation and is dropped when the inputs change.
  const gen = useRef(0);
  // An update whose response was lost (immutable, update-attempt.ts) and the latest page read while reconciling it.
  const attempt = useRef<UpdateAttempt | null>(null);
  const latest = useRef<Page | null>(null);
  const [pickSpace, setPickSpace] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const seq = useRef(0);
  const inputsRef = useRef<Record<string, unknown>>({});
  const createAttempt = useRef<CreateAttempt>({ spaceId: "", parentId: "", title: "", value: "", before: new Set<string>() });
  // Set when a save landed but its page couldn't be re-read: Retry then only re-reads the stored page.
  const rereadOnly = useRef(false);
  const stateRef = useRef({});
  stateRef.current = { mode, spaceId, parentId, pageId, title, body, section };

  const adopt = (p: Page) => {
    const storage = p.body?.storage?.value ?? "";
    const conv = storageToDraft(storage);
    original.current = { storage, draft: conv.draft, title: p.title ?? "", version: p.version?.number ?? 0, lossy: conv.lossy };
    setVersion(p.version?.number ?? 0);
    setLossy(conv.lossy);
    // Only the generation that asked may set the link (inputs can switch pages mid-lookup).
    const g = gen.current;
    pageUrl(p).then(
      (u) => g === gen.current && setUrl(u),
      () => g === gen.current && setUrl(""),
    );
    return conv;
  };

  const loadPage = useCallback((id: string, inputs: Record<string, unknown>) => {
    const s = ++seq.current;
    setLoaded(false);
    setStatus({ kind: "loading" });
    getPage(id)
      .then((p) => {
        if (s !== seq.current) return;
        const conv = adopt(p);
        setSpaceId(p.spaceId ?? "");
        // Inputs that are present (even empty) win over the page's values.
        if (inputs.title == null) setTitle(p.title ?? "");
        // Whole-page editing only when nothing would be lost; otherwise the body input becomes the appended section.
        const whole = inputs.append === false && conv.lossy.length === 0;
        setMode(whole ? "whole" : "append");
        if (whole) setBody(inputs.body == null ? conv.draft : String(inputs.body));
        else setSection(inputs.body == null ? "" : String(inputs.body));
        bodyBase.current = whole ? original.current.storage : "";
        setLoaded(true);
        setStatus({ kind: "idle" });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "error", message: errText(e) }));
  }, []);

  useEffect(() => {
    tangram.provideState?.(() => ({ ...stateRef.current }));
    const apply = (inputs: Record<string, unknown>) => {
      inputsRef.current = inputs;
      gen.current++;
      attempt.current = null;
      latest.current = null;
      rereadOnly.current = false;
      const id = String(inputs?.pageId ?? "");
      setPageId(id);
      setMode(id ? "append" : "create");
      setSpaceId(String(inputs?.spaceId ?? ""));
      setPickSpace(!id && !inputs?.spaceId);
      setParentId(String(inputs?.parentId ?? ""));
      setTitle(String(inputs?.title ?? ""));
      setBody(id ? "" : String(inputs?.body ?? ""));
      setSection("");
      setLossy([]);
      setVersion(0);
      setUrl("");
      original.current = { storage: "", draft: "", title: "", version: 0, lossy: [] };
      if (id) loadPage(id, inputs);
      else {
        ++seq.current;
        setLoaded(false);
        setStatus({ kind: "idle" });
      }
    };
    // Token renewal re-sends init with identical inputs: only real input changes reset the component.
    let last: string | null = null;
    tangram.onInput((inputs: Record<string, unknown>) => {
      const key = stableJson(inputs ?? {});
      if (key === last) return;
      last = key;
      apply(inputs ?? {});
    });
  }, [loadPage]);

  const editing = mode !== "create";
  const busy = status.kind === "busy" || status.kind === "loading";
  const roundTrips = loaded && lossy.length === 0;
  const wholeEdited = mode === "whole" && body !== original.current.draft;

  function outgoing(): string {
    if (mode === "create") return draftToStorage(body);
    if (mode === "append") return section.trim() ? original.current.storage + draftToStorage(section) : original.current.storage;
    return wholeEdited ? draftToStorage(body) : original.current.storage;
  }

  // Whole-page saves are refused while the baseline holds formatting markdown can't keep.
  const wholeBlocked = mode === "whole" && lossy.length > 0;

  // A write that is known to have landed (directly, or found by reconciliation) becomes the new baseline.
  // `draft` is the markdown that produced `value` (the baseline for further whole-page edits).
  function landed(p: Page, value: string, link: string, draft: string, notice?: string) {
    const saved = { ...p, body: { storage: { value } }, title: p.title ?? title.trim() };
    adopt(saved);
    if (mode !== "append") {
      original.current.draft = draft;
      bodyBase.current = value;
    }
    if (mode === "create" && p.id) {
      // A new page was written from markdown: keep editing it as a whole.
      setPageId(p.id);
      setMode("whole");
    }
    if (mode === "append") setSection("");
    setLoaded(true);
    setStatus(notice ? { kind: "error", message: notice } : { kind: "saved", title: saved.title, url: link });
    tangram.emit("saved", { pageId: p.id, title: saved.title, url: link });
  }

  // After an update with no answer: judge the re-read page against the captured attempt only (update-attempt.ts).
  // Every await is followed by a generation/attempt check before any state is touched.
  function checkUpdate(s: number) {
    const a = attempt.current;
    if (!a) return;
    const current = () => s === seq.current && a === attempt.current && a.gen === gen.current;
    setStatus({ kind: "busy" });
    reconcile(a)
      .then(async ({ outcome, page }) => {
        if (!current()) return;
        latest.current = page;
        if (outcome === "unchanged") {
          attempt.current = null;
          setStatus({ kind: "error", message: "The page wasn't changed — it's safe to save again." });
        } else if (outcome === "unknown") {
          setStatus({ kind: "unsure", message: `The page is now v${page.version?.number ?? "?"} but doesn't show your change.` });
        } else {
          const link = await pageUrl(page);
          if (!current()) return;
          attempt.current = null;
          landed(page, page.body?.storage?.value ?? "", link, a.draft);
        }
      })
      .catch((e: unknown) => current() && setStatus({ kind: "unsure", message: `Couldn't check: ${errText(e)}` }));
  }

  // "Again anyway": the latest page becomes the baseline first (lossy recomputed from it right away); a whole-page
  // retry onto a page markdown can't keep is refused; then the attempt's intent is re-sent on top of it.
  function updateAgain() {
    const a = attempt.current;
    const p = latest.current;
    if (!a || !p || a.gen !== gen.current || p.id !== a.pageId) return checkUpdate(seq.current);
    const conv = adopt(p);
    attempt.current = null;
    if (a.mode === "whole" && conv.lossy.length) {
      setStatus({ kind: "error", message: `The page now has ${conv.lossy.join(", ")} that markdown can't keep — append instead, or edit in Confluence.` });
      return;
    }
    // A title-only retry carries the latest body: show it, and make it the draft's baseline.
    const draftNow = a.mode === "whole" && !a.bodyEdited ? conv.draft : body;
    if (draftNow !== body) setBody(draftNow);
    if (a.mode === "whole") bodyBase.current = original.current.storage;
    save({
      value: retryBody(a, original.current.storage, draftToStorage(section), draftToStorage(draftNow)),
      draft: draftNow,
      bodyEdited: a.bodyEdited, // the original intent survives retries
    });
  }

  // `retry`: an explicit body (and its draft and intent) from "again anyway", instead of the current editor state.
  async function save(retry?: { value: string; draft: string; bodyEdited: boolean }) {
    const s = seq.current;
    // Checked against the baseline ref, so it holds even right after a baseline change.
    if (mode === "whole" && original.current.lossy.length) return;
    const value = retry?.value ?? outgoing();
    const sentDraft = retry?.draft ?? body;
    const sentEdited = retry?.bodyEdited ?? wholeEdited;
    setStatus({ kind: "busy" });
    let before = new Set<string>();
    if (!editing) {
      try {
        before = new Set((await titledPages(spaceId, title.trim())).map((p) => p.id));
      } catch (e) {
        if (s === seq.current) setStatus({ kind: "error", message: `Couldn't check the space before creating: ${errText(e)}` });
        return;
      }
      if (s !== seq.current) return;
    }
    const call = editing
      ? tangram.performAction({ resourceType: "Page", action: "Update" }, {
          parameters: { id: pageId },
          requestBody: { id: pageId, status: "current", title: title.trim(), body: { representation: "storage", value }, version: { number: original.current.version + 1 } },
        })
      : tangram.performAction({ resourceType: "Page", action: "Create" }, {
          requestBody: { spaceId, status: "current", title: title.trim(), ...(parentId ? { parentId } : {}), body: { representation: "storage", value } },
        });
    call
      .then(async (p: Page) => {
        // Confluence's stored body (with any markup it added) is the new baseline, never the submitted one.
        const [stored, link] = await Promise.all([storedPage(p).catch(() => null), pageUrl(p)]);
        if (s !== seq.current) return;
        if (stored) {
          const storedBody = stored.body?.storage?.value ?? "";
          if (isOurSave(stored, p, { title: title.trim(), body: value }, editing ? original.current.version : null))
            return landed(stored, storedBody, link, sentDraft);
          // Someone saved after us: the editor follows the newer page, so nothing of theirs gets overwritten.
          const latestDraft = storageToDraft(storedBody).draft;
          landed(stored, storedBody, link, latestDraft, `Saved — but the page changed since your save (now v${stored.version?.number ?? "?"}); the editor shows the latest.`);
          if (mode !== "append") setBody(latestDraft);
          setTitle(stored.title ?? ""); // their rename too (adopt() set the title baseline)
          return;
        }
        // Saved, but the stored body is unknown: no further saves until the stored page is re-read. The committed
        // section is cleared, and Retry only re-reads (never re-applies the initial inputs).
        if (mode === "create" && p.id) (setPageId(p.id), setMode("whole"));
        if (mode === "append") setSection("");
        rereadOnly.current = true;
        setLoaded(false);
        setStatus({ kind: "error", message: "Saved — but couldn't re-read the page. Retry before saving again." });
        tangram.emit("saved", { pageId: p.id, title: p.title ?? title.trim(), url: link });
      })
      .catch((e: unknown) => {
        if (s !== seq.current) return;
        const message = errText(e);
        // Someone else saved meanwhile: the stored version is stale until the page is reloaded.
        if (editing && /409|conflict|version/i.test(message)) setStatus({ kind: "conflict", message });
        // A create that may have landed: look for it before ever offering Create again.
        else if (!editing && !definiteFailure(e)) {
          createAttempt.current = { spaceId, parentId, title: title.trim(), value, before };
          findCreated(s);
        } else if (editing && !definiteFailure(e)) {
          // An update that may have landed: look before ever offering it again.
          attempt.current = {
            pageId,
            gen: gen.current,
            mode: mode === "whole" ? "whole" : "append",
            title: title.trim(),
            sentBody: value,
            baseVersion: original.current.version,
            bodyEdited: sentEdited,
            draft: sentDraft,
          };
          checkUpdate(s);
        } else setStatus({ kind: "error", message });
      });
  }

  // Uncertain create, judged only by what was submitted (captured at the attempt): exactly one page with that title in
  // that space and parent, absent from the pre-create snapshot, holding the submitted body, is ours — continue editing
  // it with the draft kept. Anything else stays uncertain until checked again or insisted.
  function findCreated(s: number) {
    const a = createAttempt.current;
    setStatus({ kind: "busy" });
    findCreatedPage(a, sameText)
      .then((found) => {
        if (s !== seq.current) return;
        if (typeof found === "string") return setStatus({ kind: "uncertain", message: found });
        setPageId(found.id);
        loadPage(found.id, { title, body, append: false });
        tangram.emit("saved", { pageId: found.id, title: found.title ?? a.title, url: "" });
      })
      .catch((err: unknown) => s === seq.current && setStatus({ kind: "uncertain", message: `Couldn't check: ${errText(err)}` }));
  }

  // After a save whose follow-up read failed: the stored page becomes the baseline; drafts follow it (whole page).
  function refreshBaseline() {
    const s = ++seq.current;
    setStatus({ kind: "loading" });
    getPage(pageId)
      .then((p) => {
        if (s !== seq.current) return;
        const conv = adopt(p);
        if (mode !== "append") (setBody(conv.draft), (bodyBase.current = original.current.storage));
        setTitle(p.title ?? ""); // the stored title is the baseline too
        rereadOnly.current = false;
        setLoaded(true);
        setStatus({ kind: "idle" });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "error", message: errText(e) }));
  }

  // Conflict recovery: the latest version becomes the baseline. Append re-applies the section on top of it; whole-page
  // keeps edited fields and lets unedited ones follow the latest page. Either way the user saves again explicitly.
  function reloadLatest() {
    const s = ++seq.current;
    const titleWasEdited = title !== original.current.title;
    const bodyWasEdited = wholeEdited;
    setStatus({ kind: "busy" });
    getPage(pageId)
      .then((p) => {
        if (s !== seq.current) return;
        const base = original.current.storage;
        const conv = adopt(p);
        if (!titleWasEdited) setTitle(p.title ?? "");
        if (mode === "whole" && !bodyWasEdited) (setBody(conv.draft), (bodyBase.current = original.current.storage));
        setLoaded(true);
        // The conflicting version may be our own append that lost its answer.
        // Exact (canonical) comparison: the latest body is the old baseline plus this section.
        if (mode === "append" && section.trim() && sameStorage(original.current.storage, base + draftToStorage(section))) {
          setSection("");
          setStatus({ kind: "error", message: `Your section is already at the end of v${p.version?.number ?? "?"} — nothing to append.` });
          return;
        }
        setStatus({ kind: "error", message: reloadedNotice(p.version?.number, mode === "append", titleWasEdited || bodyWasEdited) });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "conflict", message: errText(e) }));
  }

  const changed = mode === "append" ? section.trim() !== "" || title.trim() !== original.current.title : true;
  const canSave =
    !busy && status.kind !== "conflict" && status.kind !== "uncertain" && status.kind !== "unsure" && !wholeBlocked &&
    title.trim() !== "" && changed &&
    (editing ? loaded : spaceId !== "");
  // While an update's outcome is unknown, the draft, title and mode stay read-only so nothing typed can be lost.
  const locked = attempt.current !== null;
  const draft = mode === "append" ? section : body;
  const setDraft = mode === "append" ? setSection : setBody;

  return (
    <div className="a-root">
      <div className="a-topbar">
        <span className="a-crumbs">{editing ? "Editing page" : "New page"}</span>
        {editing && version ? <span className="a-lozenge">v{version}</span> : null}
        <span className="sp" />
        {editing && url ? (
          <Button onClick={() => openExternal(url)}>Open in Confluence</Button>
        ) : null}
        <Button type="primary" disabled={!canSave} loading={status.kind === "busy"} onClick={() => save()}>
          {!editing ? "Publish" : mode === "append" ? "Append" : "Update"}
        </Button>
      </div>
      <div className="a-page wide">
        {status.kind === "loading" ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <>
            {pickSpace && !editing ? (
              <SpacePicker value={spaceId} disabled={status.kind === "uncertain" || busy} onChange={setSpaceId} />
            ) : null}
            {editing && loaded ? (
              <ModeBar
                mode={mode === "whole" ? "whole" : "append"}
                canWhole={roundTrips}
                lossy={lossy}
                disabled={busy || locked}
                onChange={(v) => {
                  setMode(v);
                  // A whole-page draft derived from an older baseline (e.g. before an append) is stale.
                  if (v === "whole" && bodyBase.current !== original.current.storage) {
                    setBody(original.current.draft);
                    bodyBase.current = original.current.storage;
                  }
                }}
              />
            ) : null}
            <input
              className="a-input a-titleinput"
              aria-label="Title"
              placeholder="Give this page a title"
              value={title}
              disabled={busy || locked}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="a-split">
              <textarea
                className="a-textarea"
                aria-label={mode === "append" ? "Section to append" : "Page content"}
                placeholder={`${mode === "append" ? "Write the section to add at the end…" : "Start writing…"}  ${SYNTAX}`}
                value={draft}
                disabled={busy || locked}
                onChange={(e) => setDraft(e.target.value)}
              />
              <DraftPreview
                draft={draft}
                label={mode === "append" ? "Preview of the appended section" : "Preview"}
                context={mode === "append" ? "…added after the page's current content, which stays exactly as it is." : undefined}
              />
            </div>
            <p className="a-hint">
              {mode === "create"
                ? "Publishing notifies space watchers."
                : mode === "append"
                  ? "Append adds this section at the end of the page; everything already there is kept exactly."
                  : "Update replaces the page's title and body; earlier versions stay in page history."}{" "}
              You'll confirm before anything is saved.
            </p>
            <StatusBanners
              status={status}
              showError={!editing || loaded}
              againLabel={mode === "append" ? "Append again anyway" : "Save again anyway"}
              onCheckUpdate={() => checkUpdate(seq.current)}
              onUpdateAgain={updateAgain}
              onCheckCreate={() => findCreated(seq.current)}
              onCreateAgain={() => save()}
              onReloadLatest={reloadLatest}
              onRetryLoad={editing && !loaded ? () => (rereadOnly.current ? refreshBaseline() : loadPage(pageId, inputsRef.current)) : undefined}
            />
          </>
        )}
      </div>
    </div>
  );
}
