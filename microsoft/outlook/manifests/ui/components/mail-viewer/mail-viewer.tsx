// Renders one Outlook message (headers + body) fetched through the
// connector's Message.Get action. Graph returns structured JSON — no MIME
// walking needed. HTML bodies go through a strict allowlist sanitizer (no
// scripts/styles/frames, no event-handler attributes, no images,
// http(s)/mailto links only) so untrusted email markup can never reach the
// DOM with live handlers — inside the sandbox, window.tangram can invoke
// actions with the viewer's credentials. Plain-text bodies are linkified.
import { PaperClipOutlined } from "@ant-design/icons";
import { Alert, Button, Divider, Skeleton, Space, Typography } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";

const tangram = (window as any).tangram;

type Recipient = { emailAddress?: { address?: string; name?: string } };

type GraphMessage = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  hasAttachments?: boolean;
  conversationId?: string;
  webLink?: string;
};

type GraphAttachment = {
  id: string;
  "@odata.type"?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
};

// Graph contentBytes is standard base64 (unlike Gmail's base64url).
function decodeB64Bytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAddress(r?: Recipient): string {
  const address = r?.emailAddress?.address ?? "";
  const name = r?.emailAddress?.name ?? "";
  if (name && name !== address) return address ? `${name} <${address}>` : name;
  return address;
}

function formatRecipients(list?: Recipient[]): string {
  return (list ?? []).map(formatAddress).filter(Boolean).join(", ");
}

// ── HTML sanitizer ───────────────────────────────────────────────────────────
// Allowlist clone: only these tags survive as elements; everything in DROP is
// removed subtree-and-all; unknown tags are unwrapped (children survive).
const ALLOWED = new Set([
  "a", "p", "div", "span", "br", "hr", "b", "strong", "i", "em", "u", "s",
  "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "pre", "code",
  "sup", "sub", "small", "center",
]);
const DROP = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "select", "textarea", "link", "meta", "base", "svg", "math", "template",
  "audio", "video", "img", "picture", "source",
]);

function sanitizeInto(source: Node, target: HTMLElement, doc: Document): void {
  source.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.textContent ?? ""));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return;
    if (!ALLOWED.has(tag)) {
      // Unwrap unknown tags: keep their content, lose the element.
      sanitizeInto(el, target, doc);
      return;
    }
    const clone = doc.createElement(tag);
    if (tag === "a") {
      const href = (el.getAttribute("href") ?? "").trim();
      if (/^(https?:|mailto:)/i.test(href)) {
        clone.setAttribute("href", href);
        clone.setAttribute("target", "_blank");
        clone.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (tag === "td" || tag === "th") {
      for (const attr of ["colspan", "rowspan"]) {
        const v = el.getAttribute(attr);
        if (v && /^\d+$/.test(v)) clone.setAttribute(attr, v);
      }
    }
    sanitizeInto(el, clone, doc);
    target.appendChild(clone);
  });
}

function sanitizeHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out = document.implementation.createHTMLDocument("");
  const container = out.createElement("div");
  sanitizeInto(parsed.body, container, out);
  return container.innerHTML;
}

// Linkify bare URLs in a plain-text body without innerHTML.
function renderPlainText(text: string): React.ReactNode[] {
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  return text.split(urlRe).map((chunk, i) =>
    urlRe.test(chunk) ? (
      <a key={i} href={chunk} target="_blank" rel="noopener noreferrer">
        {chunk}
      </a>
    ) : (
      <React.Fragment key={i}>{chunk}</React.Fragment>
    ),
  );
}

// antd's default font token stack; plain elements inside the sandbox iframe
// would otherwise fall back to the browser's serif default.
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, ' +
  '"Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

// Our own presentation styles for the sanitized body (email styles are gone).
const BODY_CSS = `
.mail-body { line-height: 1.55; word-break: break-word; }
.mail-body a { color: #1677ff; text-decoration: none; }
.mail-body a:hover { text-decoration: underline; }
.mail-body p, .mail-body div { margin: 0 0 0.6em; }
.mail-body ul, .mail-body ol { margin: 0.4em 0 0.8em; padding-left: 1.4em; }
.mail-body li { margin-bottom: 0.25em; }
.mail-body blockquote { margin: 0.6em 0; padding: 0.2em 0 0.2em 0.9em; border-left: 3px solid #d9d9d9; color: #666; }
.mail-body table { border-collapse: collapse; max-width: 100%; }
.mail-body td, .mail-body th { padding: 4px 8px; vertical-align: top; }
.mail-body pre, .mail-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mail-body pre { background: #fafafa; padding: 8px; border-radius: 4px; overflow-x: auto; }
.mail-body h1, .mail-body h2, .mail-body h3 { font-size: 1.1em; margin: 0.8em 0 0.4em; }
`;

export default function MailViewer() {
  const [msg, setMsg] = useState<GraphMessage | null>(null);
  const [attachments, setAttachments] = useState<GraphAttachment[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [attError, setAttError] = useState<string>("");
  const [downloading, setDownloading] = useState<string>("");

  // Two-stage fetch (message, then its attachments) — a stale continuation
  // from a superseded messageId must not overwrite the newer message or
  // attach the wrong list.
  const loadSeq = useRef(0);
  const load = useCallback((inputs: Record<string, unknown>) => {
    const messageId = String(inputs?.messageId ?? "").trim();
    const seq = ++loadSeq.current;
    if (!messageId) {
      setState("error");
      setError("No messageId input provided.");
      return;
    }
    setState("loading");
    setAttachments([]);
    setAttError("");
    tangram
      .performAction({ resourceType: "Message", action: "Get" }, { parameters: { messageId } })
      .then((m: GraphMessage) => {
        if (seq !== loadSeq.current) return;
        setMsg(m);
        setState("ready");
        if (!m?.hasAttachments) return;
        // Attachment metadata loads after the message; failures surface in
        // the attachment section without breaking the body view.
        tangram
          .performAction(
            { resourceType: "Attachment", action: "List" },
            { parameters: { messageId, $select: "id,name,contentType,size,isInline" } },
          )
          .then((r: { value?: GraphAttachment[] }) => {
            if (seq !== loadSeq.current) return;
            setAttachments(
              (r?.value ?? []).filter((a) =>
                (a["@odata.type"] ?? "").endsWith("fileAttachment"),
              ),
            );
          })
          .catch((e: unknown) => {
            if (seq !== loadSeq.current) return;
            setAttError(e instanceof Error ? e.message : String(e));
          });
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    load(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => load(inputs ?? {}));
  }, [load]);

  if (state === "loading") return <Skeleton active style={{ padding: 16 }} />;
  if (state === "error" || !msg)
    return (
      <Alert
        type="error"
        showIcon
        message="Couldn't load message"
        description={error}
        style={{ margin: 16 }}
      />
    );

  const date = msg.receivedDateTime
    ? new Date(msg.receivedDateTime).toLocaleString()
    : "";
  const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html";
  const html = isHtml ? sanitizeHtml(msg.body?.content ?? "") : "";
  const text = !isHtml
    ? (msg.body?.content ?? "").replace(/\n{3,}/g, "\n\n")
    : "";
  const subject = msg.subject ?? "";

  function download(att: GraphAttachment) {
    setDownloading(att.id);
    setError("");
    tangram
      .performAction({ resourceType: "Attachment", action: "Get" }, {
        parameters: { messageId: msg!.id, attachmentId: att.id },
      })
      .then((r: { contentBytes?: string }) => {
        if (!r?.contentBytes) throw new Error("Attachment has no content.");
        const blob = new Blob([decodeB64Bytes(r.contentBytes)], {
          type: att.contentType || "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = att.name || "attachment";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setDownloading("");
      })
      .catch((e: unknown) => {
        setDownloading("");
        setError(e instanceof Error ? e.message : String(e));
      });
  }
  const cc = formatRecipients(msg.ccRecipients);
  const metaRows: [string, string][] = [
    ["From", formatAddress(msg.from)],
    ["To", formatRecipients(msg.toRecipients)],
    ...(cc ? ([["Cc", cc]] as [string, string][]) : []),
    ["Date", date],
  ];

  return (
    <div style={{ padding: 16, fontSize: 14, fontFamily: FONT_STACK, color: "rgba(0,0,0,0.88)" }}>
      <style>{BODY_CSS}</style>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {subject || "(no subject)"}
      </Typography.Title>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 2 }}>
        {metaRows.map(([label, value]) => (
          <React.Fragment key={label}>
            <Typography.Text type="secondary">{label}</Typography.Text>
            <Typography.Text>{value}</Typography.Text>
          </React.Fragment>
        ))}
      </div>
      <Divider style={{ margin: "12px 0" }} />
      {isHtml ? (
        <div className="mail-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="mail-body" style={{ whiteSpace: "pre-wrap" }}>
          {renderPlainText(text || msg.bodyPreview || "(empty body)")}
        </div>
      )}
      {attachments.length > 0 ? (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={4}>
            {attachments.map((att) => (
              <Button
                key={att.id}
                size="small"
                icon={<PaperClipOutlined />}
                loading={downloading === att.id}
                onClick={() => download(att)}
              >
                {att.name || "attachment"} ({formatSize(att.size ?? 0)})
              </Button>
            ))}
          </Space>
        </>
      ) : null}
      {attError || (error && state === "ready") ? (
        <Alert type="error" showIcon message={attError || error} style={{ marginTop: 8 }} />
      ) : null}
      <Divider style={{ margin: "12px 0" }} />
      <Button
        size="small"
        onClick={() =>
          tangram.emit("reply", {
            to: msg.from?.emailAddress?.address ?? "",
            subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
            conversationId: msg.conversationId ?? "",
          })
        }
      >
        Reply
      </Button>
    </div>
  );
}
