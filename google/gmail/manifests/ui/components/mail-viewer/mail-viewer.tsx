// Renders one Gmail message (headers + body) fetched through the connector's
// Message.Get action. Prefers the text/html part rendered through a strict
// allowlist sanitizer (no scripts/styles/frames or event-handler attributes).
// Referenced cid: raster images are resolved through Attachment.Get after
// signature/size/dimension checks; remote/data/SVG images remain blocked so
// untrusted email markup cannot track the reader or reach connector actions.
import { LoadingOutlined, RollbackOutlined } from "@ant-design/icons";
import { Button, Skeleton } from "antd";
import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import "../../shared/google.css";
import "../../shared/tangram-buttons.css";
import { onNewInputs } from "../../shared/sandbox-inputs";

const tangram = (window as any).tangram;

const ALLOWED_INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 15 * 1024 * 1024;
const MAX_INLINE_IMAGES = 20;
const MAX_INLINE_IMAGE_DIMENSION = 4096;
const MAX_INLINE_IMAGE_PIXELS = 16 * 1024 * 1024;

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

function decodeB64Url(data: string, charset = "utf-8"): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    // Unknown/unsupported charset label: fall back to UTF-8.
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(decodeB64UrlBytes(data));
}

function encodeB64Bytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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
  "a",
  "p",
  "div",
  "span",
  "br",
  "hr",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "pre",
  "code",
  "sup",
  "sub",
  "small",
  "center",
]);
const DROP = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "link",
  "meta",
  "base",
  "svg",
  "math",
  "template",
  "audio",
  "video",
  "picture",
  "source",
]);

function normalizeCid(value: string): string | undefined {
  let cid = value.trim().replace(/^cid:/i, "").trim();
  try {
    cid = decodeURIComponent(cid);
  } catch {
    return undefined;
  }
  cid = cid.replace(/^<|>$/g, "").trim().toLowerCase();
  if (!cid || cid.length > 512 || /[\u0000-\u001f\u007f]/.test(cid))
    return undefined;
  return cid;
}

function sanitizeInto(source: Node, target: HTMLElement, doc: Document): void {
  source.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.textContent ?? ""));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const src = (el.getAttribute("src") ?? "").trim();
      const cid = /^cid:/i.test(src) ? normalizeCid(src) : undefined;
      if (cid) {
        const clone = doc.createElement("img");
        clone.setAttribute("data-tangram-cid", cid);
        clone.setAttribute("loading", "lazy");
        const alt = (el.getAttribute("alt") ?? "").slice(0, 500);
        if (alt) clone.setAttribute("alt", alt);
        target.appendChild(clone);
      }
      return;
    }
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
function findPart(
  payload: GmailPayload,
  mime: string,
): GmailPayload | undefined {
  const flat: GmailPayload[] = [];
  const walk = (p: GmailPayload) => {
    // Attachments and forwarded messages aren't this message's body.
    if (p.filename || /^\s*attachment/i.test(partHeader(p, "Content-Disposition"))) return;
    if (p !== payload && (p.mimeType ?? "").toLowerCase() === "message/rfc822") return;
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

type InlineImageRef = {
  cid: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  data?: string;
};

function partHeader(part: GmailPayload, name: string): string {
  return (
    part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function extractInlineImages(
  payload?: GmailPayload,
): Map<string, InlineImageRef> {
  const out = new Map<string, InlineImageRef>();
  const walk = (part: GmailPayload) => {
    const cid = normalizeCid(partHeader(part, "Content-ID"));
    const mimeType = (part.mimeType ?? "")
      .toLowerCase()
      .split(";", 1)[0]
      .trim();
    if (cid && ALLOWED_INLINE_IMAGE_TYPES.has(mimeType) && !out.has(cid)) {
      out.set(cid, {
        cid,
        mimeType,
        size: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId,
        data: part.body?.data,
      });
    }
    (part.parts ?? []).forEach(walk);
  };
  if (payload) walk(payload);
  return out;
}

function extractAttachments(payload?: GmailPayload): AttachmentRef[] {
  if (!payload) return [];
  const out: AttachmentRef[] = [];
  const walk = (
    p: GmailPayload & {
      filename?: string;
      body?: { attachmentId?: string; size?: number };
    },
  ) => {
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

// Charset from the part's Content-Type header (UTF-8 when absent).
function partCharset(part: GmailPayload): string {
  const m = partHeader(part, "Content-Type").match(/charset\s*=\s*"?([^";\s]+)/i);
  return m ? m[1] : "utf-8";
}

function extractBody(payload?: GmailPayload): { html?: string; text?: string } {
  if (!payload) return {};
  const html = findPart(payload, "text/html");
  if (html) return { html: sanitizeHtml(decodeB64Url(html.body!.data!, partCharset(html))) };
  const plain = findPart(payload, "text/plain");
  if (plain)
    return {
      text: decodeB64Url(plain.body!.data!, partCharset(plain)).replace(/\n{3,}/g, "\n\n"),
    };
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

function hasRasterSignature(bytes: Uint8Array, mimeType: string): boolean {
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  switch (mimeType) {
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/jpeg":
      return (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );
    case "image/gif":
      return (
        bytes.length >= 6 &&
        (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")
      );
    case "image/webp":
      return (
        bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
      );
    default:
      return false;
  }
}

type RasterDimensions = { width: number; height: number };

function rasterDimensions(
  bytes: Uint8Array,
  mimeType: string,
): RasterDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png" && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    const sofMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
      0xcf,
    ]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return undefined;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length)
        return undefined;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length)
        return undefined;
      if (sofMarkers.has(marker)) {
        if (segmentLength < 7) return undefined;
        return {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
      }
      offset += segmentLength;
    }
    return undefined;
  }
  if (mimeType === "image/webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { width, height };
    }
    if (
      chunk === "VP8 " &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      const height =
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      return { width, height };
    }
  }
  return undefined;
}

function safeDimensions(dimensions: RasterDimensions | undefined): boolean {
  return Boolean(
    dimensions &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= MAX_INLINE_IMAGE_DIMENSION &&
    dimensions.height <= MAX_INLINE_IMAGE_DIMENSION &&
    dimensions.width * dimensions.height <= MAX_INLINE_IMAGE_PIXELS,
  );
}

async function validateRasterDimensions(blob: Blob): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(blob);
    const valid = safeDimensions({
      width: bitmap.width,
      height: bitmap.height,
    });
    bitmap.close();
    return valid;
  } catch {
    return false;
  }
}

function resolveInlineImageHtml(
  html: string,
  sources: Map<string, string>,
): string {
  if (sources.size === 0) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed
    .querySelectorAll<HTMLImageElement>("img[data-tangram-cid]")
    .forEach((img) => {
      const cid = img.getAttribute("data-tangram-cid") ?? "";
      const source = sources.get(cid);
      if (source) img.setAttribute("src", source);
    });
  return parsed.body.innerHTML;
}

function MessageBody({
  messageId,
  payload,
  snippet,
}: {
  messageId: string;
  payload?: GmailPayload;
  snippet?: string;
}) {
  const body = useMemo(() => extractBody(payload), [payload]);
  const [inlineSources, setInlineSources] = useState<Map<string, string>>(
    new Map(),
  );
  const [blockedImages, setBlockedImages] = useState(0);

  useEffect(() => {
    let active = true;
    setInlineSources(new Map());
    setBlockedImages(0);

    if (!body.html)
      return () => {
        active = false;
      };
    const parsed = new DOMParser().parseFromString(body.html, "text/html");
    const requested = Array.from(
      parsed.querySelectorAll<HTMLImageElement>("img[data-tangram-cid]"),
    )
      .map((img) => img.getAttribute("data-tangram-cid") ?? "")
      .filter((cid, index, all) => cid && all.indexOf(cid) === index);
    const parts = extractInlineImages(payload);

    void (async () => {
      const sources = new Map<string, string>();
      let totalBytes = 0;
      let blocked = Math.max(0, requested.length - MAX_INLINE_IMAGES);
      for (const cid of requested.slice(0, MAX_INLINE_IMAGES)) {
        const part = parts.get(cid);
        if (
          !part ||
          (!part.data && !part.attachmentId) ||
          part.size > MAX_INLINE_IMAGE_BYTES
        ) {
          blocked += 1;
          continue;
        }
        try {
          const data = part.data
            ? part.data
            : (
                await tangram.performAction(
                  { resourceType: "Attachment", action: "Get" },
                  { parameters: { messageId, attachmentId: part.attachmentId } },
                )
              )?.data;
          if (!data) throw new Error("Inline image has no content");
          const encoded = String(data);
          if (encoded.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 4) {
            throw new Error("Inline image exceeds the encoded size limit");
          }
          const bytes = decodeB64UrlBytes(encoded);
          if (
            bytes.length > MAX_INLINE_IMAGE_BYTES ||
            totalBytes + bytes.length > MAX_INLINE_IMAGE_TOTAL_BYTES ||
            !hasRasterSignature(bytes, part.mimeType) ||
            !safeDimensions(rasterDimensions(bytes, part.mimeType))
          ) {
            throw new Error("Inline image failed validation");
          }
          const blob = new Blob([bytes], { type: part.mimeType });
          if (!(await validateRasterDimensions(blob)))
            throw new Error("Inline image dimensions are unsafe");
          totalBytes += bytes.length;
          sources.set(
            cid,
            `data:${part.mimeType};base64,${encodeB64Bytes(bytes)}`,
          );
        } catch {
          blocked += 1;
        }
      }
      if (active) {
        setInlineSources(sources);
        setBlockedImages(blocked);
      }
    })();

    return () => {
      active = false;
    };
  }, [body.html, messageId, payload]);

  if (!body.html) {
    return (
      <div className="mail-body" style={{ whiteSpace: "pre-wrap" }}>
        {renderPlainText(body.text || snippet || "(empty body)")}
      </div>
    );
  }

  return (
    <>
      <div
        className="mail-body"
        dangerouslySetInnerHTML={{
          __html: resolveInlineImageHtml(body.html, inlineSources),
        }}
      />
      {blockedImages > 0 ? (
        <div className="g-faint" style={{ marginTop: 8 }}>
          {blockedImages} inline{" "}
          {blockedImages === 1 ? "image was" : "images were"} blocked.
        </div>
      ) : null}
    </>
  );
}

function header(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
  );
}

// Our own presentation styles for the sanitized body (email styles are gone).
const BODY_CSS = `
.mail-body { line-height: 1.55; word-break: break-word; }
.mail-body p, .mail-body div { margin: 0 0 0.6em; }
.mail-body ul, .mail-body ol { margin: 0.4em 0 0.8em; padding-left: 1.4em; }
.mail-body li { margin-bottom: 0.25em; }
.mail-body blockquote { margin: 0.6em 0; padding: 0.2em 0 0.2em 0.9em; border-left: 3px solid #dadce0; color: #5e5e5e; }
.mail-body table { border-collapse: collapse; max-width: 100%; }
.mail-body td, .mail-body th { padding: 4px 8px; vertical-align: top; }
.mail-body pre, .mail-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mail-body pre { background: #f8fafd; padding: 8px; border-radius: 4px; overflow-x: auto; }
.mail-body h1, .mail-body h2, .mail-body h3 { font-size: 1.1em; margin: 0.8em 0 0.4em; }
.mail-body img[data-tangram-cid] { display: none; }
.mail-body img[data-tangram-cid][src^="data:image/"] { display: inline-block; max-width: 100%; height: auto; }
`;

const AVATAR_COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#7b1fa2", "#00897b", "#c2185b", "#5e35b1", "#3949ab", "#6d4c41"];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// "Ana Lopez <ana@acme.com>" → { name, addr }.
function parseAddress(value: string): { name: string; addr: string } {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), addr: m[2].trim() };
  return { name: value.trim(), addr: "" };
}

// Display names of a recipient header, for Gmail's "to Ana, Ben" line.
function recipientNames(value: string): string {
  return (value.match(/(?:[^,"]|"[^"]*")+/g) ?? [])
    .map((part) => {
      const { name, addr } = parseAddress(part);
      const n = name || addr;
      return n.includes("@") ? n.split("@")[0] : n.split(/\s+/)[0];
    })
    .filter(Boolean)
    .join(", ");
}

function relativeAge(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  return "";
}

const SYSTEM_LABELS: [string, string][] = [
  ["INBOX", "Inbox"],
  ["SENT", "Sent"],
  ["DRAFT", "Draft"],
  ["SPAM", "Spam"],
  ["TRASH", "Trash"],
];

// Typed, colored badge for an attachment (Drive-style file icon).
function fileBadge(name: string, mime: string): { label: string; color: string } {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (mime === "application/pdf" || ext === "pdf") return { label: "PDF", color: "#d93025" };
  if (mime.startsWith("image/")) return { label: "IMG", color: "#d93025" };
  if (/sheet|excel|csv/.test(mime) || /^(xlsx?|csv)$/.test(ext)) return { label: "XLS", color: "#188038" };
  if (/presentation|powerpoint/.test(mime) || /^pptx?$/.test(ext)) return { label: "PPT", color: "#f4b400" };
  if (/word|document/.test(mime) || /^docx?$/.test(ext)) return { label: "DOC", color: "#4285f4" };
  if (/zip|compressed|tar/.test(mime)) return { label: "ZIP", color: "#5f6368" };
  return { label: (ext || "file").slice(0, 3).toUpperCase(), color: "#5f6368" };
}

export default function MailViewer() {
  const retry = useRef<(() => void) | null>(null);
  const [msg, setMsg] = useState<GmailMessage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [downloading, setDownloading] = useState<string>("");
  const [showDetails, setShowDetails] = useState(false);

  const load = useCallback((inputs: Record<string, unknown>) => {
    const messageId = String(inputs?.messageId ?? "").trim();
    if (!messageId) {
      setState("error");
      setError("No messageId input provided.");
      return;
    }
    setState("loading");
    tangram
      .performAction(
        { resourceType: "Message", action: "Get" },
        { parameters: { id: messageId, format: "full" } },
      )
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
    // Retry re-runs the last inputs: identical input replays are ignored, so they can't recover a failed load.
    onNewInputs((inputs) => {
      retry.current = () => load(inputs);
      load(inputs);
    });
  }, [load]);

  if (state === "loading")
    return (
      <div className="g-root g-pad">
        <Skeleton active avatar />
      </div>
    );
  if (state === "error" || !msg)
    return (
      <div className="g-root">
        <div className="g-error">
          <b>Couldn't load message</b>
          {error ? <div>{error}</div> : null}
          <div style={{ marginTop: 8 }}>
            <Button size="small" onClick={() => retry.current?.()}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );

  const sentAt = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
  const date = sentAt ? sentAt.toLocaleString() : header(msg, "Date");
  const age = sentAt ? relativeAge(sentAt) : "";
  const attachments = extractAttachments(msg.payload);
  const from = parseAddress(header(msg, "From"));
  const label = SYSTEM_LABELS.find(([id]) => msg.labelIds?.includes(id))?.[1];
  const toNames = recipientNames([header(msg, "To"), header(msg, "Cc")].filter(Boolean).join(", "));

  function download(att: AttachmentRef) {
    setDownloading(att.attachmentId);
    setError("");
    tangram
      .performAction(
        { resourceType: "Attachment", action: "Get" },
        {
          parameters: { messageId: msg!.id, attachmentId: att.attachmentId },
        },
      )
      .then((r: { data?: string }) => {
        if (!r?.data) throw new Error("Attachment has no content.");
        const blob = new Blob([decodeB64UrlBytes(r.data)], {
          type: att.mimeType,
        });
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
    ["from", header(msg, "From")],
    ["to", header(msg, "To")],
    ...(header(msg, "Cc")
      ? ([["cc", header(msg, "Cc")]] as [string, string][])
      : []),
    ["date", date],
    ["subject", header(msg, "Subject")],
  ];

  return (
    <div className="g-root g-pad">
      <style>{BODY_CSS}</style>
      <h2 className="g-title" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {header(msg, "Subject") || "(no subject)"}
        {label ? <span className="g-label">{label}</span> : null}
      </h2>
      <div className="g-sender">
        <div className="g-avatar" style={{ background: avatarColor(from.addr || from.name) }} aria-hidden="true">
          {(from.name || "?").replace(/^[^A-Za-z0-9]+/, "").charAt(0).toUpperCase() || "?"}
        </div>
        <div className="g-from">
          <b>{from.name || "(unknown sender)"}</b>{" "}
          {from.addr ? <span className="addr">&lt;{from.addr}&gt;</span> : null}
          <div className="g-to">
            to {toNames || "(no recipients)"}
            <button type="button" aria-expanded={showDetails} aria-label="Show details" onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? "▴" : "▾"}
            </button>
          </div>
        </div>
        <div className="g-date">
          {date}
          {age ? ` (${age})` : ""}
        </div>
      </div>
      <div className="g-indent">
        {showDetails ? (
          <div className="g-meta">
            {metaRows.map(([k, v]) => (
              <React.Fragment key={k}>
                <span>{k}:</span>
                <span>{v}</span>
              </React.Fragment>
            ))}
          </div>
        ) : null}
        <div style={{ marginTop: 16 }}>
          <MessageBody messageId={msg.id} payload={msg.payload} snippet={msg.snippet} />
        </div>
        {attachments.length > 0 ? (
          <>
            <div className="g-atts">
              {attachments.map((att) => {
                const badge = fileBadge(att.filename, att.mimeType);
                const busy = downloading === att.attachmentId;
                return (
                  <button
                    type="button"
                    key={att.attachmentId}
                    className="g-chip"
                    disabled={busy}
                    title={`Download ${att.filename}`}
                    onClick={() => download(att)}
                  >
                    <span className="g-fileicon" style={{ background: badge.color }} aria-hidden="true">
                      {busy ? <LoadingOutlined /> : badge.label}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <div className="n">{att.filename}</div>
                      <div className="s">{busy ? "Downloading…" : formatSize(att.size)}</div>
                    </span>
                  </button>
                );
              })}
            </div>
            {error ? <div className="g-error inline">{error}</div> : null}
          </>
        ) : null}
        <div className="g-actions">
          <Button
            icon={<RollbackOutlined aria-hidden="true" />}
            onClick={() =>
              tangram.emit("reply", {
                to: header(msg, "Reply-To") || header(msg, "From"),
                subject: /^re:/i.test(header(msg, "Subject"))
                  ? header(msg, "Subject")
                  : `Re: ${header(msg, "Subject")}`,
                threadId: msg.threadId ?? "",
                inReplyTo: header(msg, "Message-ID") || header(msg, "Message-Id"),
                references: [header(msg, "References"), header(msg, "Message-ID") || header(msg, "Message-Id")]
                  .filter(Boolean)
                  .join(" "),
              })
            }
          >
            Reply
          </Button>
        </div>
      </div>
    </div>
  );
}
