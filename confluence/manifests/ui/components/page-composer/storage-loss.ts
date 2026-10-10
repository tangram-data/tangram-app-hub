// Which parts of a storage body the plain-text draft can't carry. An allowlist: only shapes known to round-trip
// pass — p, h1–h3, hr; flat ul/ol (no numbering) whose items hold inline content; blockquotes of paragraphs;
// code macros and pre with plain text; inline text with un-nested strong/b, em/i, code. Everything else is named.

const INLINE = new Set(["strong", "b", "em", "i", "code"]);
// Attributes that carry no content (Confluence stamps local ids on blocks).
const BENIGN = new Set(["local-id", "data-local-id"]);

const LABEL: Record<string, string> = {
  table: "tables",
  img: "images",
  "ac:image": "images",
  a: "links",
  "ac:link": "links",
  br: "line breaks inside paragraphs",
  h4: "level 4–6 headings",
  h5: "level 4–6 headings",
  h6: "level 4–6 headings",
  ul: "nested lists",
  ol: "nested lists",
  "ac:structured-macro": "macros",
  "ac:macro": "macros",
  "ac:task-list": "task lists",
};

const isBlank = (n: Node) => n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").trim();
const tag = (el: Element) => el.tagName.toLowerCase();

export function lossReasons(body: Element): string[] {
  const out = new Set<string>();
  const other = (el: Element) => out.add(LABEL[tag(el)] ?? `other formatting (<${tag(el)}>)`);
  const attrs = (el: Element, allowed: (name: string, value: string) => boolean = () => false) => {
    for (const a of Array.from(el.attributes))
      if (!BENIGN.has(a.name) && !allowed(a.name, a.value))
        out.add(a.name === "start" || a.name === "value" ? "list numbering" : "formatting attributes");
  };

  const inline = (parent: Element, depth: number) => {
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      if (!INLINE.has(tag(el))) {
        if ((tag(el) === "ul" || tag(el) === "ol") && tag(parent) === "li") out.add("nested lists");
        else other(el);
        continue;
      }
      attrs(el);
      if (depth > 0) out.add("nested formatting");
      inline(el, depth + 1);
    }
  };

  const list = (el: Element) => {
    attrs(el, (n, v) => tag(el) === "ol" && n === "start" && v === "1");
    for (const n of Array.from(el.childNodes)) {
      if (isBlank(n)) continue;
      if (n.nodeType !== Node.ELEMENT_NODE || tag(n as Element) !== "li") {
        out.add("formatting attributes");
        continue;
      }
      attrs(n as Element);
      inline(n as Element, 0);
    }
  };

  const codeMacro = (el: Element) => {
    for (const c of Array.from(el.children)) {
      const t = tag(c);
      if (t === "ac:parameter" && c.getAttribute("ac:name") === "language") continue;
      if (t === "ac:plain-text-body") continue;
      out.add("code block options");
    }
  };

  for (const n of Array.from(body.childNodes)) {
    if (isBlank(n) || n.nodeType === Node.COMMENT_NODE) continue;
    if (n.nodeType !== Node.ELEMENT_NODE) {
      out.add("text outside paragraphs");
      continue;
    }
    const el = n as Element;
    const t = tag(el);
    if (t === "p" || t === "h1" || t === "h2" || t === "h3") (attrs(el), inline(el, 0));
    else if (t === "hr") attrs(el);
    else if (t === "ul" || t === "ol") list(el);
    else if (t === "blockquote") {
      attrs(el);
      for (const c of Array.from(el.childNodes)) {
        if (isBlank(c)) continue;
        if (c.nodeType === Node.ELEMENT_NODE && tag(c as Element) === "p") (attrs(c as Element), inline(c as Element, 0));
        else out.add(c.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/.test(tag(c as Element)) ? "lists inside quotes" : "formatting inside quotes");
      }
    } else if (t === "pre") {
      out.add("preformatted blocks (saved as code blocks)");
      if (el.children.length) out.add("formatting inside code");
    } else if (t === "ac:structured-macro" && el.getAttribute("ac:name") === "code") codeMacro(el);
    else other(el);
  }
  return Array.from(out);
}
