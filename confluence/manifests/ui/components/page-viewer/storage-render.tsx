// Confluence storage format (XHTML + ac:/ri: macros) → React, without ever
// injecting HTML: the source is parsed with DOMParser and walked; only
// allowlisted tags become elements (links/images http(s) only, no attributes
// beyond href/src/alt/colspan/rowspan), Confluence macros degrade to readable
// equivalents (code → <pre>, info/note/warning/tip → callout panels, links →
// their text), and anything else contributes only its text — except
// script-like tags, which are dropped entirely.
import React from "react";

const tangram = (window as any).tangram;

// External links relay through the host (the sandbox can't open popups).
export function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  if (tangram?.openUrl) tangram.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

const SIMPLE = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "del",
  "code", "pre", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "br", "hr", "span", "div",
  "sub", "sup",
]);
const VOID = new Set(["br", "hr"]);
const DROP = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form", "input", "button",
  "textarea", "select", "link", "meta", "head", "title", "ac:parameter",
]);
const PANELS: Record<string, { cls: string; icon: string }> = {
  info: { cls: "", icon: "ℹ" },
  panel: { cls: "", icon: "ℹ" },
  note: { cls: "note", icon: "✎" },
  warning: { cls: "warning", icon: "⚠" },
  tip: { cls: "success", icon: "✓" },
};

const httpUrl = (u: string | null) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

function child(el: Element, tag: string): Element | undefined {
  return Array.from(el.children).find((c) => c.tagName.toLowerCase() === tag);
}

function param(el: Element, name: string): string {
  const p = Array.from(el.children).find(
    (c) => c.tagName.toLowerCase() === "ac:parameter" && c.getAttribute("ac:name") === name,
  );
  return p?.textContent?.trim() ?? "";
}

function kids(el: Element, key: string): React.ReactNode[] {
  return Array.from(el.childNodes).map((n, i) => walk(n, `${key}.${i}`));
}

function macro(el: Element, key: string): React.ReactNode {
  const name = (el.getAttribute("ac:name") ?? "").toLowerCase();
  const rich = child(el, "ac:rich-text-body");
  const plain = child(el, "ac:plain-text-body");
  if (name === "code" || name === "noformat") {
    return (
      <pre key={key}>
        <code>{plain?.textContent ?? rich?.textContent ?? ""}</code>
      </pre>
    );
  }
  const panel = PANELS[name];
  if (panel) {
    const title = param(el, "title");
    return (
      <div key={key} className={`a-panel ${panel.cls}`}>
        <span className="ic" aria-hidden="true">
          {panel.icon}
        </span>
        <div style={{ minWidth: 0 }}>
          {title ? <strong>{title}</strong> : null}
          {rich ? kids(rich, key) : null}
        </div>
      </div>
    );
  }
  if (name === "expand") {
    return (
      <div key={key}>
        <strong>{param(el, "title") || "Expand"}</strong>
        {rich ? kids(rich, key) : null}
      </div>
    );
  }
  if (rich) return <div key={key}>{kids(rich, key)}</div>;
  if (plain) return <pre key={key}>{plain.textContent}</pre>;
  return (
    <span key={key} className="a-macro">
      {name || "macro"}
    </span>
  );
}

function confluenceLink(el: Element, key: string): React.ReactNode {
  const body = child(el, "ac:link-body") ?? child(el, "ac:plain-text-link-body");
  const page = child(el, "ri:page");
  const user = child(el, "ri:user");
  const url = child(el, "ri:url");
  const text =
    body?.textContent?.trim() ||
    page?.getAttribute("ri:content-title") ||
    (user ? "@user" : "") ||
    url?.getAttribute("ri:value") ||
    "link";
  const href = httpUrl(url?.getAttribute("ri:value") ?? null);
  return href ? link(key, href, text) : <strong key={key}>{text}</strong>;
}

function link(key: string, href: string, content: React.ReactNode): React.ReactNode {
  return (
    <a
      key={key}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
    >
      {content}
    </a>
  );
}

function walk(node: Node, key: string): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag)) return null;
  switch (tag) {
    case "ac:structured-macro":
    case "ac:macro":
      return macro(el, key);
    case "ac:link":
      return confluenceLink(el, key);
    case "ac:image": {
      const src = httpUrl(child(el, "ri:url")?.getAttribute("ri:value") ?? null);
      return src ? <img key={key} src={src} alt={el.getAttribute("ac:alt") ?? ""} /> : <span key={key} className="a-macro">image</span>;
    }
    case "ac:emoticon":
      return el.getAttribute("ac:emoji-fallback") ?? `:${el.getAttribute("ac:name") ?? ""}:`;
    case "ac:task-list":
      return (
        <ul key={key} style={{ listStyle: "none", paddingLeft: 4 }}>
          {Array.from(el.children)
            .filter((t) => t.tagName.toLowerCase() === "ac:task")
            .map((t, i) => (
              <li key={i}>
                {child(t, "ac:task-status")?.textContent?.trim() === "complete" ? "☑ " : "☐ "}
                {child(t, "ac:task-body") ? kids(child(t, "ac:task-body")!, `${key}.${i}`) : null}
              </li>
            ))}
        </ul>
      );
    case "time":
      return el.getAttribute("datetime") ?? el.textContent;
    case "a": {
      const href = httpUrl(el.getAttribute("href"));
      return href ? link(key, href, kids(el, key)) : <span key={key}>{kids(el, key)}</span>;
    }
    case "img": {
      const src = httpUrl(el.getAttribute("src"));
      return src ? <img key={key} src={src} alt={el.getAttribute("alt") ?? ""} /> : null;
    }
  }
  if (SIMPLE.has(tag)) {
    const props: Record<string, unknown> = { key };
    if (tag === "td" || tag === "th") {
      const cs = Number(el.getAttribute("colspan"));
      const rs = Number(el.getAttribute("rowspan"));
      if (cs > 1) props.colSpan = cs;
      if (rs > 1) props.rowSpan = rs;
    }
    return VOID.has(tag) ? React.createElement(tag, props) : React.createElement(tag, props, ...kids(el, key));
  }
  // Unknown (incl. other ac:/ri: elements): keep only what it contains.
  return <React.Fragment key={key}>{kids(el, key)}</React.Fragment>;
}

// HTML-mode parsing quirks: CDATA (code macro bodies) would become a comment, so it turns into escaped text; a
// self-closing namespaced tag (<ri:page ... />) would swallow its following siblings, so it gets a close tag.
function prepare(xhtml: string): string {
  return xhtml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    )
    .replace(/<((?:ac|ri):[\w-]+)((?:\s[^<>]*?)?)\s*\/>/g, "<$1$2></$1>");
}

export function StorageBody({ xhtml }: { xhtml: string }) {
  const doc = new DOMParser().parseFromString(`<body>${prepare(xhtml)}</body>`, "text/html");
  return <div className="a-body">{kids(doc.body, "b")}</div>;
}
