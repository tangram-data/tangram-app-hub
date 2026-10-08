// Search/browse OneDrive through the connector's read-only DriveItem.Search /
// DriveItem.List actions. An agent can prefill search text via render inputs;
// the user can edit it — Graph search is plain text over names AND content, so
// there is no query-operator syntax. An empty query browses from the drive
// root; folder rows drill down by item id. Graph's @odata.nextLink is a full
// URL that can't be replayed through a binding, so instead of pagination the
// component shows a "more items exist" note when a nextLink is present.
import {
  FileImageOutlined,
  FileOutlined,
  FileTextOutlined,
  FileZipOutlined,
  FolderFilled,
} from "@ant-design/icons";
import { Button, Input, Spin } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/microsoft.css";
import "../../shared/tangram-buttons.css";

const tangram = (window as any).tangram;

type DriveItem = {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
};

const SELECT = "id,name,size,lastModifiedDateTime,folder,file,webUrl";
const DEFAULT_PAGE_SIZE = 50;

// Office brand badges (Word/Excel/PowerPoint/PDF); other types get a muted icon.
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const badge = (label: string, color: string) => (
  <span className="m-fileicon" style={{ background: color }} aria-hidden="true">
    {label}
  </span>
);
const muted = (icon: React.ReactNode) => (
  <span style={{ fontSize: 18, color: "#616161", width: 20, display: "inline-grid", placeItems: "center", flex: "none" }} aria-hidden="true">
    {icon}
  </span>
);

type Kind = "folder" | "word" | "excel" | "ppt" | "pdf" | "other";

function fileType(item: DriveItem): { label: string; kind: Kind; icon: React.ReactNode } {
  if (item.folder)
    return {
      label: "Folder",
      kind: "folder",
      icon: <FolderFilled aria-hidden="true" style={{ color: "#ffc83d", fontSize: 20, flex: "none" }} />,
    };
  const mime = item.file?.mimeType ?? "";
  if (mime === DOCX) return { label: "Word", kind: "word", icon: badge("W", "#185abd") };
  if (mime === XLSX) return { label: "Excel", kind: "excel", icon: badge("X", "#107c41") };
  if (mime === PPTX) return { label: "PowerPoint", kind: "ppt", icon: badge("P", "#c43e1c") };
  if (mime === "application/pdf") return { label: "PDF", kind: "pdf", icon: badge("PDF", "#c4314b") };
  if (mime.startsWith("image/")) return { label: "Image", kind: "other", icon: muted(<FileImageOutlined />) };
  if (mime.startsWith("text/")) return { label: "Text", kind: "other", icon: muted(<FileTextOutlined />) };
  if (/zip|compressed|tar/.test(mime)) return { label: "Archive", kind: "other", icon: muted(<FileZipOutlined />) };
  if (!mime) return { label: "File", kind: "other", icon: muted(<FileOutlined />) };
  return { label: mime.split("/").pop() ?? "File", kind: "other", icon: muted(<FileOutlined />) };
}

// Display-only type filter over the loaded page (no extra requests).
const FILTERS: { key: string; label: string; kinds: Kind[] }[] = [
  { key: "all", label: "All", kinds: [] },
  { key: "word", label: "Word", kinds: ["word"] },
  { key: "excel", label: "Excel", kinds: ["excel"] },
  { key: "pdf", label: "PDF", kinds: ["pdf"] },
];

function formatSize(size: number | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type Crumb = { name: string; itemId: string };
type Target = { kind: "search"; q: string } | { kind: "folder"; itemId: string };

export default function FileBrowser() {
  const [searchText, setSearchText] = useState("");
  // Folder drill-down trail; rootQuery is the search we left when entering it.
  const [path, setPath] = useState<Crumb[]>([]);
  const [rootQuery, setRootQuery] = useState("");
  const [orderBy, setOrderBy] = useState("");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  // Guards stale responses when loads overlap.
  const loadSeq = useRef(0);

  const load = useCallback((target: Target, order: string, size: number) => {
    const seq = ++loadSeq.current;
    setState("loading");
    setError("");
    setFilter("all");
    const call: Promise<Record<string, any>> =
      target.kind === "search"
        ? tangram.performAction({ resourceType: "DriveItem", action: "Search" }, {
            // q lands inside Graph's search(q='...') path literal — OData
            // escapes an embedded single quote by doubling it.
            parameters: { q: target.q.replace(/'/g, "''"), ["$top"]: size, ["$select"]: SELECT },
          })
        : tangram.performAction({ resourceType: "DriveItem", action: "List" }, {
            parameters: {
              itemId: target.itemId,
              ["$top"]: size,
              ["$select"]: SELECT,
              ["$orderby"]: order || undefined,
            },
          });
    call
      .then((r) => {
        if (seq !== loadSeq.current) return;
        setItems(r?.value ?? []);
        setHasMore(Boolean(r?.["@odata.nextLink"]));
        setState("ready");
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      });
  }, []);

  // Empty text browses from the drive root; anything else is a search.
  const rootTarget = (q: string): Target =>
    q.trim() ? { kind: "search", q: q.trim() } : { kind: "folder", itemId: "root" };

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const q = String(inputs?.query ?? "");
      const order = String(inputs?.orderBy ?? "");
      const size = Number(inputs?.pageSize) || DEFAULT_PAGE_SIZE;
      setSearchText(q);
      setRootQuery(q);
      setOrderBy(order);
      setPageSize(size);
      setPath([]);
      load(rootTarget(q), order, size);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  function openFolder(f: DriveItem) {
    if (path.length === 0) setRootQuery(searchText);
    setPath([...path, { name: f.name, itemId: f.id }]);
    load({ kind: "folder", itemId: f.id }, orderBy, pageSize);
  }

  // Jump back to a trail level: 0 = the original search/root, i = i-th folder.
  function goTo(depth: number) {
    setPath(path.slice(0, depth));
    if (depth === 0) {
      setSearchText(rootQuery);
      load(rootTarget(rootQuery), orderBy, pageSize);
    } else {
      load({ kind: "folder", itemId: path[depth - 1].itemId }, orderBy, pageSize);
    }
  }

  const busy = state === "loading";
  const inFolder = path.length > 0;

  const activeKinds = FILTERS.find((f) => f.key === filter)?.kinds ?? [];
  const shown = activeKinds.length
    ? items.filter((f) => activeKinds.includes(fileType(f).kind))
    : items;
  const emitOpen = (f: DriveItem) =>
    tangram.emit("open", {
      itemId: f.id,
      name: f.name,
      mimeType: f.file?.mimeType ?? "",
      webUrl: f.webUrl ?? "",
    });

  return (
    <div className="m-root">
      <div style={{ padding: "14px 20px 0" }}>
        <Input.Search
          value={searchText}
          placeholder="Search file names and content; empty browses from the root"
          loading={busy}
          onChange={(e) => setSearchText(e.target.value)}
          onSearch={(value) => {
            setPath([]);
            setRootQuery(value);
            load(rootTarget(value), orderBy, pageSize);
          }}
        />
      </div>
      <div className="m-listhead">
        <nav className="m-crumbs" aria-label="Location">
          {inFolder ? (
            <>
              <button type="button" className="m-link" disabled={busy} onClick={() => goTo(0)}>
                {rootQuery.trim() ? "Search" : "My files"}
              </button>
              {path.map((crumb, i) => (
                <React.Fragment key={`${crumb.itemId}-${i}`}>
                  <span className="sep" aria-hidden="true">›</span>
                  {i === path.length - 1 ? (
                    <span aria-current="page">{crumb.name}</span>
                  ) : (
                    <button type="button" className="m-link" disabled={busy} onClick={() => goTo(i + 1)}>
                      {crumb.name}
                    </button>
                  )}
                </React.Fragment>
              ))}
            </>
          ) : (
            <span>{rootQuery.trim() ? "Search results" : "My files"}</span>
          )}
        </nav>
        <span className="m-filter" role="group" aria-label="Filter by type">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? "on" : undefined}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </span>
      </div>
      {state === "error" ? (
        <div className="m-error" role="alert">
          <b>Couldn't list items</b>
          {error}
        </div>
      ) : busy ? (
        <Spin style={{ display: "block", margin: "32px auto" }} />
      ) : shown.length === 0 ? (
        <div className="m-empty">{items.length ? "No items of this type" : "No items match"}</div>
      ) : (
        <table className="m-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="m-mid" style={{ width: 150 }}>Modified</th>
              <th className="m-wide" style={{ width: 90 }}>Size</th>
              <th className="m-act">
                <span style={{ position: "absolute", left: -9999 }}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => {
              const type = fileType(f);
              const isFolder = Boolean(f.folder);
              const size = isFolder
                ? typeof f.folder?.childCount === "number"
                  ? `${f.folder.childCount} items`
                  : ""
                : formatSize(f.size);
              return (
                <tr
                  key={f.id}
                  className={isFolder ? "m-row" : "m-row-static"}
                  onClick={isFolder && !busy ? () => openFolder(f) : undefined}
                >
                  <td title={`${f.name} · ${type.label}`}>
                    <span className="m-name">
                      {type.icon}
                      {isFolder ? (
                        <button
                          type="button"
                          className="m-link"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            openFolder(f);
                          }}
                        >
                          {f.name}
                        </button>
                      ) : f.webUrl ? (
                        <a href={f.webUrl} target="_blank" rel="noopener noreferrer">
                          {f.name}
                        </a>
                      ) : (
                        <span>{f.name}</span>
                      )}
                    </span>
                  </td>
                  <td className="m-mid m-muted">
                    {f.lastModifiedDateTime ? dayjs(f.lastModifiedDateTime).format("MMM D, YYYY HH:mm") : ""}
                  </td>
                  <td className="m-wide m-muted">{size || "—"}</td>
                  <td className="m-act">
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        emitOpen(f);
                      }}
                    >
                      Select
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {hasMore && state === "ready" ? (
        // @odata.nextLink is a full URL that a binding can't replay, and Graph
        // children listing has no $skip — surface the gap rather than hide it.
        <div className="m-faint" style={{ padding: "8px 20px" }}>
          Showing the first {items.length} items — more exist. Refine the search, open a subfolder,
          or raise pageSize.
        </div>
      ) : null}
    </div>
  );
}
