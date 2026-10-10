// Confluence page composer, markdown-style drafts with a live preview (draft-preview.tsx):
//   - new page: the draft becomes the page (Page.Create into a chosen space, optionally under a parent);
//   - existing page, "Append section" (default): the draft is converted and appended to the page's storage body,
//     which is sent back byte-for-byte — nothing already on the page can be lost;
//   - existing page, "Edit whole page": offered only when the page round-trips through the draft without loss; an
//     unedited body is still sent back unchanged.
// Writes are confirmation-gated by the host. Uncertain creates are reconciled (composer-io titledPages snapshot),
// version conflicts reload the latest page and need an explicit re-save, identical inputs are ignored. The draft
// (with mode) is readable via provideState; a successful save emits `saved` {pageId, title, url}.
import { Button, Segmented, Select, Skeleton } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/atlassian.css";
import "../../shared/tangram-buttons.css";
import { definiteFailure, sameText, stableJson } from "../../shared/write-outcome";
import { Page, Space, allSpaces, errText, getPage, openExternal, pageUrl, titledPages } from "./composer-io";
import { DraftPreview } from "./draft-preview";
import { draftToStorage, storageToDraft } from "./storage-draft";

const tangram = (window as any).tangram;

type Mode = "create" | "append" | "whole";
type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "busy" }
  | { kind: "saved"; title: string; url: string }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "uncertain"; message: string };

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
  const original = useRef({ storage: "", draft: "", title: "" });
  const [pickSpace, setPickSpace] = useState(false);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [spaceError, setSpaceError] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const seq = useRef(0);
  const inputsRef = useRef<Record<string, unknown>>({});
  const createAttempt = useRef({ spaceId: "", parentId: "", title: "", value: "", before: new Set<string>() });
  const stateRef = useRef({});
  stateRef.current = { mode, spaceId, parentId, pageId, title, body, section };

  const adopt = (p: Page) => {
    const storage = p.body?.storage?.value ?? "";
    const conv = storageToDraft(storage);
    original.current = { storage, draft: conv.draft, title: p.title ?? "" };
    setVersion(p.version?.number ?? 0);
    setLossy(conv.lossy);
    pageUrl(p).then(setUrl, () => setUrl(""));
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
        setLoaded(true);
        setStatus({ kind: "idle" });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "error", message: errText(e) }));
  }, []);

  useEffect(() => {
    tangram.provideState?.(() => ({ ...stateRef.current }));
    const apply = (inputs: Record<string, unknown>) => {
      inputsRef.current = inputs;
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
      original.current = { storage: "", draft: "", title: "" };
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

  const loadSpaces = useCallback(() => {
    setSpaces(null);
    setSpaceError("");
    allSpaces().then(setSpaces, (e: unknown) => setSpaceError(errText(e)));
  }, []);
  const spacesRequested = useRef(false);
  useEffect(() => {
    if (pickSpace && !spacesRequested.current) {
      spacesRequested.current = true;
      loadSpaces();
    }
  }, [pickSpace, loadSpaces]);

  const editing = mode !== "create";
  const busy = status.kind === "busy" || status.kind === "loading";
  const roundTrips = loaded && lossy.length === 0;
  const wholeEdited = mode === "whole" && body !== original.current.draft;

  function outgoing(): string {
    if (mode === "create") return draftToStorage(body);
    if (mode === "append") return section.trim() ? original.current.storage + draftToStorage(section) : original.current.storage;
    return wholeEdited ? draftToStorage(body) : original.current.storage;
  }

  async function save() {
    const s = seq.current;
    const value = outgoing();
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
          requestBody: { id: pageId, status: "current", title: title.trim(), body: { representation: "storage", value }, version: { number: version + 1 } },
        })
      : tangram.performAction({ resourceType: "Page", action: "Create" }, {
          requestBody: { spaceId, status: "current", title: title.trim(), ...(parentId ? { parentId } : {}), body: { representation: "storage", value } },
        });
    call
      .then(async (p: Page) => {
        const saved = { ...p, body: { storage: { value } }, title: p.title ?? title.trim() };
        const link = await pageUrl(p);
        if (s !== seq.current) return;
        adopt(saved);
        // The markdown just saved is the baseline for further whole-page edits.
        if (mode !== "append") original.current.draft = body;
        if (!editing && p.id) {
          // A new page was written from markdown: keep editing it as a whole.
          setPageId(p.id);
          setMode("whole");
        }
        if (mode === "append") setSection("");
        setLoaded(true);
        setStatus({ kind: "saved", title: saved.title, url: link });
        tangram.emit("saved", { pageId: p.id, title: saved.title, url: link });
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
        } else setStatus({ kind: "error", message });
      });
  }

  // Uncertain create, judged only by what was submitted (captured at the attempt): exactly one page with that title in
  // that space and parent, absent from the pre-create snapshot, holding the submitted body, is ours — continue editing
  // it with the draft kept. Anything else stays uncertain until checked again or insisted.
  function findCreated(s: number) {
    const a = createAttempt.current;
    setStatus({ kind: "busy" });
    titledPages(a.spaceId, a.title)
      .then(async (results) => {
        const fresh = results.filter((x) => !a.before.has(x.id) && (!a.parentId || x.parentId === a.parentId));
        const full = await Promise.all(fresh.map((x) => getPage(x.id)));
        if (s !== seq.current) return;
        const ours = full.filter((p) => sameText(p.body?.storage?.value ?? "", a.value));
        if (ours.length !== 1) {
          setStatus({
            kind: "uncertain",
            message: ours.length ? "More than one matching page was found." : "Not visible yet — Confluence may still have created it.",
          });
          return;
        }
        setPageId(ours[0].id);
        loadPage(ours[0].id, { title, body, append: false });
        tangram.emit("saved", { pageId: ours[0].id, title: ours[0].title ?? a.title, url: "" });
      })
      .catch((err: unknown) => s === seq.current && setStatus({ kind: "uncertain", message: `Couldn't check: ${errText(err)}` }));
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
        const conv = adopt(p);
        if (!titleWasEdited) setTitle(p.title ?? "");
        if (mode === "whole" && !bodyWasEdited) setBody(conv.draft);
        setLoaded(true);
        const kept =
          mode === "append"
            ? "Your section will be appended to that version; "
            : titleWasEdited || bodyWasEdited
              ? "Your edits are kept and would replace that version's; review them, then "
              : "";
        setStatus({ kind: "error", message: `Reloaded v${p.version?.number ?? "?"} — the page changed in Confluence. ${kept}save again.` });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "conflict", message: errText(e) }));
  }

  const changed = mode === "append" ? section.trim() !== "" || title.trim() !== original.current.title : true;
  const canSave =
    !busy && status.kind !== "conflict" && status.kind !== "uncertain" && title.trim() !== "" && changed &&
    (editing ? loaded : spaceId !== "");
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
        <Button type="primary" disabled={!canSave} loading={status.kind === "busy"} onClick={save}>
          {!editing ? "Publish" : mode === "append" ? "Append" : "Update"}
        </Button>
      </div>
      <div className="a-page wide">
        {status.kind === "loading" ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <>
            {pickSpace && !editing ? (
              <div className="a-field">
                <label htmlFor="cf-space">Space</label>
                <Select
                  id="cf-space"
                  style={{ minWidth: 260 }}
                  placeholder={spaceError ? "Couldn't load spaces" : "Choose a space"}
                  loading={!spaces && !spaceError}
                  showSearch
                  optionFilterProp="label"
                  value={spaceId || undefined}
                  disabled={status.kind === "uncertain" || busy}
                  onChange={(v: string) => setSpaceId(v)}
                  options={(spaces ?? []).map((sp) => ({ value: sp.id, label: `${sp.name ?? sp.key} (${sp.key})` }))}
                />
              </div>
            ) : null}
            {spaceError ? (
              <div className="a-error">
                Couldn't load spaces: {spaceError}{" "}
                <Button size="small" type="text" onClick={loadSpaces}>Retry</Button>
              </div>
            ) : null}
            {editing && !loaded && status.kind === "error" ? (
              <div className="a-error">
                Couldn't load the page: {status.message}{" "}
                <Button size="small" type="text" onClick={() => loadPage(pageId, inputsRef.current)}>Retry</Button>
              </div>
            ) : null}
            {editing && loaded ? (
              <div className="a-modes">
                {roundTrips || mode === "whole" ? (
                  <Segmented
                    size="small"
                    value={mode}
                    disabled={busy}
                    onChange={(v) => {
                      setMode(v as Mode);
                      if (v === "whole" && !body) setBody(original.current.draft);
                    }}
                    options={[
                      { label: "Append section", value: "append" },
                      { label: "Edit whole page", value: "whole" },
                    ]}
                  />
                ) : (
                  <span className="a-hint">This page has formatting markdown can't keep — append, or edit in Confluence.</span>
                )}
              </div>
            ) : null}
            {mode === "whole" && lossy.length ? (
              <div className="a-error" role="alert">
                The page now has {lossy.join(", ")} that markdown can't keep.{" "}
                {wholeEdited ? "Saving your edited body would lose them — switch to Append section, or edit in Confluence." : "They're kept as long as you only change the title."}
              </div>
            ) : null}
            <input
              className="a-input a-titleinput"
              aria-label="Title"
              placeholder="Give this page a title"
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="a-split">
              <textarea
                className="a-textarea"
                aria-label={mode === "append" ? "Section to append" : "Page content"}
                placeholder={`${mode === "append" ? "Write the section to add at the end…" : "Start writing…"}  ${SYNTAX}`}
                value={draft}
                disabled={busy}
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
            {status.kind === "error" && (!editing || loaded) ? <div className="a-error">{status.message}</div> : null}
            {status.kind === "uncertain" ? (
              <div className="a-error" role="alert">
                The page may already exist: {status.message}{" "}
                <Button size="small" onClick={() => findCreated(seq.current)}>Check again</Button>{" "}
                <Button size="small" onClick={save}>Create again anyway</Button>
              </div>
            ) : null}
            {status.kind === "conflict" ? (
              <div className="a-error" role="alert">
                Someone changed this page since you opened it ({status.message}).{" "}
                <Button size="small" onClick={reloadLatest}>Reload latest</Button>
              </div>
            ) : null}
            {status.kind === "saved" ? (
              <div className="a-ok">
                Saved “{status.title}”.{" "}
                {status.url ? (
                  <a href={status.url} onClick={(e) => (e.preventDefault(), openExternal(status.url))}>
                    Open in Confluence
                  </a>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
