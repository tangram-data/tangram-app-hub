// Create-or-append form over the connector's Document.Create /
// Document.Update actions. An agent prefills title/content via render
// inputs; the user edits before saving. Content is written with a single
// insertText batchUpdate (endOfSegmentLocation appends to the body), which is
// confirmation-gated by the host. When `documentId` is set the form appends
// to that document instead of creating a new one.
import { Alert, Button, Input, Space, Typography } from "antd";
import React, { useEffect, useRef, useState } from "react";

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
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
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

  const label = (text: string) => (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "10px 0 4px" }}>
      {text}
    </Typography.Text>
  );

  const rootStyle = {
    padding: 16,
    maxWidth: 720,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  };

  if (status.kind === "saved") {
    const doc = status.doc;
    return (
      <div style={rootStyle}>
        <Alert
          type="success"
          showIcon
          message={doc.appended ? "Content appended" : "Document created"}
          style={{ marginBottom: 12 }}
        />
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
          {doc.title || "Untitled document"}
        </Typography.Title>
        <Space>
          <Typography.Link href={docUrl(doc.documentId)} target="_blank" rel="noreferrer">
            Open in Google Docs
          </Typography.Link>
          <Button size="small" onClick={() => setStatus({ kind: "idle" })}>
            Back to form
          </Button>
        </Space>
      </div>
    );
  }

  if (status.kind === "created-write-failed") {
    return (
      <div style={rootStyle}>
        <Alert
          type="warning"
          showIcon
          message="Document created, but writing the content failed"
          description={status.message}
          style={{ marginBottom: 12 }}
        />
        <Space>
          <Typography.Link href={docUrl(status.documentId)} target="_blank" rel="noreferrer">
            Open the empty document
          </Typography.Link>
          <Button
            size="small"
            onClick={() => {
              // Retry as an append against the document that already exists.
              freshDocRef.current = status.documentId;
              setDocumentId(status.documentId);
              setStatus({ kind: "idle" });
            }}
          >
            Retry write
          </Button>
        </Space>
      </div>
    );
  }

  return (
    <div style={rootStyle}>
      {appending ? (
        <Alert
          type="info"
          showIcon
          message={`Appending to document ${documentId}`}
          style={{ marginBottom: 4 }}
        />
      ) : (
        <>
          {label("Title")}
          <Input value={title} disabled={disabled} onChange={(e) => setTitle(e.target.value)} />
        </>
      )}
      {label("Content")}
      <Input.TextArea
        value={content}
        disabled={disabled}
        autoSize={{ minRows: 10, maxRows: 30 }}
        placeholder="Plain text — it is inserted as-is."
        onChange={(e) => setContent(e.target.value)}
      />
      <Space style={{ marginTop: 14 }}>
        <Button type="primary" onClick={save} disabled={disabled} loading={status.kind === "busy"}>
          {appending ? "Append" : "Create document"}
        </Button>
      </Space>
      {status.kind === "error" ? (
        <Alert type="error" showIcon message={status.message} style={{ marginTop: 12 }} />
      ) : null}
    </div>
  );
}
