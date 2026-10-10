// Search/browse Google Drive through the connector's read-only File.Search
// action. An agent can prefill the query via render inputs; the user can edit
// it — plain text becomes a name search, text with Drive operators is passed
// through as a raw q. Folder rows drill down ('<id>' in parents); file rows
// link to Drive, and Select emits an `open` output for the host/agent.
import { FolderFilled, LoadingOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Skeleton } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/google.css";
import "../../shared/tangram-buttons.css";
import { onNewInputs } from "../../shared/sandbox-inputs";

const tangram = (window as any).tangram;

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  webViewLink?: string;
};

const FIELDS = "nextPageToken,files(id,name,mimeType,modifiedTime,size,owners,webViewLink)";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEFAULT_PAGE_SIZE = 25;

// Drive's typed file badges: Docs blue, Sheets green, Slides yellow, PDF red.
type Badge = { label: string; text: string; color: string };
const GOOGLE_TYPES: Record<string, Badge> = {
  "application/vnd.google-apps.document": { label: "Google Doc", text: "DOC", color: "#4285f4" },
  "application/vnd.google-apps.spreadsheet": { label: "Google Sheet", text: "SH", color: "#0f9d58" },
  "application/vnd.google-apps.presentation": { label: "Google Slides", text: "SL", color: "#f4b400" },
  "application/vnd.google-apps.form": { label: "Google Form", text: "FRM", color: "#7248b9" },
};

function fileType(mime: string | undefined): Badge {
  if (!mime) return { label: "File", text: "FILE", color: "#5f6368" };
  const known = GOOGLE_TYPES[mime];
  if (known) return known;
  if (mime === "application/pdf") return { label: "PDF", text: "PDF", color: "#d93025" };
  if (mime.startsWith("image/")) return { label: "Image", text: "IMG", color: "#d93025" };
  if (mime.startsWith("video/")) return { label: "Video", text: "VID", color: "#d93025" };
  if (/zip|compressed|tar/.test(mime)) return { label: "Archive", text: "ZIP", color: "#5f6368" };
  if (/spreadsheet|excel|csv/.test(mime)) return { label: mime.split("/").pop() ?? "File", text: "XLS", color: "#0f9d58" };
  if (/presentation|powerpoint/.test(mime)) return { label: mime.split("/").pop() ?? "File", text: "PPT", color: "#f4b400" };
  if (/wordprocessing|msword/.test(mime)) return { label: mime.split("/").pop() ?? "File", text: "W", color: "#4285f4" };
  return { label: mime.split("/").pop() ?? "File", text: "FILE", color: "#5f6368" };
}

const AVATAR_COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#7b1fa2", "#00897b", "#c2185b", "#5e35b1"];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Drive-style "Last modified": time today, "Oct 6" this year, else full date.
function modifiedLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = dayjs(iso);
  if (d.isSame(dayjs(), "day")) return d.format("h:mm A");
  if (d.isSame(dayjs(), "year")) return d.format("MMM D");
  return d.format("MMM D, YYYY");
}

function formatSize(size: string | undefined): string {
  const bytes = Number(size);
  if (!size || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Text shaped like a Drive query clause is a raw q; anything else (including
// bare words like "in" or "trashed") is a name search.
const RAW_QUERY = [
  /\b\w+\s*(=|!=|<=|>=|<|>|contains)\s*'/,
  /'[^']*'\s+in\s+(parents|owners|writers|readers)\b/,
  /\b(trashed|starred|sharedWithMe)\s*(=|!=)\s*(true|false)\b/,
];

function toQuery(text: string): string {
  const t = text.trim();
  if (!t) return "trashed=false";
  if (RAW_QUERY.some((re) => re.test(t))) return t;
  return `name contains '${t.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed=false`;
}

type Crumb = { name: string; query: string };

export default function FileBrowser() {
  const [searchText, setSearchText] = useState("");
  // Folder drill-down trail; rootQuery is the search we left when entering it.
  const [path, setPath] = useState<Crumb[]>([]);
  const [rootQuery, setRootQuery] = useState("");
  const [orderBy, setOrderBy] = useState("modifiedTime desc");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextToken, setNextToken] = useState("");
  const [state, setState] = useState<"loading" | "more" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const loadSeq = useRef(0);
  // Query/options the current results came from (set on success only); "Load
  // more" pages with them, not the (possibly edited) search box.
  const active = useRef({ q: "", order: "", size: DEFAULT_PAGE_SIZE });

  const load = useCallback(
    (q: string, order: string, size: number, pageToken?: string) => {
      const seq = ++loadSeq.current;
      setState(pageToken ? "more" : "loading");
      setError("");
      tangram
        .performAction({ resourceType: "File", action: "Search" }, {
          parameters: {
            q: toQuery(q),
            orderBy: order || undefined,
            pageSize: size,
            pageToken: pageToken || undefined,
            fields: FIELDS,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
          },
        })
        .then((r: { files?: DriveFile[]; nextPageToken?: string }) => {
          if (seq !== loadSeq.current) return;
          active.current = { q, order, size };
          setFiles((prev) => (pageToken ? [...prev, ...(r?.files ?? [])] : (r?.files ?? [])));
          setNextToken(r?.nextPageToken ?? "");
          setState("ready");
        })
        .catch((e: unknown) => {
          if (seq !== loadSeq.current) return;
          // A failed fresh search drops the old results so their token can't page a different query.
          if (!pageToken) {
            setFiles([]);
            setNextToken("");
          }
          setError(e instanceof Error ? e.message : String(e));
          setState("error");
        });
    },
    [],
  );

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const q = String(inputs?.query ?? "");
      const order = String(inputs?.orderBy ?? "modifiedTime desc");
      const size = Number(inputs?.pageSize) || DEFAULT_PAGE_SIZE;
      setSearchText(q);
      setOrderBy(order);
      setPageSize(size);
      setPath([]);
      load(q, order, size);
    };
    onNewInputs(apply);
  }, [load]);

  function openFolder(f: DriveFile) {
    const q = `'${f.id}' in parents and trashed=false`;
    if (path.length === 0) setRootQuery(searchText);
    setPath([...path, { name: f.name, query: q }]);
    setSearchText(q);
    load(q, orderBy, pageSize);
  }

  // Jump back to a trail level: 0 = the original search, i = i-th folder.
  function goTo(depth: number) {
    const q = depth === 0 ? rootQuery : path[depth - 1].query;
    setPath(path.slice(0, depth));
    setSearchText(q);
    load(q, orderBy, pageSize);
  }


  const busy = state === "loading" || state === "more";

  function submitSearch() {
    setPath([]);
    load(searchText, orderBy, pageSize);
  }

  return (
    <div className="g-root">
      <div className="g-toolbar" style={{ paddingTop: 12 }}>
        <form
          className="g-search"
          style={{ flex: 1, minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
        >
          <button type="submit" className="g-iconbtn" aria-label="Search">
            {state === "loading" ? <LoadingOutlined aria-hidden="true" /> : <SearchOutlined aria-hidden="true" />}
          </button>
          <input
            aria-label="Search in Drive"
            value={searchText}
            placeholder="Search in Drive — name, or a query like mimeType='application/vnd.google-apps.spreadsheet'"
            onChange={(e) => setSearchText(e.target.value)}
          />
        </form>
      </div>
      <nav className="g-crumbs" aria-label="Location">
        {path.length === 0 ? (
          <span className="cur">{active.current.q.trim() ? "Search results" : "Drive"}</span>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => goTo(0)}>
              {rootQuery.trim() ? "Search results" : "Drive"}
            </button>
            {path.map((crumb, i) => (
              <React.Fragment key={`${crumb.query}-${i}`}>
                <span className="sep" aria-hidden="true">
                  ›
                </span>
                {i === path.length - 1 ? (
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
        <div className="g-error">
          <b>Couldn't list files</b>
          {error ? <div>{error}</div> : null}
        </div>
      ) : state === "loading" ? (
        <div style={{ padding: "8px 16px" }}>
          <Skeleton active title={false} paragraph={{ rows: 5 }} />
        </div>
      ) : files.length === 0 ? (
        <div className="g-empty">No files match</div>
      ) : (
        <table className="g-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="g-wide" style={{ width: "26%" }}>
                Owner
              </th>
              <th style={{ width: "22%" }}>Last modified</th>
              <th className="g-wide" style={{ width: 90 }}>
                File size
              </th>
              <th style={{ width: 84 }}>
                <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const type = fileType(f.mimeType);
              const isFolder = f.mimeType === FOLDER_MIME;
              const owner = f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? "";
              return (
                <tr key={f.id}>
                  <td>
                    <span className="g-name">
                      {isFolder ? (
                        <FolderFilled style={{ color: "#5f6368", fontSize: 20, flex: "none" }} aria-label="Folder" />
                      ) : (
                        <span className="g-fileicon" style={{ background: type.color }} title={type.label}>
                          {type.text}
                        </span>
                      )}
                      {isFolder ? (
                        <button type="button" className="g-linkbtn" disabled={busy} onClick={() => openFolder(f)}>
                          {f.name}
                        </button>
                      ) : f.webViewLink ? (
                        <a href={f.webViewLink} target="_blank" rel="noopener noreferrer" title={f.name}>
                          {f.name}
                        </a>
                      ) : (
                        <span title={f.name}>{f.name}</span>
                      )}
                    </span>
                  </td>
                  <td className="g-wide g-muted" title={owner}>
                    {owner ? (
                      <>
                        <span className="g-avatar sm" style={{ background: avatarColor(owner), marginRight: 8 }} aria-hidden="true">
                          {owner.charAt(0).toUpperCase()}
                        </span>
                        {owner}
                      </>
                    ) : null}
                  </td>
                  <td className="g-muted" title={f.modifiedTime ? dayjs(f.modifiedTime).format("MMM D, YYYY HH:mm") : ""}>
                    {modifiedLabel(f.modifiedTime)}
                  </td>
                  <td className="g-wide g-muted">{isFolder ? "—" : formatSize(f.size) || "—"}</td>
                  <td className="act">
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() =>
                        tangram.emit("open", {
                          fileId: f.id,
                          name: f.name,
                          mimeType: f.mimeType ?? "",
                          webViewLink: f.webViewLink ?? "",
                        })
                      }
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
      {nextToken && state !== "error" ? (
        <div className="g-toolbar">
          <Button
            size="small"
            loading={state === "more"}
            disabled={state === "loading"}
            onClick={() => {
              if (!busy) load(active.current.q, active.current.order, active.current.size, nextToken);
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
