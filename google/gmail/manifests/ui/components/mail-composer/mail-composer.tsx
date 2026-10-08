// Compose-and-send form over the connector's Message.Send / Draft.Create
// actions. An agent prefills the fields via render inputs; the user can edit
// everything (and attach files) before sending. Send is confirmation-gated by
// the host. Attachments are read locally via FileReader; Tangram's connector
// request adapter creates the provider-specific RFC 822 / MIME payload.
import { CloseOutlined, PaperClipOutlined } from "@ant-design/icons";
import { Button } from "antd";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/google.css";
import "../../shared/tangram-buttons.css";

const tangram = (window as any).tangram;

// Keep the interactive composer responsive and confirmation payloads compact.
// The server adapter separately enforces its own decoded-attachment ceiling.
const MAX_ATTACHMENT_BYTES = 3.5 * 1024 * 1024;

function b64Bytes(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

type Attachment = { name: string; mimeType: string; bytes: Uint8Array };

function actionBody(
  fields: { to: string; cc: string; subject: string; body: string },
  attachments: Attachment[],
  threadId: string,
  reply: { inReplyTo: string; references: string },
) {
  return {
    to: [fields.to],
    ...(fields.cc.trim() ? { cc: [fields.cc] } : {}),
    subject: fields.subject,
    text: fields.body,
    ...(threadId.trim() ? { threadId } : {}),
    ...(reply.inReplyTo.trim() ? { inReplyTo: reply.inReplyTo.trim() } : {}),
    ...(reply.references.trim() ? { references: reply.references.trim() } : {}),
    ...(attachments.length
      ? {
          attachments: attachments.map((attachment) => ({
            filename: attachment.name,
            contentType: attachment.mimeType || "application/octet-stream",
            contentBase64: b64Bytes(attachment.bytes),
          })),
        }
      : {}),
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SentMail = {
  id: string;
  threadId: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  attachments: { name: string; size: number }[];
  at: Date;
};

type Status =
  | { kind: "idle" }
  | { kind: "busy"; what: "send" | "draft" }
  | { kind: "sent"; mail: SentMail }
  | { kind: "drafted" }
  | { kind: "error"; message: string };

export default function MailComposer() {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [threadId, setThreadId] = useState("");
  const [reply, setReply] = useState({ inReplyTo: "", references: "" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Token renewal replays `init` with the same inputs — skip no-op re-applies
    // so a renewal can't wipe the user's in-progress edits. Keys are canonical
    // (sorted) so property order can never fake a change. A real input change
    // (agent re-render of this instance, e.g. a refined draft) applies the new
    // fields but keeps attachments: local files can't round-trip via the agent.
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
      setTo(String(inputs?.to ?? ""));
      setCc(String(inputs?.cc ?? ""));
      setSubject(String(inputs?.subject ?? ""));
      setBody(String(inputs?.body ?? ""));
      setThreadId(String(inputs?.threadId ?? ""));
      setReply({ inReplyTo: String(inputs?.inReplyTo ?? ""), references: String(inputs?.references ?? "") });
      setStatus({ kind: "idle" });
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, []);

  // Expose the draft fields to the agent (tangram_get_component_state) so
  // "refine my draft" can read the user's edits; attachments stay local.
  const draftRef = useRef({ to: "", cc: "", subject: "", body: "", threadId: "" });
  draftRef.current = { to, cc, subject, body, threadId };
  useEffect(() => {
    tangram.provideState?.(() => ({ ...draftRef.current }));
  }, []);

  const disabled = status.kind === "busy";
  const attachedBytes = attachments.reduce((n, a) => n + a.bytes.length, 0);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const files = Array.from(list);
    const incoming = files.reduce((n, f) => n + f.size, 0);
    if (attachedBytes + incoming > MAX_ATTACHMENT_BYTES) {
      setStatus({
        kind: "error",
        message: `Attachments exceed ${formatSize(MAX_ATTACHMENT_BYTES)} total — send large files as links instead.`,
      });
      return;
    }
    Promise.all(
      files.map(
        (f) =>
          new Promise<Attachment>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () =>
              resolve({
                name: f.name,
                mimeType: f.type || "application/octet-stream",
                bytes: new Uint8Array(r.result as ArrayBuffer),
              });
            r.onerror = () => reject(new Error(`Failed to read ${f.name}`));
            r.readAsArrayBuffer(f);
          }),
      ),
    )
      .then((read) => {
        setAttachments((prev) => [...prev, ...read]);
        setStatus({ kind: "idle" });
      })
      .catch((e: unknown) =>
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }

  function send() {
    if (!to.trim()) {
      setStatus({ kind: "error", message: "Recipient (To) is required." });
      return;
    }
    setStatus({ kind: "busy", what: "send" });
    tangram
      .performAction({ resourceType: "Message", action: "Send" }, {
        requestBody: actionBody({ to, cc, subject, body }, attachments, threadId, reply),
      })
      .then((m: { id?: string; threadId?: string }) => {
        setStatus({
          kind: "sent",
          mail: {
            id: m?.id ?? "",
            threadId: m?.threadId ?? threadId,
            to,
            cc,
            subject,
            body,
            attachments: attachments.map((a) => ({ name: a.name, size: a.bytes.length })),
            at: new Date(),
          },
        });
        tangram.emit("sent", { id: m?.id ?? "", threadId: m?.threadId ?? "" });
      })
      .catch((e: unknown) =>
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }

  function composeAnother() {
    setTo("");
    setCc("");
    setSubject("");
    setBody("");
    setThreadId("");
    setReply({ inReplyTo: "", references: "" });
    setAttachments([]);
    setStatus({ kind: "idle" });
  }

  function saveDraft() {
    setStatus({ kind: "busy", what: "draft" });
    tangram
      .performAction({ resourceType: "Draft", action: "Create" }, {
        requestBody: actionBody({ to, cc, subject, body }, attachments, threadId, reply),
      })
      .then(() => setStatus({ kind: "drafted" }))
      .catch((e: unknown) =>
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }

  if (status.kind === "sent") {
    const mail = status.mail;
    const metaRows: [string, string][] = [
      ["to", mail.to],
      ...(mail.cc.trim() ? ([["cc", mail.cc]] as [string, string][]) : []),
      ["date", mail.at.toLocaleString()],
    ];
    return (
      <div className="g-root g-pad">
        <div className="g-ok">Message sent</div>
        <h2 className="g-title" style={{ marginBottom: 8 }}>
          {mail.subject || "(no subject)"}
        </h2>
        <div className="g-meta" style={{ marginTop: 0 }}>
          {metaRows.map(([l, v]) => (
            <React.Fragment key={l}>
              <span>{l}:</span>
              <span>{v}</span>
            </React.Fragment>
          ))}
        </div>
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 16 }}>{mail.body}</div>
        {mail.attachments.length > 0 ? (
          <div className="g-atts">
            {mail.attachments.map((a, i) => (
              <div key={`${a.name}-${i}`} className="g-chip" style={{ cursor: "default" }}>
                <span className="g-fileicon" style={{ background: "#5f6368" }} aria-hidden="true">
                  <PaperClipOutlined />
                </span>
                <span style={{ minWidth: 0 }}>
                  <div className="n">{a.name}</div>
                  <div className="s">{formatSize(a.size)}</div>
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="g-actions">
          <Button onClick={composeAnother}>Compose another</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="g-root g-panel">
      <div className="g-panel-head">{threadId.trim() ? "Reply" : "New message"}</div>
      <div className="g-panel-body">
        <div className="g-field">
          <label htmlFor="mc-to">To</label>
          <input
            id="mc-to"
            value={to}
            disabled={disabled}
            placeholder="alice@example.com, bob@example.com"
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="g-field">
          <label htmlFor="mc-cc">Cc</label>
          <input id="mc-cc" value={cc} disabled={disabled} onChange={(e) => setCc(e.target.value)} />
        </div>
        <div className="g-field">
          <input
            aria-label="Subject"
            value={subject}
            disabled={disabled}
            placeholder="Subject"
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="g-field body">
          <textarea
            aria-label="Body"
            value={body}
            disabled={disabled}
            rows={8}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {attachments.length > 0 ? (
          <div className="g-atts" style={{ marginTop: 4, marginBottom: 8 }}>
            {attachments.map((att, i) => (
              <div key={`${att.name}-${i}`} className="g-chip" style={{ cursor: "default" }}>
                <span className="g-fileicon" style={{ background: "#5f6368" }} aria-hidden="true">
                  <PaperClipOutlined />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div className="n">{att.name}</div>
                  <div className="s">{formatSize(att.bytes.length)}</div>
                </span>
                <Button
                  type="text"
                  size="small"
                  aria-label={`Remove ${att.name}`}
                  icon={<CloseOutlined aria-hidden="true" />}
                  disabled={disabled}
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                />
              </div>
            ))}
          </div>
        ) : null}
        {threadId.trim() ? (
          <div className="g-faint" style={{ marginBottom: 8 }}>
            Replying within thread {threadId}
          </div>
        ) : null}
        <div className="g-bar">
          <Button
            type="text"
            icon={<PaperClipOutlined aria-hidden="true" />}
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            Attach
          </Button>
          <span className="sp" />
          {status.kind === "drafted" ? <span className="g-muted">Draft saved</span> : null}
          <Button onClick={saveDraft} disabled={disabled} loading={status.kind === "busy" && status.what === "draft"}>
            Save draft
          </Button>
          <Button type="primary" onClick={send} disabled={disabled} loading={status.kind === "busy" && status.what === "send"}>
            Send
          </Button>
        </div>
        {status.kind === "error" ? <div className="g-error inline">{status.message}</div> : null}
      </div>
    </div>
  );
}
