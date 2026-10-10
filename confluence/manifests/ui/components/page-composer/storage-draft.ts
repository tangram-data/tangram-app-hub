// Plain-text draft ⇄ Confluence storage format for the page composer.
// Draft syntax: #/##/### headings, - or * bullets, "1." numbered items,
// > quotes, --- rules, ``` fenced code (→ code macro); inline **bold**,
// *italic*, `code`; every other non-empty line is a paragraph. All text is
// XML-escaped, so a draft can never inject markup.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

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

// Storage → draft for editing an existing page. `lossy` lists what the draft
// can't carry (tables, macros other than code, images…) so the user is warned
// before a save replaces the body.
export function storageToDraft(xhtml: string): { draft: string; lossy: string[] } {
  const lossy = new Set<string>();
  const src = xhtml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace(/<((?:ac|ri):[\w-]+)((?:\s[^<>]*?)?)\s*\/>/g, "<$1$2></$1>");
  const doc = new DOMParser().parseFromString(`<body>${src}</body>`, "text/html");

  const text = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? "").replace(/\s+/g, " ");
    if (n.nodeType !== Node.ELEMENT_NODE) return "";
    const el = n as Element;
    const t = el.tagName.toLowerCase();
    const inner = Array.from(el.childNodes).map(text).join("");
    if (t === "strong" || t === "b") return `**${inner}**`;
    if (t === "em" || t === "i") return `*${inner}*`;
    if (t === "code") return `\`${inner}\``;
    if (t === "br") return " ";
    if (t === "ac:parameter") return "";
    if (t === "a" || t === "ac:link") lossy.add("links");
    else if (t.startsWith("ac:") && t !== "ac:link-body" && t !== "ac:plain-text-link-body") lossy.add("macros");
    if (t === "ac:link") {
      const page = el.querySelector("ri\\:page");
      return inner.trim() || page?.getAttribute("ri:content-title") || "";
    }
    return inner;
  };

  const lines: string[] = [];
  const block = (el: Element) => {
    const t = el.tagName.toLowerCase();
    const kids = () => Array.from(el.children).forEach(block);
    if (/^h[1-6]$/.test(t)) lines.push(`${"#".repeat(Math.min(3, Number(t[1])))} ${text(el).trim()}`);
    else if (t === "p") lines.push(text(el).trim());
    else if (t === "ul" || t === "ol")
      Array.from(el.children).forEach((li, i) => lines.push(`${t === "ul" ? "-" : `${i + 1}.`} ${text(li).trim()}`));
    else if (t === "blockquote") Array.from(el.children).forEach((c) => lines.push(`> ${text(c).trim()}`));
    else if (t === "hr") lines.push("---");
    else if (t === "pre") lines.push("```", el.textContent ?? "", "```");
    else if (t === "ac:structured-macro" && el.getAttribute("ac:name") === "code") {
      const lang = Array.from(el.children).find((c) => c.getAttribute("ac:name") === "language")?.textContent ?? "";
      const body = Array.from(el.children).find((c) => c.tagName.toLowerCase() === "ac:plain-text-body");
      lines.push("```" + lang, body?.textContent ?? "", "```");
    } else if (t === "table") {
      lossy.add("tables");
      el.querySelectorAll("tr").forEach((tr) => lines.push(Array.from(tr.children).map((c) => text(c).trim()).join(" | ")));
    } else if (t === "img" || t === "ac:image") lossy.add("images");
    else if (t.startsWith("ac:") || t === "div" || t === "section") {
      if (t.startsWith("ac:")) lossy.add("macros");
      kids();
    } else if (text(el).trim()) lines.push(text(el).trim());
    if (/^(h[1-6]|p|ul|ol|blockquote|pre|table|ac:structured-macro)$/.test(t)) lines.push("");
  };
  Array.from(doc.body.children).forEach(block);
  const draft = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { draft, lossy: Array.from(lossy) };
}
