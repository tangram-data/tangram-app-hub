// Metadata + content preview for one Drive file via the connector's read-only
// File.Get / File.Export actions. Workspace documents are exported as text
// (Docs/Slides → text/plain, Sheets → text/csv rendered as a table); binary
// uploads get metadata and an Open-in-Drive link only. Export responses are
// non-JSON, so the platform wraps them in an `app_action_result` envelope —
// inline text ≤32 KB, larger content saved to workspace files — and this
// component unwraps both shapes.
import { ExportOutlined, FolderFilled } from "@ant-design/icons";
import { Button, Skeleton, Table } from "antd";
import dayjs from "dayjs";
import React, { useEffect, useState, useRef } from "react";
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

// Drive's typed file badges: Docs blue, Sheets green, Slides yellow, PDF red.
function fileBadge(mime: string): { text: string; color: string } {
  if (mime === "application/vnd.google-apps.document") return { text: "DOC", color: "#4285f4" };
  if (mime === "application/vnd.google-apps.spreadsheet") return { text: "SH", color: "#0f9d58" };
  if (mime === "application/vnd.google-apps.presentation") return { text: "SL", color: "#f4b400" };
  if (mime === "application/pdf" || mime.startsWith("image/")) return { text: mime.startsWith("image/") ? "IMG" : "PDF", color: "#d93025" };
  return { text: "FILE", color: "#5f6368" };
}

export default function FileViewer() {
  const retry = useRef<(() => void) | null>(null);
  const [file, setFile] = useState<DriveFile | null>(null);
  const [content, setContent] = useState<Content>({ kind: "none" });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [exportNote, setExportNote] = useState("");

  useEffect(() => {
    // Bumped per load; responses from a superseded fileId are dropped.
    let loadSeq = 0;
    const load = (inputs: Record<string, unknown>) => {
      const seq = ++loadSeq;
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
          if (seq !== loadSeq) return;
          setFile(meta);
          setState("ready");
          const exportMime = EXPORT_MIME[meta.mimeType ?? ""];
          if (!exportMime) return;
          return tangram
            .performAction({ resourceType: "File", action: "Export" }, { parameters: { fileId, mimeType: exportMime } })
            .then((result: unknown) => {
              if (seq !== loadSeq) return;
              const { text, truncated, saved, note } = unwrapExport(result);
              if (note) setExportNote(note);
              if (saved) setContent({ kind: "saved", where: saved.where, note });
              else if (exportMime === "text/csv")
                setContent({ kind: "sheet", rows: parseCsv(text ?? ""), truncated });
              else setContent({ kind: "text", text: text ?? "", truncated });
            })
            .catch((e: unknown) => {
              if (seq !== loadSeq) return;
              setExportNote(`Preview unavailable: ${e instanceof Error ? e.message : String(e)}`);
            });
        })
        .catch((e: unknown) => {
          if (seq !== loadSeq) return;
          setError(e instanceof Error ? e.message : String(e));
          setState("error");
        });
    };
    // Retry re-runs the last inputs: identical input replays are ignored, so they can't recover a failed load.
    onNewInputs((inputs) => {
      retry.current = () => load(inputs);
      load(inputs);
    });
  }, []);

  if (state === "loading")
    return (
      <div className="g-root g-pad">
        <Skeleton active />
      </div>
    );
  if (state === "error" || !file)
    return (
      <div className="g-root">
        <div className="g-error">
          <b>Couldn't load file</b>
          {error ? <div>{error}</div> : null}
          <div style={{ marginTop: 8 }}>
            <Button size="small" onClick={() => retry.current?.()}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );

  const mime = file.mimeType ?? "";
  const owner = file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? "";
  const badge = fileBadge(mime);
  const meta = [
    TYPE_LABEL[mime] ?? mime ?? "File",
    owner ? `Owner: ${owner}` : "",
    file.modifiedTime ? `Modified ${dayjs(file.modifiedTime).format("MMM D, YYYY HH:mm")}` : "",
    file.size ? formatSize(file.size) : "",
  ].filter(Boolean);

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
    <div className="g-root">
      <div className="g-appbar">
        {mime === "application/vnd.google-apps.folder" ? (
          <FolderFilled style={{ color: "#5f6368", fontSize: 24 }} aria-hidden="true" />
        ) : (
          <span className="g-fileicon lg" style={{ background: badge.color }} aria-hidden="true">
            {badge.text}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t" title={file.name}>
            {file.name}
          </div>
          <div className="g-faint" style={{ overflowWrap: "anywhere" }}>
            {meta.join(" · ")}
          </div>
        </div>
        {file.webViewLink ? (
          <Button icon={<ExportOutlined aria-hidden="true" />} href={file.webViewLink} target="_blank" rel="noopener noreferrer">
            Open in Drive
          </Button>
        ) : null}
      </div>
      {content.kind !== "none" || exportNote ? (
        <div className="g-canvas">
          {content.kind === "text" || content.kind === "sheet" ? (
            content.truncated ? (
              <div className="g-warn">
                Preview truncated — content exceeds the inline limit. Open in Drive for the full document.
              </div>
            ) : null
          ) : null}
          {content.kind === "text" ? (
            <div className="g-doc page" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {content.text || "(empty document)"}
            </div>
          ) : null}
          {content.kind === "sheet" ? (
            <div style={{ background: "#fff", border: "1px solid var(--g-line)" }}>
              <Table
                size="small"
                bordered
                columns={sheetColumns}
                dataSource={sheetRows}
                pagination={sheetRows.length > 50 ? { pageSize: 50, size: "small" } : false}
                scroll={{ x: "max-content" }}
              />
            </div>
          ) : null}
          {sheetOverflow ? (
            <div className="g-faint" style={{ marginTop: 8 }}>
              Showing the first {MAX_SHEET_ROWS} rows — open in Drive for the full sheet.
            </div>
          ) : null}
          {content.kind === "saved" ? (
            <div className="g-info" style={{ margin: 0 }}>
              <b>Content too large to preview inline</b>
              <div>
                {content.where
                  ? `Exported content was saved to workspace files: ${content.where}`
                  : "Exported content was saved to workspace files."}
              </div>
            </div>
          ) : null}
          {exportNote && content.kind !== "saved" ? (
            <div className="g-faint" style={{ marginTop: 8 }}>
              {exportNote}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
