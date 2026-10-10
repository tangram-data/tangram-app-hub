// Create-or-append form over the connector's Document.Create /
// Document.Update actions. An agent prefills title/content via render
// inputs; the user edits before saving. Content is written with a single
// insertText batchUpdate (endOfSegmentLocation appends to the body), which is
// confirmation-gated by the host. When `documentId` is set the form appends
// to that document instead of creating a new one.
import { ExportOutlined } from "@ant-design/icons";
import { Button } from "antd";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/google.css";
import "../../shared/tangram-buttons.css";
import { onNewInputs } from "../../shared/sandbox-inputs";

const tangram = (window as any).tangram;

function docUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

type SavedDoc = { documentId: string; title: string; appended: boolean };

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved"; doc: SavedDoc }
  // The create succeeded but writing the content failed — the empty document
  // exists, so surface its link instead of pretending nothing happened.
  | { kind: "created-write-failed"; documentId: string; message: string }
  | { kind: "error"; message: string };

export default function DocComposer() {
  const [documentId, setDocumentId] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    // Token renewal replays `init` with the same inputs — dedup on a canonical
    // key so a renewal can't wipe the user's in-progress edits. A real input
    // change (agent re-render, e.g. refined content) applies the new fields.
    const canonical = (v: unknown): string =>
      Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : v !== null && typeof v === "object"
          ? `{${Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
              .join(",")}}`
          : (JSON.stringify(v) ?? "null");
    let lastApplied = "";
    const apply = (inputs: Record<string, unknown>) => {
      const key = canonical(inputs ?? {});
      if (key === lastApplied) return;
      lastApplied = key;
      setDocumentId(String(inputs?.documentId ?? "").trim());
      setTitle(String(inputs?.title ?? ""));
      setContent(String(inputs?.content ?? ""));
      setStatus({ kind: "idle" });
    };
    onNewInputs(apply);
  }, []);

  // Expose the draft to the agent (tangram_get_component_state) so "refine
  // the doc" can read the user's edits and re-render this instance.
  const draftRef = useRef({ documentId: "", title: "", content: "" });
  draftRef.current = { documentId, title, content };
  useEffect(() => {
    tangram.provideState?.(() => ({ ...draftRef.current }));
  }, []);

  const appending = documentId !== "";
  const disabled = status.kind === "busy";
  // Document this instance just created empty (write failed) — appending into
  // it must not add the paragraph-separator newline or the doc starts blank.
  const freshDocRef = useRef("");

  function writeContent(id: string, text: string): Promise<unknown> {
    return tangram.performAction({ resourceType: "Document", action: "Update" }, {
      parameters: { documentId: id },
      requestBody: {
        requests: [{ insertText: { endOfSegmentLocation: {}, text } }],
      },
    });
  }

  function finish(id: string, docTitle: string, appended: boolean) {
    if (id === freshDocRef.current) freshDocRef.current = "";
    setStatus({ kind: "saved", doc: { documentId: id, title: docTitle, appended } });
    tangram.emit("saved", { documentId: id, title: docTitle, url: docUrl(id) });
  }

  function save() {
    if (appending) {
      if (!content.trim()) {
        setStatus({ kind: "error", message: "Content is required when appending." });
        return;
      }
      setStatus({ kind: "busy" });
      // Leading newline is the paragraph break separating the appended text
      // from existing content; skipped for a known-empty just-created doc.
      const prefix = documentId === freshDocRef.current ? "" : "\n";
      writeContent(documentId, `${prefix}${content}`)
        .then(() => finish(documentId, title, true))
        .catch((e: unknown) =>
          setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
        );
      return;
    }
    if (!title.trim()) {
      setStatus({ kind: "error", message: "Title is required." });
      return;
    }
    setStatus({ kind: "busy" });
    tangram
      .performAction({ resourceType: "Document", action: "Create" }, { requestBody: { title: title.trim() } })
      .then((doc: { documentId?: string; title?: string }) => {
        const id = doc?.documentId ?? "";
        if (!id) throw new Error("Create returned no documentId.");
        if (!content.trim()) {
          finish(id, doc?.title ?? title.trim(), false);
          return;
        }
        return writeContent(id, content).then(
          () => finish(id, doc?.title ?? title.trim(), false),
          (e: unknown) =>
            setStatus({
              kind: "created-write-failed",
              documentId: id,
              message: e instanceof Error ? e.message : String(e),
            }),
        );
      })
      .catch((e: unknown) =>
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }


  const docIcon = (
    <span className="g-fileicon lg" style={{ background: "#4285f4" }} aria-hidden="true">
      DOC
    </span>
  );

  if (status.kind === "saved") {
    const doc = status.doc;
    return (
      <div className="g-root g-pad">
        <div className="g-ok">{doc.appended ? "Content appended" : "Document created"}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {docIcon}
          <h2 className="g-h2" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {doc.title || "Untitled document"}
          </h2>
        </div>
        <div className="g-bar" style={{ marginTop: 16 }}>
          <Button
            type="text"
            onClick={() => {
              // Continue as an append to the saved document; re-saving the same
              // fields would create (or append) a duplicate.
              setDocumentId(doc.documentId);
              setContent("");
              setStatus({ kind: "idle" });
            }}
          >
            Back to form
          </Button>
          <span className="sp" />
          <Button icon={<ExportOutlined aria-hidden="true" />} href={docUrl(doc.documentId)} target="_blank" rel="noreferrer">
            Open in Google Docs
          </Button>
        </div>
      </div>
    );
  }

  if (status.kind === "created-write-failed") {
    return (
      <div className="g-root g-pad">
        <div className="g-warn">
          <b>Document created, but writing the content failed</b>
          <div>{status.message}</div>
        </div>
        <div className="g-bar">
          <Button icon={<ExportOutlined aria-hidden="true" />} href={docUrl(status.documentId)} target="_blank" rel="noreferrer">
            Open the empty document
          </Button>
          <span className="sp" />
          <Button
            onClick={() => {
              // Retry as an append against the document that already exists.
              freshDocRef.current = status.documentId;
              setDocumentId(status.documentId);
              setStatus({ kind: "idle" });
            }}
          >
            Retry write
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="g-root">
      <div className="g-appbar">
        {docIcon}
        {appending ? (
          <span className="t g-muted" title={documentId}>
            Appending to document {documentId}
          </span>
        ) : (
          <input
            className="t"
            aria-label="Title"
            placeholder="Untitled document"
            value={title}
            disabled={disabled}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
        <Button type="primary" onClick={save} disabled={disabled} loading={status.kind === "busy"}>
          {appending ? "Append" : "Create document"}
        </Button>
      </div>
      {status.kind === "error" ? <div className="g-error">{status.message}</div> : null}
      <div className="g-canvas">
        <div className="g-doc page">
          <textarea
            aria-label="Content"
            value={content}
            disabled={disabled}
            placeholder="Plain text — it is inserted as-is."
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
