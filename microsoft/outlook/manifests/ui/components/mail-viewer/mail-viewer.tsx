// Renders one Outlook message (headers + body) fetched through the
// connector's Message.Get action. Graph returns structured JSON — no MIME
// walking needed. HTML bodies go through a strict allowlist sanitizer (no
// scripts/styles/frames, no event-handler attributes, no images,
// http(s)/mailto links only) so untrusted email markup can never reach the
// DOM with live handlers — inside the sandbox, window.tangram can invoke
// actions with the viewer's credentials. Plain-text bodies are linkified.
import { PaperClipOutlined, RollbackOutlined } from "@ant-design/icons";
import { Button, Skeleton, Spin } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/microsoft.css";
import "../../shared/tangram-buttons.css";

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

// Deterministic soft persona tint (background, initials color) per name.
const PERSONA_TINTS: [string, string][] = [
  ["#e9d7f4", "#5c2e91"], ["#d6e8fa", "#0f548c"], ["#dff6dd", "#0e700e"], ["#fde7e9", "#a4262c"],
  ["#fff4ce", "#835b00"], ["#fed9cc", "#8a3707"], ["#cdedf4", "#00666d"], ["#f7e3f5", "#8b1d7f"],
];
function personaTint(key: string): { background: string; color: string } {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const [background, color] = PERSONA_TINTS[h % PERSONA_TINTS.length];
  return { background, color };
}
function initials(name: string): string {
  const words = name.replace(/[<>"]/g, "").split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

// Office-style file badge by extension (Word/Excel/PowerPoint/PDF), else neutral.
function fileBadge(name: string): { label: string; color: string } {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (/^docx?$/.test(ext)) return { label: "W", color: "#185abd" };
  if (/^(xlsx?|csv)$/.test(ext)) return { label: "X", color: "#107c41" };
  if (/^pptx?$/.test(ext)) return { label: "P", color: "#c43e1c" };
  if (ext === "pdf") return { label: "PDF", color: "#c4314b" };
  return { label: ext && ext.length <= 3 && ext !== name.toLowerCase() ? ext.toUpperCase() : "", color: "#707070" };
}

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

  if (state === "loading")
    return (
      <div className="m-root m-pad">
        <Skeleton active />
      </div>
    );
  if (state === "error" || !msg)
    return (
      <div className="m-root">
        <div className="m-error" role="alert">
          <b>Couldn't load message</b>
          {error}
        </div>
      </div>
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
  const to = formatRecipients(msg.toRecipients);
  const fromName = msg.from?.emailAddress?.name ?? "";
  const fromAddress = msg.from?.emailAddress?.address ?? "";
  const fromLabel = fromName || fromAddress || "(unknown sender)";
  const persona = personaTint(fromAddress || fromName);

  return (
    <div className="m-root m-pad">
      <h2 className="m-title">{subject || "(no subject)"}</h2>
      <div className="m-sender">
        <div className="m-persona" style={persona} aria-hidden="true">
          {initials(fromLabel)}
        </div>
        <div className="m-from">
          <b>{fromLabel}</b>{" "}
          {fromName && fromAddress && fromName !== fromAddress ? (
            <span className="addr">&lt;{fromAddress}&gt;</span>
          ) : null}
          {to ? <div className="m-to">To: {to}</div> : null}
          {cc ? <div className="m-to">Cc: {cc}</div> : null}
        </div>
        <div className="m-date">{date}</div>
      </div>
      <div className="m-toolbar">
        <Button
          size="small"
          icon={<RollbackOutlined aria-hidden="true" />}
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
      {isHtml ? (
        <div className="m-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="m-body" style={{ whiteSpace: "pre-wrap" }}>
          {renderPlainText(text || msg.bodyPreview || "(empty body)")}
        </div>
      )}
      {attachments.length > 0 ? (
        <div className="m-atts">
          {attachments.map((att) => {
            const badge = fileBadge(att.name || "");
            const busy = downloading === att.id;
            return (
              <button
                key={att.id}
                type="button"
                className="m-att"
                disabled={busy}
                title={`Download ${att.name || "attachment"}`}
                onClick={() => download(att)}
              >
                {badge.label ? (
                  <span className="m-fileicon" style={{ background: badge.color }} aria-hidden="true">
                    {badge.label}
                  </span>
                ) : (
                  <PaperClipOutlined aria-hidden="true" style={{ fontSize: 16, color: "#616161" }} />
                )}
                <div>
                  <div className="n">{att.name || "attachment"}</div>
                  <div className="s">{busy ? "Downloading…" : formatSize(att.size ?? 0)}</div>
                </div>
                {busy ? <Spin size="small" className="x" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {attError || (error && state === "ready") ? (
        <div className="m-error inline" role="alert">
          {attError || error}
        </div>
      ) : null}
    </div>
  );
}
