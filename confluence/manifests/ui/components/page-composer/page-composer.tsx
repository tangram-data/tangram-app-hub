// Confluence-editor-style composer: create a page in a space (optionally
// under a parent) or, with `pageId`, replace an existing page's title and
// body. The body is a plain-text draft (storage-draft.ts: # headings, -
// bullets, 1. lists, > quotes, ``` code…) converted to escaped storage XHTML
// on save. Edit mode loads the page, converts it back to a draft and warns
// when the page holds content the draft can't keep (tables, macros, images),
// since an update replaces the whole body. Create/Update are confirmation-
// gated by the host. The draft is readable via provideState; a successful
// save emits `saved` {pageId, title, url}.
import { Button, Select, Skeleton } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/atlassian.css";
import "../../shared/tangram-buttons.css";
import { definiteFailure, sameText, since, stableJson } from "../../shared/write-outcome";
import { draftToStorage, storageToDraft } from "./storage-draft";

const tangram = (window as any).tangram;

type Space = { id: string; key?: string; name?: string };
type Page = {
  id: string;
  title?: string;
  spaceId?: string;
  version?: { number?: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
};
type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "busy" }
  | { kind: "saved"; title: string; url: string }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "uncertain"; message: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function cursorOf(next?: string): string {
  if (!next) return "";
  const q = next.indexOf("?");
  return q < 0 ? "" : new URLSearchParams(next.slice(q + 1)).get("cursor") ?? "";
}

function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  if (tangram?.openUrl) tangram.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

async function pageUrl(p: Page): Promise<string> {
  if (!p._links?.webui) return "";
  if (p._links.base) return p._links.base + p._links.webui;
  const sites = (await tangram.performAction({ resourceType: "Site", action: "List" }, {}).catch(() => [])) as {
    url?: string;
  }[];
  return Array.isArray(sites) && sites.length === 1 && sites[0].url ? `${sites[0].url}/wiki${p._links.webui}` : "";
}

export default function PageComposer() {
  const [spaceId, setSpaceId] = useState("");
  const [parentId, setParentId] = useState("");
  const [pageId, setPageId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [version, setVersion] = useState(0);
  const [lossy, setLossy] = useState<string[]>([]);
  // Edit mode: the page as loaded. An unedited body is saved back byte-for-byte, so a title-only save never
  // rewrites content; `loaded` gates Update until the page (and its version) arrived.
  const [loaded, setLoaded] = useState(false);
  const original = useRef({ storage: "", draft: "", title: "" });
  // New pages without a spaceId input keep the space picker visible.
  const [pickSpace, setPickSpace] = useState(false);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [spaceError, setSpaceError] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const seq = useRef(0);
  const inputsRef = useRef<Record<string, unknown>>({});
  // The create whose outcome is unknown: its title and start time.
  const createAttempt = useRef({ spaceId: "", parentId: "", title: "", value: "", at: 0 });
  const draftRef = useRef({ spaceId, parentId, pageId, title, body });
  draftRef.current = { spaceId, parentId, pageId, title, body };

  const loadPage = useCallback((id: string, inputs: Record<string, unknown>) => {
    const s = ++seq.current;
    setLoaded(false);
    setStatus({ kind: "loading" });
    tangram
      .performAction({ resourceType: "Page", action: "Get" }, { parameters: { id, "body-format": "storage" } })
      .then((p: Page) => {
        if (s !== seq.current) return;
        const storage = p.body?.storage?.value ?? "";
        const conv = storageToDraft(storage);
        original.current = { storage, draft: conv.draft, title: p.title ?? "" };
        setVersion(p.version?.number ?? 0);
        setSpaceId(p.spaceId ?? "");
        // Inputs that are present (even empty) win over the page's values.
        if (inputs.title == null) setTitle(p.title ?? "");
        if (inputs.body == null) setBody(conv.draft);
        setLossy(conv.lossy);
        setLoaded(true);
        setStatus({ kind: "idle" });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "error", message: errText(e) }));
  }, []);

  useEffect(() => {
    tangram.provideState?.(() => ({ ...draftRef.current }));
    const apply = (inputs: Record<string, unknown>) => {
      inputsRef.current = inputs;
      const id = String(inputs?.pageId ?? "");
      setPageId(id);
      setSpaceId(String(inputs?.spaceId ?? ""));
      setPickSpace(!id && !inputs?.spaceId);
      setParentId(String(inputs?.parentId ?? ""));
      setTitle(String(inputs?.title ?? ""));
      setBody(String(inputs?.body ?? ""));
      setLossy([]);
      setVersion(0);
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

  // All spaces, cursor by cursor (bounded), with retry on failure.
  const loadSpaces = useCallback(async () => {
    setSpaces(null);
    setSpaceError("");
    try {
      const all: Space[] = [];
      let cursor = "";
      for (let n = 0; n < 20; n++) {
        const r = await tangram.performAction({ resourceType: "Space", action: "List" }, {
          parameters: { limit: 250, status: "current", ...(cursor ? { cursor } : {}) },
        });
        all.push(...((r?.results as Space[]) ?? []));
        cursor = cursorOf(r?._links?.next);
        if (!cursor) break;
      }
      setSpaces(all);
    } catch (e) {
      setSpaceError(errText(e));
    }
  }, []);
  const spacesRequested = useRef(false);
  useEffect(() => {
    if (pickSpace && !spacesRequested.current) {
      spacesRequested.current = true;
      loadSpaces();
    }
  }, [pickSpace, loadSpaces]);

  const editing = pageId !== "";
  const busy = status.kind === "busy" || status.kind === "loading";

  const bodyEdited = !editing || body !== original.current.draft;

  function save() {
    const s = seq.current;
    const at = Date.now();
    const value = bodyEdited ? draftToStorage(body) : original.current.storage;
    setStatus({ kind: "busy" });
    const call = editing
      ? tangram.performAction({ resourceType: "Page", action: "Update" }, {
          parameters: { id: pageId },
          requestBody: {
            id: pageId,
            status: "current",
            title: title.trim(),
            body: { representation: "storage", value },
            version: { number: version + 1 },
          },
        })
      : tangram.performAction({ resourceType: "Page", action: "Create" }, {
          requestBody: {
            spaceId,
            status: "current",
            title: title.trim(),
            ...(parentId ? { parentId } : {}),
            body: { representation: "storage", value },
          },
        });
    call
      .then(async (p: Page) => {
        const url = await pageUrl(p);
        if (s !== seq.current) return;
        setVersion(p.version?.number ?? version + 1);
        if (!editing && p.id) setPageId(p.id);
        original.current = { storage: value, draft: body, title: p.title ?? title.trim() };
        setLoaded(true);
        if (bodyEdited) setLossy([]);
        setStatus({ kind: "saved", title: p.title ?? title, url });
        tangram.emit("saved", { pageId: p.id, title: p.title ?? title, url });
      })
      .catch((e: unknown) => {
        if (s !== seq.current) return;
        const message = errText(e);
        // Someone else saved meanwhile: the stored version is stale until the page is reloaded.
        if (editing && /409|conflict|version/i.test(message)) setStatus({ kind: "conflict", message });
        // A create that may have landed: look for it before ever offering Create again.
        else if (!editing && !definiteFailure(e)) {
          createAttempt.current = { spaceId, parentId, title: title.trim(), value, at };
          findCreated(s);
        }
        else setStatus({ kind: "error", message });
      });
  }

  // Uncertain create, judged only by what was submitted (space, parent, title, body — captured at the attempt): exactly
  // one page with that title in that space, under that parent, created since the attempt and holding the submitted body
  // is ours — switch to editing it, keeping the draft. Anything else stays uncertain until checked again or insisted.
  function findCreated(s: number) {
    const a = createAttempt.current;
    setStatus({ kind: "busy" });
    tangram
      .performAction({ resourceType: "Page", action: "List" }, {
        parameters: { "space-id": a.spaceId, title: a.title, status: "current", limit: 10 },
      })
      .then(async (r: { results?: (Page & { createdAt?: string; parentId?: string })[] }) => {
        const fresh = (r?.results ?? []).filter(
          (x) => since(x.createdAt, a.at) && (!a.parentId || x.parentId === a.parentId),
        );
        const full = (await Promise.all(
          fresh.map((x) =>
            tangram.performAction({ resourceType: "Page", action: "Get" }, { parameters: { id: x.id, "body-format": "storage" } }),
          ),
        )) as Page[];
        if (s !== seq.current) return;
        const ours = full.filter((p) => sameText(p.body?.storage?.value ?? "", a.value));
        if (ours.length !== 1) {
          setStatus({
            kind: "uncertain",
            message: ours.length ? "More than one matching page was found." : "Not visible yet — Confluence may still have created it.",
          });
          return;
        }
        const p = ours[0];
        setPageId(p.id);
        loadPage(p.id, { title, body });
        tangram.emit("saved", { pageId: p.id, title: p.title ?? a.title, url: "" });
      })
      .catch((err: unknown) => s === seq.current && setStatus({ kind: "uncertain", message: `Couldn't check: ${errText(err)}` }));
  }

  // Conflict recovery: take the latest version and body as the new baseline, keep the user's title and body edits
  // (an unedited body follows the latest page), and wait for an explicit Update.
  function reloadLatest() {
    const s = ++seq.current;
    const bodyWasEdited = body !== original.current.draft;
    const titleWasEdited = title !== original.current.title;
    setStatus({ kind: "busy" });
    tangram
      .performAction({ resourceType: "Page", action: "Get" }, { parameters: { id: pageId, "body-format": "storage" } })
      .then((p: Page) => {
        if (s !== seq.current) return;
        const storage = p.body?.storage?.value ?? "";
        const conv = storageToDraft(storage);
        original.current = { storage, draft: conv.draft, title: p.title ?? "" };
        setVersion(p.version?.number ?? version);
        // Unedited fields follow the latest version, so Update can't undo someone else's change to them.
        if (!bodyWasEdited) setBody(conv.draft);
        if (!titleWasEdited) setTitle(p.title ?? "");
        setLossy(conv.lossy);
        setLoaded(true);
        setStatus({
          kind: "error",
          message: `Reloaded v${p.version?.number ?? "?"} — the page changed in Confluence. ${
            bodyWasEdited || titleWasEdited ? "Your edits are kept and would replace that version's; review them, then " : ""
          }Update again to save.`,
        });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "conflict", message: errText(e) }));
  }

  const canSave =
    !busy &&
    status.kind !== "conflict" &&
    status.kind !== "uncertain" &&
    title.trim() !== "" &&
    (editing ? loaded : spaceId !== "");

  return (
    <div className="a-root">
      <div className="a-topbar">
        <span className="a-crumbs">{editing ? "Editing page" : "New page"}</span>
        {editing && version ? <span className="a-lozenge">v{version}</span> : null}
        <span className="sp" />
        <Button type="primary" disabled={!canSave} loading={status.kind === "busy"} onClick={save}>
          {editing ? "Update" : "Publish"}
        </Button>
      </div>
      <div className="a-page">
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
                <Button size="small" type="text" onClick={loadSpaces}>
                  Retry
                </Button>
              </div>
            ) : null}
            {editing && !loaded && status.kind === "error" ? (
              <div className="a-error">
                Couldn't load the page: {status.message}{" "}
                <Button size="small" type="text" onClick={() => loadPage(pageId, inputsRef.current)}>
                  Retry
                </Button>
              </div>
            ) : null}
            {editing && lossy.length && bodyEdited ? (
              <div className="a-error" role="alert">
                This page has {lossy.join(", ")} that this editor can't keep. Saving your edited body replaces the whole page
                body, so they would be lost — undo your body edits to keep them, or edit in Confluence.
              </div>
            ) : editing && lossy.length ? (
              <p className="a-hint">
                This page has {lossy.join(", ")}; they're kept as long as you only change the title.
              </p>
            ) : null}
            <input
              className="a-input a-titleinput"
              aria-label="Title"
              placeholder="Give this page a title"
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="a-textarea"
              aria-label="Page content"
              placeholder={"Start writing…  # Heading   - bullet   1. step   > quote   ``` code"}
              value={body}
              disabled={busy}
              onChange={(e) => setBody(e.target.value)}
            />
            <p className="a-hint">
              {editing ? "Update replaces the page's title and body; earlier versions stay in page history." : "Publishing notifies space watchers."}{" "}
              You'll confirm before anything is saved.
            </p>
            {status.kind === "error" && (!editing || loaded) ? <div className="a-error">{status.message}</div> : null}
            {status.kind === "uncertain" ? (
              <div className="a-error" role="alert">
                The page may already exist: {status.message}{" "}
                <Button size="small" onClick={() => findCreated(seq.current)}>
                  Check again
                </Button>{" "}
                <Button size="small" onClick={save}>
                  Create again anyway
                </Button>
              </div>
            ) : null}
            {status.kind === "conflict" ? (
              <div className="a-error" role="alert">
                Someone changed this page since you opened it ({status.message}).{" "}
                <Button size="small" onClick={reloadLatest}>
                  Reload latest
                </Button>
              </div>
            ) : null}
            {status.kind === "saved" ? (
              <div className="a-ok">
                Saved “{status.title}”.{" "}
                {status.url ? (
                  <a
                    href={status.url}
                    onClick={(e) => {
                      e.preventDefault();
                      openExternal(status.url);
                    }}
                  >
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
