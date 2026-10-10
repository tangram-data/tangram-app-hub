// Metadata + content preview for one Box file via the connector's read-only
// File.Get / File.Download actions. Text-like files (txt, md, json, code…)
// download and render inline, CSV/TSV as a table. Other files (PDF, Office,
// images) aren't downloaded automatically — "Save copy to workspace files"
// fetches them on request, and "Open in Box" opens the Box preview.
import { DownloadOutlined, ExportOutlined } from "@ant-design/icons";
import { Button, Skeleton } from "antd";
import dayjs from "dayjs";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/box.css";
import "../../shared/tangram-buttons.css";
import { BoxItem, badgeFor, boxUrl, errorText, extensionOf, formatSize, openExternal, pathLabel } from "../../shared/box-format";
import { isTable, isTextLike, parseDelimited, unwrapDownload } from "./download";

const tangram = (window as any).tangram;

const FIELDS = "id,type,name,size,modified_at,modified_by,owned_by,path_collection,extension,description";
const MAX_ROWS = 500;

type Content =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "table"; rows: string[][]; truncated: boolean }
  | { kind: "saved"; where?: string }
  | { kind: "none" };

export default function FileViewer() {
  const [file, setFile] = useState<BoxItem | null>(null);
  const [content, setContent] = useState<Content>({ kind: "none" });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // The fileId of the current load, for Retry.
  const fileIdRef = useRef("");
  // Every load (new fileId input) bumps this; late results of an older file are dropped.
  const seq = useRef(0);

  // preview: render text inline; save: only a workspace-file reference counts (a small
  // binary returned inline would render as garbage, so it's reported instead).
  function download(fileId: string, ext: string, mine: number, mode: "preview" | "save", onDone?: () => void) {
    return tangram
      .performAction({ resourceType: "File", action: "Download" }, { parameters: { file_id: fileId } })
      .then((result: unknown) => {
        if (mine !== seq.current) return;
        const { text, truncated, saved, note: n } = unwrapDownload(result);
        if (n) setNote(n);
        if (saved) setContent({ kind: "saved", where: saved.where });
        else if (mode === "save") setNote(n || "The file came back inline instead of being saved — open it in Box to view it.");
        else if (isTable(ext))
          setContent({ kind: "table", rows: parseDelimited(text ?? "", ext === "tsv" ? "\t" : ","), truncated });
        else setContent({ kind: "text", text: text ?? "", truncated });
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setNote(`${mode === "save" ? "Save failed" : "Preview unavailable"}: ${errorText(e)}`);
        if (mode === "preview") setPreviewFailed(true);
      })
      .then(() => {
        // a stale download must not clear a newer file's saving state
        if (mine === seq.current) onDone?.();
      });
  }

  function loadFile(fileId: string) {
      const mine = ++seq.current;
      fileIdRef.current = fileId;
      setFile(null);
      setContent({ kind: "none" });
      setNote("");
      setSaving(false);
      setPreviewFailed(false);
      setPreviewing(false);
      if (!fileId) {
        setError("No fileId input provided.");
        setState("error");
        return;
      }
      setState("loading");
      setError("");
      tangram
        .performAction({ resourceType: "File", action: "Get" }, { parameters: { file_id: fileId, fields: FIELDS } })
        .then((meta: BoxItem) => {
          if (mine !== seq.current) return;
          setFile(meta);
          setState("ready");
          const ext = extensionOf(meta);
          if (isTextLike(ext)) {
            setPreviewing(true);
            return download(meta.id, ext, mine, "preview", () => setPreviewing(false));
          }
        })
        .catch((e: unknown) => {
          if (mine !== seq.current) return;
          setError(errorText(e));
          setState("error");
        });
  }

  useEffect(() => {
    const load = (inputs: Record<string, unknown>) => loadFile(String(inputs?.fileId ?? "").trim());
    // onInput fires as soon as the frame has its inputs (getInputs() returns a promise, so no synchronous load)
    tangram.onInput((inputs: Record<string, unknown>) => load(inputs ?? {}));
  }, []);

  if (state === "loading")
    return (
      <div className="bx-root bx-pad">
        <Skeleton active />
      </div>
    );
  if (state === "error" || !file)
    return (
      <div className="bx-root">
        <div className="bx-error" role="alert">
          <b>Couldn't load file</b>
          {error}
          {fileIdRef.current ? (
            <div style={{ marginTop: 8 }}>
              <Button size="small" onClick={() => loadFile(fileIdRef.current)}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );

  const ext = extensionOf(file);
  const badge = badgeFor(file);
  const owner = file.owned_by?.name ?? file.owned_by?.login ?? "";
  const by = file.modified_by?.name ?? file.modified_by?.login ?? "";
  const meta: [string, string][] = [
    ["Type", ext ? `${badge.label} (.${ext})` : badge.label],
    ...(file.size != null ? ([["Size", formatSize(file.size)]] as [string, string][]) : []),
    ...(file.modified_at
      ? ([["Updated", `${dayjs(file.modified_at).format("MMM D, YYYY HH:mm")}${by ? ` by ${by}` : ""}`]] as [
          string,
          string,
        ][])
      : []),
    ...(owner ? ([["Owner", owner]] as [string, string][]) : []),
    ...(file.description ? ([["Description", file.description]] as [string, string][]) : []),
  ];
  const path = pathLabel(file);
  const header = content.kind === "table" ? content.rows[0] ?? [] : [];
  const body = content.kind === "table" ? content.rows.slice(1, 1 + MAX_ROWS) : [];
  const overflow = content.kind === "table" && content.rows.length - 1 > MAX_ROWS;

  function retryPreview() {
    if (previewing || !file) return;
    setPreviewing(true);
    setPreviewFailed(false);
    setNote("");
    download(file.id, ext, seq.current, "preview", () => setPreviewing(false));
  }

  function saveCopy() {
    if (saving || !file) return;
    setSaving(true);
    setNote("");
    download(file.id, "", seq.current, "save", () => setSaving(false));
  }

  return (
    <div className="bx-root bx-pad">
      {path ? (
        <div className="bx-path" title={path}>
          {path}
        </div>
      ) : null}
      <div className="bx-head">
        <span className="bx-fileicon" style={{ background: badge.color, width: 28, height: 34 }} aria-hidden="true">
          {badge.text}
        </span>
        <h2 className="bx-title">{file.name}</h2>
      </div>
      <dl className="bx-meta">
        {meta.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      <div className="bx-actions">
        <Button size="small" icon={<ExportOutlined aria-hidden="true" />} onClick={() => openExternal(boxUrl(file))}>
          Open in Box
        </Button>
        {!isTextLike(ext) && content.kind !== "saved" ? (
          <Button size="small" icon={<DownloadOutlined aria-hidden="true" />} loading={saving} onClick={saveCopy}>
            Save copy to workspace files
          </Button>
        ) : null}
      </div>
      {content.kind !== "none" || note || previewing ? <hr className="bx-divider" /> : null}
      {previewing && content.kind === "none" && !note ? <Skeleton active title={false} paragraph={{ rows: 4 }} /> : null}
      {(content.kind === "text" || content.kind === "table") && content.truncated ? (
        <div className="bx-note warn">Preview truncated — the file exceeds the inline limit. Open it in Box for the rest.</div>
      ) : null}
      {content.kind === "text" ? <div className="bx-pre">{content.text || "(empty file)"}</div> : null}
      {content.kind === "table" ? (
        <div style={{ overflowX: "auto", border: "1px solid var(--bx-line)", borderRadius: 6 }}>
          <table className="bx-table" style={{ tableLayout: "auto" }}>
            <thead>
              <tr>
                {header.map((h, i) => (
                  <th key={i}>{h || `Column ${i + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, i) => (
                <tr key={i}>
                  {header.map((_, j) => (
                    <td key={j} title={r[j] ?? ""} style={{ maxWidth: 280 }}>
                      {r[j] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {overflow ? (
        <div className="bx-faint" style={{ marginTop: 8 }}>
          Showing the first {MAX_ROWS} rows — open in Box for the full file.
        </div>
      ) : null}
      {content.kind === "saved" ? (
        <div className="bx-note">
          <b style={{ display: "block" }}>Saved to workspace files</b>
          {content.where ?? "The file was saved to workspace files."}
        </div>
      ) : null}
      {note && content.kind !== "saved" ? <div className="bx-faint">{note}</div> : null}
      {previewFailed ? (
        <div style={{ marginTop: 8 }}>
          <Button size="small" loading={previewing} onClick={retryPreview}>
            Retry preview
          </Button>
        </div>
      ) : null}
    </div>
  );
}
