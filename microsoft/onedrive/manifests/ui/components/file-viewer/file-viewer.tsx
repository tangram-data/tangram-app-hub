// Metadata + content preview for one OneDrive item via the connector's
// read-only DriveItem.Get / DriveItem.Download actions. Text-like files
// (text/*, JSON, CSV, markdown) download and render inline, CSV as a table.
// Office files have no text export in Graph (unlike Drive): Word/PowerPoint
// get a Convert-to-PDF action whose binary result is saved to workspace files;
// Excel gets a note pointing at the excel connector. Downloads are non-JSON,
// so the platform wraps them in an `app_action_result` envelope — inline text
// up to 32 KB, larger/binary content saved to workspace files — and this
// component unwraps both shapes.
import { ExportOutlined, FilePdfOutlined } from "@ant-design/icons";
import { Alert, Button, Divider, Skeleton, Table, Typography } from "antd";
import dayjs from "dayjs";
import React, { useEffect, useState } from "react";

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

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const TYPE_LABEL: Record<string, string> = {
  [DOCX]: "Word document",
  [XLSX]: "Excel workbook",
  [PPTX]: "PowerPoint presentation",
  "application/pdf": "PDF",
};

const MAX_SHEET_ROWS = 500;

function isTextLike(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime.includes("csv") ||
    mime.includes("markdown")
  );
}

function isCsv(mime: string, name: string): boolean {
  return mime.includes("csv") || /\.csv$/i.test(name);
}

type Content =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "sheet"; rows: string[][]; truncated: boolean }
  | { kind: "saved"; where?: string; note?: string }
  | { kind: "none" };

// Unwrap a download result: raw text, or the platform's non-JSON envelope
// ({kind: "app_action_result", text?, base64?, file?, truncated?, note?}).
function unwrapDownload(result: unknown): {
  text?: string;
  bytes?: Uint8Array;
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
      // Small binaries are inlined as base64 when the workspace-file sink is
      // unavailable — keep the raw bytes so binary results (e.g. PDF) survive.
      const bytes = Uint8Array.from(atob(env.base64), (c) => c.charCodeAt(0));
      return { text: new TextDecoder("utf-8").decode(bytes), bytes, truncated, note: env.note };
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

function formatSize(size: number | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export default function FileViewer() {
  const [item, setItem] = useState<DriveItem | null>(null);
  const [content, setContent] = useState<Content>({ kind: "none" });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    const load = (inputs: Record<string, unknown>) => {
      const itemId = String(inputs?.itemId ?? "").trim();
      if (!itemId) {
        setError("No itemId input provided.");
        setState("error");
        return;
      }
      setState("loading");
      setError("");
      setNote("");
      setContent({ kind: "none" });
      setConverting(false);
      tangram
        .performAction({ resourceType: "DriveItem", action: "Get" }, { parameters: { itemId, ["$select"]: SELECT } })
        .then((meta: DriveItem) => {
          setItem(meta);
          setState("ready");
          const mime = meta.file?.mimeType ?? "";
          if (meta.folder || !isTextLike(mime)) return;
          return tangram
            .performAction({ resourceType: "DriveItem", action: "Download" }, { parameters: { itemId } })
            .then((result: unknown) => {
              const { text, truncated, saved, note: n } = unwrapDownload(result);
              if (n) setNote(n);
              if (saved) setContent({ kind: "saved", where: saved.where, note: n });
              else if (isCsv(mime, meta.name))
                setContent({ kind: "sheet", rows: parseCsv(text ?? ""), truncated });
              else setContent({ kind: "text", text: text ?? "", truncated });
            })
            .catch((e: unknown) =>
              setNote(`Preview unavailable: ${e instanceof Error ? e.message : String(e)}`),
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

  // format=pdf conversion is binary: large results arrive as a saved-file
  // reference, small ones may be inlined as base64 when the file sink is
  // unavailable — offer that case as a direct browser download. Guard against
  // double-fire while the call is in flight.
  function convertToPdf(itemId: string, name: string) {
    if (converting) return;
    setConverting(true);
    setNote("");
    tangram
      .performAction({ resourceType: "DriveItem", action: "Download" }, { parameters: { itemId, format: "pdf" } })
      .then((result: unknown) => {
        const { saved, bytes, note: n } = unwrapDownload(result);
        if (n) setNote(n);
        if (saved) setContent({ kind: "saved", where: saved.where, note: n });
        else if (bytes) {
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = name.replace(/\.[^.]+$/, "") + ".pdf";
          a.click();
          URL.revokeObjectURL(url);
          setNote(n || "PDF downloaded.");
        } else setNote(n || "Conversion finished but returned no file reference.");
      })
      .catch((e: unknown) =>
        setNote(`Conversion failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .then(() => setConverting(false));
  }

  if (state === "loading") return <Skeleton active style={{ padding: 16 }} />;
  if (state === "error" || !item)
    return <Alert type="error" showIcon message="Couldn't load item" description={error} style={{ margin: 16 }} />;

  const mime = item.file?.mimeType ?? "";
  const isFolder = Boolean(item.folder);
  const typeLabel = isFolder ? "Folder" : (TYPE_LABEL[mime] ?? mime ?? "File");
  const metaRows: [string, string][] = [
    ["Type", typeLabel || "File"],
    ...(isFolder && typeof item.folder?.childCount === "number"
      ? ([["Items", String(item.folder.childCount)]] as [string, string][])
      : []),
    ...(item.lastModifiedDateTime
      ? ([["Modified", dayjs(item.lastModifiedDateTime).format("MMM D, YYYY HH:mm")]] as [
          string,
          string,
        ][])
      : []),
    ...(!isFolder && item.size != null
      ? ([["Size", formatSize(item.size)]] as [string, string][])
      : []),
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

  const isPdfConvertible = mime === DOCX || mime === PPTX;
  const showBody =
    content.kind !== "none" || note || isPdfConvertible || mime === XLSX;

  return (
    <div style={{ padding: 16, fontSize: 14, fontFamily: FONT_STACK, color: "rgba(0,0,0,0.88)" }}>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {item.name}
      </Typography.Title>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 2 }}>
        {metaRows.map(([label, value]) => (
          <React.Fragment key={label}>
            <Typography.Text type="secondary">{label}</Typography.Text>
            <Typography.Text>{value}</Typography.Text>
          </React.Fragment>
        ))}
      </div>
      {item.webUrl ? (
        <Button
          size="small"
          icon={<ExportOutlined />}
          style={{ marginTop: 12 }}
          href={item.webUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in OneDrive
        </Button>
      ) : null}
      {showBody ? <Divider style={{ margin: "12px 0" }} /> : null}
      {content.kind === "text" || content.kind === "sheet" ? (
        content.truncated ? (
          <Alert
            type="warning"
            showIcon
            message="Preview truncated — content exceeds the inline limit. Open in OneDrive for the full file."
            style={{ marginBottom: 12 }}
          />
        ) : null
      ) : null}
      {content.kind === "text" ? (
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, wordBreak: "break-word" }}>
          {content.text || "(empty file)"}
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
              Showing the first {MAX_SHEET_ROWS} rows — open in OneDrive for the full file.
            </Typography.Text>
          ) : null}
        </>
      ) : null}
      {content.kind === "saved" ? (
        <Alert
          type="info"
          showIcon
          message="Content saved to workspace files"
          description={
            content.where
              ? `The content was saved to workspace files: ${content.where}`
              : "The content was saved to workspace files."
          }
        />
      ) : null}
      {isPdfConvertible && content.kind !== "saved" ? (
        <div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {mime === DOCX ? "Word documents" : "PowerPoint presentations"} have no text export in
            Graph — convert to PDF to read the content (the PDF is saved to workspace files).
          </Typography.Paragraph>
          <Button
            size="small"
            icon={<FilePdfOutlined />}
            loading={converting}
            onClick={() => convertToPdf(item.id, item.name ?? "document")}
          >
            Convert to PDF
          </Button>
        </div>
      ) : null}
      {mime === XLSX ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: isPdfConvertible ? 12 : 0 }}
          message="Spreadsheet preview isn't available here"
          description="Use the excel connector, whose tools read cell values as JSON by this workbook's itemId."
        />
      ) : null}
      {note && content.kind !== "saved" ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          {note}
        </Typography.Text>
      ) : null}
    </div>
  );
}
