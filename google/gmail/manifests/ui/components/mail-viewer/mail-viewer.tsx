// Renders one Gmail message (headers + body) fetched through the connector's
// Message.Get action. Prefers the text/html part rendered through a strict
// allowlist sanitizer (no scripts/styles/frames, no event-handler attributes,
// no images, http(s)/mailto links only) so untrusted email markup can never
// reach the DOM with live handlers — inside the sandbox, window.tangram can
// invoke actions with the viewer's credentials. Falls back to linkified
// text/plain.
import { PaperClipOutlined } from "@ant-design/icons";
import { Alert, Button, Divider, Skeleton, Space, Typography } from "antd";
import React, { useCallback, useEffect, useState } from "react";

const tangram = (window as any).tangram;

type GmailPayload = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayload[];
};

type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
  internalDate?: string;
};

function decodeB64UrlBytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function decodeB64Url(data: string): string {
  return new TextDecoder("utf-8").decode(decodeB64UrlBytes(data));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// ── body extraction ──────────────────────────────────────────────────────────
function findPart(payload: GmailPayload, mime: string): GmailPayload | undefined {
  const flat: GmailPayload[] = [];
  const walk = (p: GmailPayload) => {
    flat.push(p);
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  return flat.find((p) => p.mimeType === mime && p.body?.data);
}

type AttachmentRef = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
};

function extractAttachments(payload?: GmailPayload): AttachmentRef[] {
  if (!payload) return [];
  const out: AttachmentRef[] = [];
  const walk = (p: GmailPayload & { filename?: string; body?: { attachmentId?: string; size?: number } }) => {
    if (p.filename && (p.body as any)?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body?.size ?? 0,
        attachmentId: (p.body as any).attachmentId,
      });
    }
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  return out;
}

function extractBody(payload?: GmailPayload): { html?: string; text?: string } {
  if (!payload) return {};
  const html = findPart(payload, "text/html");
  if (html) return { html: sanitizeHtml(decodeB64Url(html.body!.data!)) };
  const plain = findPart(payload, "text/plain");
  if (plain) return { text: decodeB64Url(plain.body!.data!).replace(/\n{3,}/g, "\n\n") };
  return {};
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

function header(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
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
  const [msg, setMsg] = useState<GmailMessage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [downloading, setDownloading] = useState<string>("");

  const load = useCallback((inputs: Record<string, unknown>) => {
    const messageId = String(inputs?.messageId ?? "").trim();
    if (!messageId) {
      setState("error");
      setError("No messageId input provided.");
      return;
    }
    setState("loading");
    tangram
      .performAction({ resourceType: "Message", action: "Get" }, { parameters: { id: messageId, format: "full" } })
      .then((m: GmailMessage) => {
        setMsg(m);
        setState("ready");
      })
      .catch((e: unknown) => {
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

  const date = msg.internalDate
    ? new Date(Number(msg.internalDate)).toLocaleString()
    : header(msg, "Date");
  const body = extractBody(msg.payload);
  const attachments = extractAttachments(msg.payload);

  function download(att: AttachmentRef) {
    setDownloading(att.attachmentId);
    setError("");
    tangram
      .performAction({ resourceType: "Attachment", action: "Get" }, {
        parameters: { messageId: msg!.id, id: att.attachmentId },
      })
      .then((r: { data?: string }) => {
        if (!r?.data) throw new Error("Attachment has no content.");
        const blob = new Blob([decodeB64UrlBytes(r.data)], { type: att.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = att.filename;
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
  const metaRows: [string, string][] = [
    ["From", header(msg, "From")],
    ["To", header(msg, "To")],
    ...(header(msg, "Cc") ? ([["Cc", header(msg, "Cc")]] as [string, string][]) : []),
    ["Date", date],
  ];

  return (
    <div style={{ padding: 16, fontSize: 14, fontFamily: FONT_STACK, color: "rgba(0,0,0,0.88)" }}>
      <style>{BODY_CSS}</style>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {header(msg, "Subject") || "(no subject)"}
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
      {body.html ? (
        <div className="mail-body" dangerouslySetInnerHTML={{ __html: body.html }} />
      ) : (
        <div className="mail-body" style={{ whiteSpace: "pre-wrap" }}>
          {renderPlainText(body.text || msg.snippet || "(empty body)")}
        </div>
      )}
      {attachments.length > 0 ? (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Space direction="vertical" size={4}>
            {attachments.map((att) => (
              <Button
                key={att.attachmentId}
                size="small"
                icon={<PaperClipOutlined />}
                loading={downloading === att.attachmentId}
                onClick={() => download(att)}
              >
                {att.filename} ({formatSize(att.size)})
              </Button>
            ))}
          </Space>
          {error ? (
            <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />
          ) : null}
        </>
      ) : null}
      <Divider style={{ margin: "12px 0" }} />
      <Button
        size="small"
        onClick={() =>
          tangram.emit("reply", {
            to: header(msg, "Reply-To") || header(msg, "From"),
            subject: /^re:/i.test(header(msg, "Subject"))
              ? header(msg, "Subject")
              : `Re: ${header(msg, "Subject")}`,
            threadId: msg.threadId ?? "",
          })
        }
      >
        Reply
      </Button>
    </div>
  );
}
