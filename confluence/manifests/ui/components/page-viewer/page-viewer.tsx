// A Confluence page as it reads in Confluence: space › parent breadcrumb,
// title, last-updated line, the storage-format body rendered through an
// allowlist (storage-render.tsx — no HTML injection), then footer comments
// with an "Add comment" box. Reads use Page.Get / Space.Get / Comment.List;
// posting uses Comment.Create, which the host confirms before it runs.
import { LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/atlassian.css";
import "../../shared/tangram-buttons.css";
import { StorageBody, openExternal } from "./storage-render";

const tangram = (window as any).tangram;

type Page = {
  id: string;
  title?: string;
  spaceId?: string;
  parentId?: string;
  status?: string;
  version?: { number?: number; createdAt?: string; authorId?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
};
type Comment = {
  id: string;
  version?: { createdAt?: string; authorId?: string };
  body?: { storage?: { value?: string } };
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Plain text → storage paragraphs (one per non-empty line).
function toStorage(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${escapeXml(l)}</p>`)
    .join("");
}

function when(iso?: string): string {
  if (!iso) return "";
  const d = dayjs(iso);
  return d.isSame(dayjs(), "year") ? d.format("MMM D, h:mm A") : d.format("MMM D, YYYY");
}

// Page links are relative to the site's wiki base; v2 responses carry it, else the only granted site.
async function siteBase(page: Page): Promise<string> {
  if (page._links?.base) return page._links.base;
  const sites = (await tangram.performAction({ resourceType: "Site", action: "List" }, {})) as { url?: string }[];
  return Array.isArray(sites) && sites.length === 1 && sites[0].url ? `${sites[0].url}/wiki` : "";
}

export default function PageViewer() {
  const [pageId, setPageId] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [comments, setComments] = useState<Comment[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState("");
  const seq = useRef(0);

  const loadComments = useCallback(async (id: string, s: number) => {
    const r = await tangram.performAction({ resourceType: "Comment", action: "List" }, {
      parameters: { id, "body-format": "storage", limit: 50 },
    });
    if (s === seq.current) setComments((r?.results as Comment[]) ?? []);
  }, []);

  const load = useCallback(
    async (id: string) => {
      const s = ++seq.current;
      setState("loading");
      setError("");
      setComments([]);
      if (!id) {
        setError("No page id given.");
        setState("error");
        return;
      }
      try {
        const p = (await tangram.performAction({ resourceType: "Page", action: "Get" }, {
          parameters: { id, "body-format": "storage" },
        })) as Page;
        if (s !== seq.current) return;
        setPage(p);
        setState("ready");
        tangram.provideState?.(() => ({ pageId: p.id, title: p.title ?? "", version: p.version?.number ?? 0 }));
        // Breadcrumb, link and comments are secondary: their failures don't hide the page.
        const [space, parent, base] = await Promise.all([
          p.spaceId
            ? tangram.performAction({ resourceType: "Space", action: "Get" }, { parameters: { id: p.spaceId } }).catch(() => null)
            : null,
          p.parentId
            ? tangram.performAction({ resourceType: "Page", action: "Get" }, { parameters: { id: p.parentId } }).catch(() => null)
            : null,
          siteBase(p).catch(() => ""),
        ]);
        if (s !== seq.current) return;
        setCrumbs([space?.name, parent?.title].filter(Boolean) as string[]);
        setUrl(base && p._links?.webui ? base + p._links.webui : "");
        await loadComments(p.id, s).catch(() => undefined);
      } catch (e) {
        if (s !== seq.current) return;
        setPage(null);
        setError(errText(e));
        setState("error");
      }
    },
    [loadComments],
  );

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const id = String(inputs?.pageId ?? "");
      setPageId(id);
      load(id);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  function postComment() {
    if (!page || !draft.trim()) return;
    const s = seq.current;
    setPosting(true);
    setPostError("");
    tangram
      .performAction({ resourceType: "Comment", action: "Create" }, {
        requestBody: { pageId: page.id, body: { representation: "storage", value: toStorage(draft) } },
      })
      .then(() => {
        if (s !== seq.current) return;
        setDraft("");
        return loadComments(page.id, s);
      })
      .catch((e: unknown) => s === seq.current && setPostError(errText(e)))
      .finally(() => s === seq.current && setPosting(false));
  }

  return (
    <div className="a-root">
      <div className="a-topbar">
        <nav className="a-crumbs" aria-label="Location">
          {crumbs.length ? (
            crumbs.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 ? <span className="sep" aria-hidden="true">/</span> : null}
                <span>{c}</span>
              </React.Fragment>
            ))
          ) : (
            <span>Confluence</span>
          )}
        </nav>
        <span className="sp" />
        {url ? (
          <Button size="small" icon={<LinkOutlined aria-hidden="true" />} onClick={() => openExternal(url)}>
            Open in Confluence
          </Button>
        ) : null}
        <Tooltip title="Refresh">
          <Button
            size="small"
            aria-label="Refresh"
            icon={<ReloadOutlined aria-hidden="true" />}
            disabled={state === "loading"}
            onClick={() => load(pageId)}
          />
        </Tooltip>
      </div>
      <div className="a-page">
        {state === "loading" ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : state === "error" || !page ? (
          <div className="a-error">
            <b>Couldn't load the page</b>
            {error ? <div>{error}</div> : null}
          </div>
        ) : (
          <>
            <h1 className="a-title">{page.title || "Untitled"}</h1>
            <div className="a-meta">
              {page.status && page.status !== "current" ? <span className="a-lozenge">{page.status}</span> : null}
              {page.version?.createdAt ? <span>Last updated {when(page.version.createdAt)}</span> : null}
              {page.version?.number ? <span>· v{page.version.number}</span> : null}
            </div>
            {page.body?.storage?.value ? (
              <StorageBody xhtml={page.body.storage.value} />
            ) : (
              <div className="a-empty">This page is empty.</div>
            )}
            <section className="a-section" aria-label="Comments">
              <h2>{comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "Comments"}</h2>
              {comments.map((c) => (
                <div key={c.id} className="a-comment">
                  <span className="a-avatar" aria-hidden="true">
                    {(c.version?.authorId ?? "?").charAt(0).toUpperCase()}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="who">
                      Comment<span className="when">{when(c.version?.createdAt)}</span>
                    </div>
                    <StorageBody xhtml={c.body?.storage?.value ?? ""} />
                  </div>
                </div>
              ))}
              <textarea
                className="a-textarea sm"
                aria-label="Add a comment"
                placeholder="Add a comment…"
                value={draft}
                disabled={posting}
                onChange={(e) => setDraft(e.target.value)}
              />
              {postError ? <div className="a-error">{postError}</div> : null}
              <div className="a-bar" style={{ marginTop: 8 }}>
                <span className="sp" />
                <Button type="primary" size="small" loading={posting} disabled={!draft.trim()} onClick={postComment}>
                  Comment
                </Button>
              </div>
              <p className="a-hint">Posts as you; page watchers are notified. You'll confirm before it's sent.</p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
