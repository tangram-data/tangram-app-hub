// Metadata + content preview for one Drive file via the connector's read-only
// File.Get / File.Export actions. Workspace documents are exported as text
// (Docs/Slides → text/plain, Sheets → text/csv rendered as a table); binary
// uploads get metadata and an Open-in-Drive link only. Export responses are
// non-JSON, so the platform wraps them in an `app_action_result` envelope —
// inline text ≤32 KB, larger content saved to workspace files — and this
// component unwraps both shapes.
import { ExportOutlined } from "@ant-design/icons";
import { Alert, Button, Divider, Skeleton, Table, Typography } from "antd";
import dayjs from "dayjs";
import React, { useEffect, useState } from "react";

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

const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const TYPE_LABEL: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.folder": "Folder",
};

const MAX_SHEET_ROWS = 500;

type Content =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "sheet"; rows: string[][]; truncated: boolean }
  | { kind: "saved"; where?: string; note?: string }
  | { kind: "none" };

// Unwrap an export result: raw text, or the platform's non-JSON envelope
// ({kind: "app_action_result", text?, base64?, file?, truncated?, note?}).
function unwrapExport(result: unknown): {
  text?: string;
  truncated: boolean;
  saved?: { where?: string };
  note?: string;
} {
  if (typeof result === "string") return { text: result, truncated: false };
  if (result && typeof result === "object") {
    const env = result as Record<string, any>;
    const truncated = env.truncated === true;
    if (typeof env.text === "string") return { text: env.text, truncated, note: env.note };
    if (typeof env.base64 === "string") {
      const bytes = Uint8Array.from(atob(env.base64), (c) => c.charCodeAt(0));
      return { text: new TextDecoder("utf-8").decode(bytes), truncated, note: env.note };
    }
    if (env.file && typeof env.file === "object") {
      const { folder, name } = env.file as Record<string, unknown>;
      const where =
        typeof folder === "string" && folder && typeof name === "string" && name
          ? `${folder}/${name}`
          : undefined;
      return { truncated, saved: { where }, note: env.note };
    }
    return { text: JSON.stringify(result, null, 2), truncated };
  }
  return { text: String(result ?? ""), truncated: false };
}

// RFC 4180 CSV: quoted cells, "" escapes, CRLF/LF rows.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function formatSize(size: string | undefined): string {
  const bytes = Number(size);
  if (!size || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export default function FileViewer() {
  const [file, setFile] = useState<DriveFile | null>(null);
  const [content, setContent] = useState<Content>({ kind: "none" });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [exportNote, setExportNote] = useState("");

  useEffect(() => {
    const load = (inputs: Record<string, unknown>) => {
      const fileId = String(inputs?.fileId ?? "").trim();
      if (!fileId) {
        setError("No fileId input provided.");
        setState("error");
        return;
      }
      setState("loading");
      setError("");
      setExportNote("");
      setContent({ kind: "none" });
      tangram
        .performAction({ resourceType: "File", action: "Get" }, {
          parameters: {
            fileId,
            fields: "id,name,mimeType,modifiedTime,size,owners,webViewLink",
            supportsAllDrives: true,
          },
        })
        .then((meta: DriveFile) => {
          setFile(meta);
          setState("ready");
          const exportMime = EXPORT_MIME[meta.mimeType ?? ""];
          if (!exportMime) return;
          return tangram
            .performAction({ resourceType: "File", action: "Export" }, { parameters: { fileId, mimeType: exportMime } })
            .then((result: unknown) => {
              const { text, truncated, saved, note } = unwrapExport(result);
              if (note) setExportNote(note);
              if (saved) setContent({ kind: "saved", where: saved.where, note });
              else if (exportMime === "text/csv")
                setContent({ kind: "sheet", rows: parseCsv(text ?? ""), truncated });
              else setContent({ kind: "text", text: text ?? "", truncated });
            })
            .catch((e: unknown) =>
              setExportNote(`Preview unavailable: ${e instanceof Error ? e.message : String(e)}`),
            );
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
          setState("error");
        });
    };
    load(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => load(inputs ?? {}));
  }, []);

  if (state === "loading") return <Skeleton active style={{ padding: 16 }} />;
  if (state === "error" || !file)
    return <Alert type="error" showIcon message="Couldn't load file" description={error} style={{ margin: 16 }} />;

  const mime = file.mimeType ?? "";
  const owner = file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? "";
  const metaRows: [string, string][] = [
    ["Type", TYPE_LABEL[mime] ?? mime ?? "File"],
    ...(owner ? ([["Owner", owner]] as [string, string][]) : []),
    ...(file.modifiedTime
      ? ([["Modified", dayjs(file.modifiedTime).format("MMM D, YYYY HH:mm")]] as [string, string][])
      : []),
    ...(file.size ? ([["Size", formatSize(file.size)]] as [string, string][]) : []),
  ];

  const sheetColumns =
    content.kind === "sheet" && content.rows.length > 0
      ? content.rows[0].map((h, i) => ({
          title: h || `Column ${i + 1}`,
          dataIndex: i,
          key: i,
          ellipsis: true,
        }))
      : [];
  const sheetRows =
    content.kind === "sheet"
      ? content.rows.slice(1, 1 + MAX_SHEET_ROWS).map((r, i) => ({ key: i, ...r }))
      : [];
  const sheetOverflow = content.kind === "sheet" && content.rows.length - 1 > MAX_SHEET_ROWS;

  return (
    <div style={{ padding: 16, fontSize: 14, fontFamily: FONT_STACK, color: "rgba(0,0,0,0.88)" }}>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {file.name}
      </Typography.Title>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 2 }}>
        {metaRows.map(([label, value]) => (
          <React.Fragment key={label}>
            <Typography.Text type="secondary">{label}</Typography.Text>
            <Typography.Text>{value}</Typography.Text>
          </React.Fragment>
        ))}
      </div>
      {file.webViewLink ? (
        <Button
          size="small"
          icon={<ExportOutlined />}
          style={{ marginTop: 12 }}
          href={file.webViewLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in Drive
        </Button>
      ) : null}
      {content.kind !== "none" || exportNote ? <Divider style={{ margin: "12px 0" }} /> : null}
      {content.kind === "text" || content.kind === "sheet" ? (
        content.truncated ? (
          <Alert
            type="warning"
            showIcon
            message="Preview truncated — content exceeds the inline limit. Open in Drive for the full document."
            style={{ marginBottom: 12 }}
          />
        ) : null
      ) : null}
      {content.kind === "text" ? (
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, wordBreak: "break-word" }}>
          {content.text || "(empty document)"}
        </div>
      ) : null}
      {content.kind === "sheet" ? (
        <>
          <Table
            size="small"
            columns={sheetColumns}
            dataSource={sheetRows}
            pagination={sheetRows.length > 50 ? { pageSize: 50, size: "small" } : false}
            scroll={{ x: "max-content" }}
          />
          {sheetOverflow ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Showing the first {MAX_SHEET_ROWS} rows — open in Drive for the full sheet.
            </Typography.Text>
          ) : null}
        </>
      ) : null}
      {content.kind === "saved" ? (
        <Alert
          type="info"
          showIcon
          message="Content too large to preview inline"
          description={
            content.where
              ? `Exported content was saved to workspace files: ${content.where}`
              : "Exported content was saved to workspace files."
          }
        />
      ) : null}
      {exportNote && content.kind !== "saved" ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          {exportNote}
        </Typography.Text>
      ) : null}
    </div>
  );
}
