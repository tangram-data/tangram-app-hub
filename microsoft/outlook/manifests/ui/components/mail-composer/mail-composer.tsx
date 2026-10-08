// Compose-and-send form over the connector's Message.Send / Draft.Create
// actions. An agent prefills the fields via render inputs; the user can edit
// everything (and attach files) before sending. Send is confirmation-gated by
// the host. Graph sendMail takes structured JSON — no MIME assembly — and
// attachments ride along as inline fileAttachment objects (base64
// contentBytes), which Graph caps around 3 MB total, guarded below. Graph
// cannot thread a sendMail onto an existing conversation, so unlike the Gmail
// composer there is no reply-threading field.
import { CheckCircleFilled, DeleteOutlined, PaperClipOutlined, SendOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/microsoft.css";
import "../../shared/tangram-buttons.css";

const tangram = (window as any).tangram;

// Graph rejects inline JSON attachments beyond ~3MB total.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

// Standard base64 (Graph contentBytes), chunked to dodge argument limits.
function b64Bytes(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

type Attachment = { name: string; mimeType: string; bytes: Uint8Array };

function parseRecipients(s: string): { emailAddress: { address: string } }[] {
  return s
    .split(/[,;]+/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

// Graph message object, shared by sendMail ({message, saveToSentItems}) and
// createDraft (the bare object).
function buildMessage(
  fields: { to: string; cc: string; subject: string; body: string },
  attachments: Attachment[],
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    subject: fields.subject,
    body: { contentType: "text", content: fields.body },
    toRecipients: parseRecipients(fields.to),
  };
  const cc = parseRecipients(fields.cc);
  if (cc.length > 0) message.ccRecipients = cc;
  if (attachments.length > 0) {
    message.attachments = attachments.map((att) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.name,
      contentType: att.mimeType || "application/octet-stream",
      contentBytes: b64Bytes(att.bytes),
    }));
  }
  return message;
}

// Office-style file badge by extension (Word/Excel/PowerPoint/PDF), else a clip.
function AttIcon({ name }: { name: string }) {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const badge = /^docx?$/.test(ext)
    ? { label: "W", color: "#185abd" }
    : /^(xlsx?|csv)$/.test(ext)
      ? { label: "X", color: "#107c41" }
      : /^pptx?$/.test(ext)
        ? { label: "P", color: "#c43e1c" }
        : ext === "pdf"
          ? { label: "PDF", color: "#c4314b" }
          : null;
  if (!badge) return <PaperClipOutlined aria-hidden="true" style={{ fontSize: 16, color: "#616161" }} />;
  return (
    <span className="m-fileicon" style={{ background: badge.color }} aria-hidden="true">
      {badge.label}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SentMail = {
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
  | { kind: "drafted"; webLink: string }
  | { kind: "error"; message: string };

export default function MailComposer() {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
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
      setStatus({ kind: "idle" });
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, []);

  // Expose the draft fields to the agent (tangram_get_component_state) so
  // "refine my draft" can read the user's edits; attachments stay local.
  const draftRef = useRef({ to: "", cc: "", subject: "", body: "" });
  draftRef.current = { to, cc, subject, body };
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
    const message = buildMessage({ to, cc, subject, body }, attachments);
    tangram
      .performAction({ resourceType: "Message", action: "Send" }, {
        requestBody: { message, saveToSentItems: true },
      })
      // sendMail returns 202 with an empty body — any resolution is success,
      // so the sent output can only echo the local fields (no message id).
      .then(() => {
        setStatus({
          kind: "sent",
          mail: {
            to,
            cc,
            subject,
            body,
            attachments: attachments.map((a) => ({ name: a.name, size: a.bytes.length })),
            at: new Date(),
          },
        });
        tangram.emit("sent", { to, subject });
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
    setAttachments([]);
    setStatus({ kind: "idle" });
  }

  function saveDraft() {
    setStatus({ kind: "busy", what: "draft" });
    // createDraft takes the bare message object (no {message} wrapper).
    const message = buildMessage({ to, cc, subject, body }, attachments);
    tangram
      .performAction({ resourceType: "Draft", action: "Create" }, { requestBody: message })
      .then((d: { id?: string; webLink?: string }) =>
        setStatus({ kind: "drafted", webLink: d?.webLink ?? "" }),
      )
      .catch((e: unknown) =>
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }

  if (status.kind === "sent") {
    const mail = status.mail;
    return (
      <div className="m-root m-pad">
        <div className="m-ok" role="status">
          <CheckCircleFilled aria-hidden="true" /> Message sent
        </div>
        <h2 className="m-title">{mail.subject || "(no subject)"}</h2>
        <dl className="m-meta">
          <dt>To</dt>
          <dd>{mail.to}</dd>
          {mail.cc.trim() ? (
            <>
              <dt>Cc</dt>
              <dd>{mail.cc}</dd>
            </>
          ) : null}
          <dt>Date</dt>
          <dd>{mail.at.toLocaleString()}</dd>
        </dl>
        <div className="m-body m-pre">{mail.body}</div>
        {mail.attachments.length > 0 ? (
          <div className="m-atts">
            {mail.attachments.map((a, i) => (
              <div key={`${a.name}-${i}`} className="m-att" style={{ cursor: "default" }}>
                <AttIcon name={a.name} />
                <div>
                  <div className="n">{a.name}</div>
                  <div className="s">{formatSize(a.size)}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="m-bar foot">
          <span className="sp" />
          <Button onClick={composeAnother}>Compose another</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="m-root">
      <div className="m-form" style={{ maxWidth: 720 }}>
        <div className="m-field">
          <label htmlFor="mc-to">To</label>
          <Input
            id="mc-to"
            variant="borderless"
            value={to}
            disabled={disabled}
            placeholder="alice@example.com, bob@example.com"
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="m-field">
          <label htmlFor="mc-cc">Cc</label>
          <Input id="mc-cc" variant="borderless" value={cc} disabled={disabled} onChange={(e) => setCc(e.target.value)} />
        </div>
        <div className="m-field">
          <Input
            aria-label="Subject"
            variant="borderless"
            placeholder="Add a subject"
            value={subject}
            disabled={disabled}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="m-field body">
          <Input.TextArea
            aria-label="Body"
            variant="borderless"
            placeholder="Type your message"
            value={body}
            disabled={disabled}
            autoSize={{ minRows: 8, maxRows: 24 }}
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
          <div className="m-atts" style={{ marginTop: 4 }}>
            {attachments.map((att, i) => (
              <div key={`${att.name}-${i}`} className="m-att" style={{ cursor: "default" }}>
                <AttIcon name={att.name} />
                <div>
                  <div className="n">{att.name}</div>
                  <div className="s">{formatSize(att.bytes.length)}</div>
                </div>
                <Button
                  className="x"
                  type="text"
                  size="small"
                  aria-label={`Remove ${att.name}`}
                  icon={<DeleteOutlined aria-hidden="true" />}
                  disabled={disabled}
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                />
              </div>
            ))}
          </div>
        ) : null}
        {status.kind === "error" ? (
          <div className="m-error inline" role="alert">
            {status.message}
          </div>
        ) : null}
        <div className="m-bar foot">
          <Button
            icon={<PaperClipOutlined aria-hidden="true" />}
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            Attach
          </Button>
          <span className="sp" />
          {status.kind === "drafted" ? (
            <span className="m-ok-inline">
              Draft saved{" "}
              {status.webLink ? (
                <a href={status.webLink} target="_blank" rel="noopener noreferrer">
                  Open in Outlook
                </a>
              ) : null}
            </span>
          ) : null}
          <Button onClick={saveDraft} disabled={disabled} loading={status.kind === "busy" && status.what === "draft"}>
            Save draft
          </Button>
          <Button type="primary" icon={<SendOutlined aria-hidden="true" />} onClick={send} disabled={disabled} loading={status.kind === "busy" && status.what === "send"}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
