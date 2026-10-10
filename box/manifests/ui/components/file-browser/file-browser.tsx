// Search and browse Box through the connector's read-only Item.Search and
// Folder.ListItems actions. An agent can prefill a search query or a folder via
// render inputs; with neither, the user's root folder (id 0) is listed. Folder
// rows drill down with a breadcrumb; file rows emit `open` for the host/agent
// (the row is the link), and "Open in Box" opens the file on app.box.com.
import { ExportOutlined, LoadingOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Skeleton } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/box.css";
import "../../shared/tangram-buttons.css";
import { BoxItem, badgeFor, boxUrl, errorText, formatSize, modifiedLabel, openExternal } from "../../shared/box-format";

const tangram = (window as any).tangram;

const PAGE_SIZE = 50;
const LIST_FIELDS = "id,type,name,size,modified_at,modified_by,extension";

// A listing source: a search, or one folder's items.
type Source = { kind: "search"; query: string } | { kind: "folder"; id: string; name: string };
type Page = { entries?: BoxItem[]; total_count?: number; offset?: number };

function fetchPage(src: Source, offset: number): Promise<Page> {
  if (src.kind === "search")
    return tangram.performAction(
      { resourceType: "Item", action: "Search" },
      { parameters: { query: src.query, limit: PAGE_SIZE, offset } },
    );
  return tangram.performAction(
    { resourceType: "Folder", action: "ListItems" },
    { parameters: { folder_id: src.id, fields: LIST_FIELDS, limit: PAGE_SIZE, offset } },
  );
}

const ROOT: Source = { kind: "folder", id: "0", name: "All Files" };

export default function FileBrowser() {
  const [searchText, setSearchText] = useState("");
  // Trail of folders opened from the base source (a search or the starting folder).
  const [base, setBase] = useState<Source>(ROOT);
  const [trail, setTrail] = useState<Extract<Source, { kind: "folder" }>[]>([]);
  const [items, setItems] = useState<BoxItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "more" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const loadSeq = useRef(0);
  // The source the current rows came from; "Load more" pages it, not the search box.
  const active = useRef<Source>(ROOT);

  const load = useCallback((src: Source, offset = 0) => {
    const seq = ++loadSeq.current;
    setState(offset ? "more" : "loading");
    setError("");
    fetchPage(src, offset)
      .then((r) => {
        if (seq !== loadSeq.current) return;
        active.current = src;
        const entries = r?.entries ?? [];
        setItems((prev) => (offset ? [...prev, ...entries] : entries));
        setTotal(typeof r?.total_count === "number" ? r.total_count : offset + entries.length);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        if (!offset) {
          setItems([]);
          setTotal(0);
        }
        setError(errorText(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const query = String(inputs?.query ?? "").trim();
      const folderId = String(inputs?.folderId ?? "").trim();
      const src: Source = query
        ? { kind: "search", query }
        : folderId && folderId !== "0"
          ? { kind: "folder", id: folderId, name: "Folder" }
          : ROOT;
      setSearchText(query);
      setBase(src);
      setTrail([]);
      load(src);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  const busy = state === "loading" || state === "more";
  const current: Source = trail.length ? trail[trail.length - 1] : base;

  function submitSearch() {
    const q = searchText.trim();
    const src: Source = q ? { kind: "search", query: q } : ROOT;
    setBase(src);
    setTrail([]);
    load(src);
  }

  function openFolder(f: BoxItem) {
    const next = { kind: "folder" as const, id: f.id, name: f.name };
    setTrail([...trail, next]);
    load(next);
  }

  // 0 = the base source, i = the i-th opened folder.
  function goTo(depth: number) {
    const next = trail.slice(0, depth);
    setTrail(next);
    load(next.length ? next[next.length - 1] : base);
  }

  function activate(item: BoxItem) {
    if (busy) return;
    if (item.type === "folder") openFolder(item);
    else tangram.emit("open", { fileId: item.id, name: item.name, type: item.type });
  }

  const baseLabel = base.kind === "search" ? `Results for "${base.query}"` : base.name;

  return (
    <div className="bx-root">
      <div className="bx-toolbar">
        <form
          className="bx-search"
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
        >
          <button type="submit" className="bx-iconbtn" aria-label="Search">
            {state === "loading" ? <LoadingOutlined aria-hidden="true" /> : <SearchOutlined aria-hidden="true" />}
          </button>
          <input
            aria-label="Search Box"
            value={searchText}
            placeholder="Search files and folders — names, contents, comments, tags"
            onChange={(e) => setSearchText(e.target.value)}
          />
        </form>
      </div>
      <nav className="bx-crumbs" aria-label="Location">
        {trail.length === 0 ? (
          <span className="cur">{baseLabel}</span>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => goTo(0)}>
              {baseLabel}
            </button>
            {trail.map((crumb, i) => (
              <React.Fragment key={`${crumb.id}-${i}`}>
                <span className="sep" aria-hidden="true">
                  ›
                </span>
                {i === trail.length - 1 ? (
                  <span className="cur">{crumb.name}</span>
                ) : (
                  <button type="button" disabled={busy} onClick={() => goTo(i + 1)}>
                    {crumb.name}
                  </button>
                )}
              </React.Fragment>
            ))}
          </>
        )}
      </nav>
      {state === "error" ? (
        <div className="bx-error" role="alert">
          <b>Couldn't load {current.kind === "search" ? "search results" : "this folder"}</b>
          {error}
        </div>
      ) : state === "loading" ? (
        <div style={{ padding: "8px 16px" }}>
          <Skeleton active title={false} paragraph={{ rows: 5 }} />
        </div>
      ) : items.length === 0 ? (
        <div className="bx-empty">{current.kind === "search" ? "No files match" : "This folder is empty"}</div>
      ) : (
        <table className="bx-table">
          <colgroup>
            <col />
            <col style={{ width: "24%" }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 44 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Updated by</th>
              <th>Updated</th>
              <th>Size</th>
              <th>
                <span className="bx-sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const badge = badgeFor(item);
              const by = item.modified_by?.name ?? item.modified_by?.login ?? "";
              return (
                <tr
                  key={`${item.type}-${item.id}`}
                  className="bx-row"
                  tabIndex={0}
                  title={item.type === "folder" ? `Open folder ${item.name}` : `Select ${item.name}`}
                  onClick={() => activate(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") activate(item);
                  }}
                >
                  <td>
                    <span className="bx-name">
                      {item.type === "folder" ? (
                        <span className="bx-folder" aria-label="Folder" role="img" />
                      ) : (
                        <span className="bx-fileicon" style={{ background: badge.color }} title={badge.label}>
                          {badge.text}
                        </span>
                      )}
                      <span>{item.name}</span>
                    </span>
                  </td>
                  <td className="bx-muted" title={by}>
                    {by || "—"}
                  </td>
                  <td
                    className="bx-muted"
                    title={item.modified_at ? dayjs(item.modified_at).format("MMM D, YYYY HH:mm") : ""}
                  >
                    {modifiedLabel(item.modified_at) || "—"}
                  </td>
                  <td className="bx-muted">{item.type === "folder" ? "—" : formatSize(item.size) || "—"}</td>
                  <td className="act">
                    <Button
                      type="text"
                      size="small"
                      aria-label={`Open ${item.name} in Box`}
                      title="Open in Box"
                      icon={<ExportOutlined aria-hidden="true" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        openExternal(boxUrl(item));
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {state !== "error" && state !== "loading" && items.length < total ? (
        <div className="bx-toolbar">
          <Button size="small" loading={state === "more"} onClick={() => !busy && load(active.current, items.length)}>
            Load more
          </Button>
          <span className="bx-faint">
            {items.length} of {total}
          </span>
        </div>
      ) : null}
    </div>
  );
}
