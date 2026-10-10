// Plain-text draft ⇄ Confluence storage format for the page composer.
// Draft syntax: #/##/### headings, - or * bullets, "1." numbered items,
// > quotes, --- rules, ``` fenced code (→ code macro); inline **bold**,
// *italic*, `code`; every other non-empty line is a paragraph. A backslash
// makes the next character literal (\* \` \# \- \\ …), which is how
// storageToDraft keeps a page's literal text from turning into formatting.
// All text is XML-escaped, so a draft can never inject markup.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Escaped characters ride through formatting as private-use placeholders.
const ESCAPABLE = /\\([\\`*#>\-+.)\d])/g;
const hold = (c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0));
const release = (s: string) => s.replace(/[\ue000-\ue0ff]/g, (c) => esc(String.fromCharCode(c.charCodeAt(0) - 0xe000)));

// Code spans are cut out first so bold/italic never apply inside them.
function emphasis(t: string): string {
  return t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

function inline(text: string): string {
  const held = esc(text.replace(ESCAPABLE, (_, c: string) => hold(c)));
  return release(
    held
      .split(/(`[^`]+`)/)
      .map((part) => (/^`[^`]+`$/.test(part) ? `<code>${part.slice(1, -1)}</code>` : emphasis(part)))
      .join(""),
  );
}

// Text that would read as draft syntax gets backslashes (inline everywhere, block markers at a line start).
const escInline = (t: string) => t.replace(/[\\`*]/g, (c) => `\\${c}`);
const escLineStart = (line: string) => (/^(#{1,3}\s|[-+]\s|-{3,}\s*$|\d+[.)]\s|>)/.test(line) ? `\\${line}` : line);

export function draftToStorage(draft: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const lines = draft.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w+#-]*)\s*$/);
    if (fence) {
      closeList();
      const body: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      // "]]>" can't appear inside CDATA: split it across two sections.
      const code = body.join("\n").replace(/]]>/g, "]]]]><![CDATA[>");
      const lang = fence[1] ? `<ac:parameter ac:name="language">${esc(fence[1])}</ac:parameter>` : "";
      out.push(`<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`);
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") (closeList(), out.push("<ul>"), (list = "ul"));
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") (closeList(), out.push("<ol>"), (list = "ol"));
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) out.push("<hr />");
    else if ((m = line.match(/^>\s?(.*)$/))) out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line.trim())}</p>`);
  }
  closeList();
  return out.join("");
}

// Storage → draft for editing an existing page. Literal text is escaped so
// it survives a round trip; `lossy` lists everything the draft can't carry
// (tables, macros, images, links, nested lists, other formatting) so the
// composer can warn before an edited draft replaces the body.
export function storageToDraft(xhtml: string): { draft: string; lossy: string[] } {
  const src = xhtml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace(/<((?:ac|ri):[\w-]+)((?:\s[^<>]*?)?)\s*\/>/g, "<$1$2></$1>");
  const doc = new DOMParser().parseFromString(`<body>${src}</body>`, "text/html");
  const has = (sel: string) => doc.body.querySelector(sel) !== null;
  const lossy: string[] = [];
  if (has("table")) lossy.push("tables");
  if (has("img, ac\\:image")) lossy.push("images");
  if (has("a, ac\\:link")) lossy.push("links");
  if (has("li ul, li ol")) lossy.push("nested lists");
  if (Array.from(doc.body.querySelectorAll("ac\\:structured-macro, ac\\:macro")).some((m) => m.getAttribute("ac:name") !== "code"))
    lossy.push("macros");
  if (has("u, s, del, sub, sup, span[style], ac\\:task-list, ac\\:emoticon, time")) lossy.push("other formatting");

  const text = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return escInline((n.textContent ?? "").replace(/\s+/g, " "));
    if (n.nodeType !== Node.ELEMENT_NODE) return "";
    const el = n as Element;
    const t = el.tagName.toLowerCase();
    if (t === "ac:parameter" || t === "ul" || t === "ol") return "";
    const inner = Array.from(el.childNodes).map(text).join("");
    if (t === "strong" || t === "b") return inner.trim() ? `**${inner}**` : inner;
    if (t === "em" || t === "i") return inner.trim() ? `*${inner}*` : inner;
    if (t === "code") return `\`${(el.textContent ?? "").replace(/`/g, "'")}\``;
    if (t === "br") return " ";
    if (t === "ac:link") return inner.trim() || escInline(el.querySelector("ri\\:page")?.getAttribute("ri:content-title") ?? "");
    return inner;
  };
  const line = (el: Element) => escLineStart(text(el).trim());

  const lines: string[] = [];
  const list = (el: Element, ordered: boolean) =>
    Array.from(el.children).forEach((li, i) => {
      lines.push(`${ordered ? `${i + 1}.` : "-"} ${text(li).trim()}`);
      // nested lists flatten into the same list (reported as lossy)
      li.querySelectorAll(":scope > ul, :scope > ol").forEach((sub) => list(sub, sub.tagName.toLowerCase() === "ol"));
    });
  const block = (el: Element) => {
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) lines.push(`${"#".repeat(Math.min(3, Number(t[1])))} ${text(el).trim()}`);
    else if (t === "p") lines.push(line(el));
    else if (t === "ul" || t === "ol") list(el, t === "ol");
    else if (t === "blockquote") Array.from(el.children).forEach((c) => lines.push(`> ${text(c).trim()}`));
    else if (t === "hr") lines.push("---");
    else if (t === "pre") lines.push("```", el.textContent ?? "", "```");
    else if (t === "ac:structured-macro" && el.getAttribute("ac:name") === "code") {
      const lang = Array.from(el.children).find((c) => c.getAttribute("ac:name") === "language")?.textContent ?? "";
      const body = Array.from(el.children).find((c) => c.tagName.toLowerCase() === "ac:plain-text-body");
      lines.push("```" + lang, body?.textContent ?? "", "```");
    } else if (t === "table") el.querySelectorAll("tr").forEach((tr) => lines.push(escLineStart(Array.from(tr.children).map((c) => text(c).trim()).join(" | "))));
    else if (t.startsWith("ac:") || t === "div" || t === "section") Array.from(el.children).forEach(block);
    else if (text(el).trim()) lines.push(line(el));
    if (/^(h[1-6]|p|ul|ol|blockquote|pre|table|ac:structured-macro)$/.test(t)) lines.push("");
  };
  Array.from(doc.body.children).forEach(block);
  return { draft: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), lossy };
}
