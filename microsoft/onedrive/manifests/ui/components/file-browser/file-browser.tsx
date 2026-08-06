// Search/browse OneDrive through the connector's read-only DriveItem.Search /
// DriveItem.List actions. An agent can prefill search text via render inputs;
// the user can edit it — Graph search is plain text over names AND content, so
// there is no query-operator syntax. An empty query browses from the drive
// root; folder rows drill down by item id. Graph's @odata.nextLink is a full
// URL that can't be replayed through a binding, so instead of pagination the
// component shows a "more items exist" note when a nextLink is present.
import {
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileZipOutlined,
  FolderFilled,
} from "@ant-design/icons";
import { Alert, Breadcrumb, Button, Empty, Input, List, Typography } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useState } from "react";

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

// Microsoft brand hexes inlined (no icon-color package in the sandbox
// catalog): Word blue, Excel green, PowerPoint red-orange, PDF red.
const WORD_BLUE = "#2b579a";
const EXCEL_GREEN = "#217346";
const PPT_ORANGE = "#b7472a";
const RED = "#f5222d";

const OFFICE_TYPES: Record<string, { label: string; icon: React.ReactNode }> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    label: "Word",
    icon: <FileWordOutlined style={{ color: WORD_BLUE }} />,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    label: "Excel",
    icon: <FileExcelOutlined style={{ color: EXCEL_GREEN }} />,
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    label: "PowerPoint",
    icon: <FilePptOutlined style={{ color: PPT_ORANGE }} />,
  },
};

function fileType(item: DriveItem): { label: string; icon: React.ReactNode } {
  if (item.folder) return { label: "Folder", icon: <FolderFilled style={{ color: "#5f6368" }} /> };
  const mime = item.file?.mimeType ?? "";
  const known = OFFICE_TYPES[mime];
  if (known) return known;
  if (mime === "application/pdf")
    return { label: "PDF", icon: <FilePdfOutlined style={{ color: RED }} /> };
  if (mime.startsWith("image/")) return { label: "Image", icon: <FileImageOutlined /> };
  if (mime.startsWith("text/")) return { label: "Text", icon: <FileTextOutlined /> };
  if (/zip|compressed|tar/.test(mime)) return { label: "Archive", icon: <FileZipOutlined /> };
  if (!mime) return { label: "File", icon: <FileOutlined /> };
  return { label: mime.split("/").pop() ?? "File", icon: <FileOutlined /> };
}

function formatSize(size: number | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

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

  const load = useCallback((target: Target, order: string, size: number) => {
    setState("loading");
    setError("");
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
        setItems(r?.value ?? []);
        setHasMore(Boolean(r?.["@odata.nextLink"]));
        setState("ready");
      })
      .catch((e: unknown) => {
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

  return (
    <div style={{ padding: 16, fontSize: 14, fontFamily: FONT_STACK, color: "rgba(0,0,0,0.88)" }}>
      <Input.Search
        value={searchText}
        placeholder="Search file names and content across the drive; empty browses from the root"
        loading={busy}
        onChange={(e) => setSearchText(e.target.value)}
        onSearch={(value) => {
          setPath([]);
          setRootQuery(value);
          load(rootTarget(value), orderBy, pageSize);
        }}
      />
      {inFolder ? (
        <Breadcrumb
          style={{ marginTop: 8 }}
          items={[
            {
              title: (
                <Typography.Link disabled={busy} onClick={() => goTo(0)}>
                  {rootQuery.trim() ? "Search" : "OneDrive"}
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
        <Alert type="error" showIcon message="Couldn't list items" description={error} style={{ marginTop: 12 }} />
      ) : (
        <List
          style={{ marginTop: 8 }}
          size="small"
          loading={busy}
          dataSource={items}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No items match" /> }}
          renderItem={(f) => {
            const type = fileType(f);
            const isFolder = Boolean(f.folder);
            const meta = [
              type.label,
              isFolder && typeof f.folder?.childCount === "number" ? `${f.folder.childCount} items` : "",
              f.lastModifiedDateTime ? dayjs(f.lastModifiedDateTime).format("MMM D, YYYY HH:mm") : "",
              isFolder ? "" : formatSize(f.size),
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
                        itemId: f.id,
                        name: f.name,
                        mimeType: f.file?.mimeType ?? "",
                        webUrl: f.webUrl ?? "",
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
                    ) : f.webUrl ? (
                      <a href={f.webUrl} target="_blank" rel="noopener noreferrer">
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
      {hasMore && state === "ready" ? (
        // @odata.nextLink is a full URL that a binding can't replay, and Graph
        // children listing has no $skip — surface the gap rather than hide it.
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
          Showing the first {items.length} items — more exist. Refine the search, open a subfolder,
          or raise pageSize.
        </Typography.Text>
      ) : null}
    </div>
  );
}
