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
import React, { useEffect, useRef, useState } from "react";
import "../../shared/atlassian.css";
import "../../shared/tangram-buttons.css";
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
  | { kind: "error"; message: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [spaceError, setSpaceError] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const seq = useRef(0);
  const draftRef = useRef({ spaceId, parentId, pageId, title, body });
  draftRef.current = { spaceId, parentId, pageId, title, body };

  useEffect(() => {
    tangram.provideState?.(() => ({ ...draftRef.current }));
    const apply = (inputs: Record<string, unknown>) => {
      const s = ++seq.current;
      const id = String(inputs?.pageId ?? "");
      setPageId(id);
      setSpaceId(String(inputs?.spaceId ?? ""));
      setParentId(String(inputs?.parentId ?? ""));
      setTitle(String(inputs?.title ?? ""));
      setBody(String(inputs?.body ?? ""));
      setLossy([]);
      setVersion(0);
      if (!id) {
        setStatus({ kind: "idle" });
        return;
      }
      // Edit mode: the page supplies version, space and (unless the input overrides it) title and body.
      setStatus({ kind: "loading" });
      tangram
        .performAction({ resourceType: "Page", action: "Get" }, { parameters: { id, "body-format": "storage" } })
        .then((p: Page) => {
          if (s !== seq.current) return;
          setVersion(p.version?.number ?? 0);
          setSpaceId(p.spaceId ?? "");
          if (!inputs?.title) setTitle(p.title ?? "");
          if (!inputs?.body) {
            const conv = storageToDraft(p.body?.storage?.value ?? "");
            setBody(conv.draft);
            setLossy(conv.lossy);
          }
          setStatus({ kind: "idle" });
        })
        .catch((e: unknown) => s === seq.current && setStatus({ kind: "error", message: errText(e) }));
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, []);

  // A new page needs a space: offer the account's spaces when none was given.
  const needsSpace = !pageId && !spaceId;
  useEffect(() => {
    if (!needsSpace || spaces) return;
    tangram
      .performAction({ resourceType: "Space", action: "List" }, { parameters: { limit: 100, status: "current" } })
      .then((r: { results?: Space[] }) => setSpaces(r?.results ?? []))
      .catch((e: unknown) => setSpaceError(errText(e)));
  }, [needsSpace, spaces]);

  const editing = pageId !== "";
  const busy = status.kind === "busy" || status.kind === "loading";

  function save() {
    const s = seq.current;
    const value = draftToStorage(body);
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
        setLossy([]);
        setStatus({ kind: "saved", title: p.title ?? title, url });
        tangram.emit("saved", { pageId: p.id, title: p.title ?? title, url });
      })
      .catch((e: unknown) => s === seq.current && setStatus({ kind: "error", message: errText(e) }));
  }

  const canSave = !busy && title.trim() !== "" && (editing || spaceId !== "");

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
            {needsSpace ? (
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
                  onChange={(v: string) => setSpaceId(v)}
                  options={(spaces ?? []).map((sp) => ({ value: sp.id, label: `${sp.name ?? sp.key} (${sp.key})` }))}
                />
              </div>
            ) : null}
            {spaceError ? <div className="a-error">{spaceError}</div> : null}
            {lossy.length ? (
              <div className="a-error" role="alert">
                This page has {lossy.join(", ")} that this editor can't keep. Updating replaces the whole body, so they would
                be lost — edit those parts in Confluence instead.
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
            {status.kind === "error" ? <div className="a-error">{status.message}</div> : null}
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
