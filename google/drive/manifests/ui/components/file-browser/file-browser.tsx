// Search/browse Google Drive through the connector's read-only File.List
// action. An agent can prefill the query via render inputs; the user can edit
// it — plain text becomes a name search, text with Drive operators is passed
// through as a raw q. Folder rows drill down ('<id>' in parents); file rows
// link to Drive, and Select emits an `open` output for the host/agent.
import {
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileZipOutlined,
  FolderFilled,
  FundProjectionScreenOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { Alert, Breadcrumb, Button, Empty, Input, List, Typography } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";

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

// antd preset palette (blue-6/green-6/red-5 — @ant-design/colors isn't in the
// sandbox catalog, so the token hexes are inlined): Docs/Slides blue, Sheets
// green, PDFs red.
const BLUE = "#1677ff";
const GREEN = "#52c41a";
const RED = "#f5222d";

const GOOGLE_TYPES: Record<string, { label: string; icon: React.ReactNode }> = {
  "application/vnd.google-apps.document": {
    label: "Google Doc",
    icon: <FileTextOutlined style={{ color: BLUE }} />,
  },
  "application/vnd.google-apps.spreadsheet": {
    label: "Google Sheet",
    icon: <TableOutlined style={{ color: GREEN }} />,
  },
  "application/vnd.google-apps.presentation": {
    label: "Google Slides",
    icon: <FundProjectionScreenOutlined style={{ color: BLUE }} />,
  },
  [FOLDER_MIME]: { label: "Folder", icon: <FolderFilled style={{ color: "#5f6368" }} /> },
};

function fileType(mime: string | undefined): { label: string; icon: React.ReactNode } {
  if (!mime) return { label: "File", icon: <FileOutlined /> };
  const known = GOOGLE_TYPES[mime];
  if (known) return known;
  if (mime === "application/pdf")
    return { label: "PDF", icon: <FilePdfOutlined style={{ color: RED }} /> };
  if (mime.startsWith("image/")) return { label: "Image", icon: <FileImageOutlined /> };
  if (/zip|compressed|tar/.test(mime)) return { label: "Archive", icon: <FileZipOutlined /> };
  return { label: mime.split("/").pop() ?? "File", icon: <FileOutlined /> };
}

function formatSize(size: string | undefined): string {
  const bytes = Number(size);
  if (!size || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Text with Drive query operators is a raw q; anything else is a name search.
function toQuery(text: string): string {
  const t = text.trim();
  if (!t) return "trashed=false";
  if (/[=<>]|\b(contains|in|trashed)\b/.test(t)) return t;
  return `name contains '${t.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed=false`;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

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

  const load = useCallback(
    (q: string, order: string, size: number, pageToken?: string) => {
      const seq = ++loadSeq.current;
      setState(pageToken ? "more" : "loading");
      setError("");
      tangram
        .performAction({ resourceType: "File", action: "List" }, {
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
          setFiles((prev) => (pageToken ? [...prev, ...(r?.files ?? [])] : (r?.files ?? [])));
          setNextToken(r?.nextPageToken ?? "");
          setState("ready");
        })
        .catch((e: unknown) => {
          if (seq !== loadSeq.current) return;
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
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
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

  return (
    <div style={{ padding: 16, fontSize: 14, fontFamily: FONT_STACK, color: "rgba(0,0,0,0.88)" }}>
      <Input.Search
        value={searchText}
        placeholder="Search by name, or a Drive query like mimeType='application/vnd.google-apps.spreadsheet'"
        loading={state === "loading"}
        onChange={(e) => setSearchText(e.target.value)}
        onSearch={(value) => {
          setPath([]);
          load(value, orderBy, pageSize);
        }}
      />
      {path.length > 0 ? (
        <Breadcrumb
          style={{ marginTop: 8 }}
          items={[
            {
              title: (
                <Typography.Link disabled={busy} onClick={() => goTo(0)}>
                  Search
                </Typography.Link>
              ),
            },
            ...path.map((crumb, i) => ({
              title:
                i === path.length - 1 ? (
                  crumb.name
                ) : (
                  <Typography.Link disabled={busy} onClick={() => goTo(i + 1)}>
                    {crumb.name}
                  </Typography.Link>
                ),
            })),
          ]}
        />
      ) : null}
      {state === "error" ? (
        <Alert type="error" showIcon message="Couldn't list files" description={error} style={{ marginTop: 12 }} />
      ) : (
        <List
          style={{ marginTop: 8 }}
          size="small"
          loading={state === "loading"}
          dataSource={files}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No files match" /> }}
          renderItem={(f) => {
            const type = fileType(f.mimeType);
            const isFolder = f.mimeType === FOLDER_MIME;
            const owner = f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? "";
            const meta = [
              type.label,
              owner,
              f.modifiedTime ? dayjs(f.modifiedTime).format("MMM D, YYYY HH:mm") : "",
              formatSize(f.size),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <List.Item
                actions={[
                  <Button
                    key="select"
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
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<span style={{ fontSize: 18, color: "#5f6368" }}>{type.icon}</span>}
                  title={
                    isFolder ? (
                      <Typography.Link disabled={busy} onClick={() => openFolder(f)}>
                        {f.name}
                      </Typography.Link>
                    ) : f.webViewLink ? (
                      <a href={f.webViewLink} target="_blank" rel="noopener noreferrer">
                        {f.name}
                      </a>
                    ) : (
                      f.name
                    )
                  }
                  description={meta}
                />
              </List.Item>
            );
          }}
        />
      )}
      {nextToken && state !== "error" ? (
        <Button
          size="small"
          loading={state === "more"}
          disabled={state === "loading"}
          onClick={() => {
            if (!busy) load(searchText, orderBy, pageSize, nextToken);
          }}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
