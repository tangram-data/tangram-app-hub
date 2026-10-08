// Notion data helpers for the page viewer: types, API limits, span splitting,
// markdown-style draft parsing, batched appends, and the "can this block be
// edited inline without losing formatting" check.
export const tangram = (window as any).tangram;

// External links relay through the host (the sandbox has no allow-popups, so
// target="_blank" would be silently swallowed); the host confirms the
// destination and opens the tab. Older shells without openUrl fall back to
// window.open, which the sandbox may block — harmless either way.
export function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  if (tangram?.openUrl) tangram.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

// https only, matching the host relay — http links render as plain text
// rather than as anchors that would silently do nothing.
export function safeHref(url?: string | null): string {
  return url && /^https:\/\//i.test(url) ? url : "";
}

export type Annotations = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
};
export type RichText = {
  type?: string;
  plain_text?: string;
  href?: string | null;
  annotations?: Annotations;
};
export type BlockPayload = {
  rich_text?: RichText[];
  checked?: boolean;
  language?: string;
  url?: string;
  title?: string;
  icon?: { type?: string; emoji?: string };
  cells?: RichText[][];
  has_column_header?: boolean;
  is_toggleable?: boolean;
};
export type Block = {
  id: string;
  type: string;
  has_children?: boolean;
} & Record<string, unknown>;
export type Page = {
  id?: string;
  url?: string;
  archived?: boolean;
  in_trash?: boolean;
  icon?: { type?: string; emoji?: string } | null;
  properties?: Record<string, { type?: string; title?: RichText[] } & Record<string, unknown>>;
};
type BlockList = { results?: Block[]; next_cursor?: string | null; has_more?: boolean };
export type Children = { blocks: Block[]; truncated: boolean };

// Top-level blocks fetched at most this many pages of 100 — beyond that the
// viewer shows a truncation notice instead of hammering the API.
export const MAX_BLOCK_PAGES = 5;
// Nested subtrees are user-initiated one at a time, so a smaller cap suffices.
export const MAX_CHILD_PAGES = 2;

// Notion API limits: 100 blocks per request, 2000 chars per rich-text span.
export const BLOCKS_PER_REQUEST = 100;
const SPAN_CHAR_LIMIT = 2000;

type Span = { type: "text"; text: { content: string } };
export type NotionBlock = { type: string } & Record<string, unknown>;
// `line` is the block's first source line, so partial-failure recovery can
// trim exactly the already-written content from the draft.
export type ParsedBlock = { block: NotionBlock; line: number };

export function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + SPAN_CHAR_LIMIT, text.length);
    // Never split a surrogate pair across spans.
    const prev = text.charCodeAt(end - 1);
    if (end < text.length && prev >= 0xd800 && prev <= 0xdbff) end--;
    spans.push({ type: "text", text: { content: text.slice(i, end) } });
    i = end;
  }
  return spans;
}

// Local echo of spans we wrote, used when an API response omits the block.
export function echoRich(text: string): RichText[] {
  return spansOf(text).map((s) => ({ type: "text", plain_text: s.text.content, annotations: {} }));
}

function typed(type: string, text: string): NotionBlock {
  return { type, [type]: { rich_text: spansOf(text) } };
}

// A fresh block of `type` holding plain `text` (the slash-menu / Enter path).
export function newBlockOf(type: string, text: string): NotionBlock {
  switch (type) {
    case "divider":
      return { type: "divider", divider: {} };
    case "to_do":
      return { type: "to_do", to_do: { rich_text: spansOf(text), checked: false } };
    case "code":
      return { type: "code", code: { rich_text: spansOf(text), language: "plain text" } };
    case "callout":
      return { type: "callout", callout: { rich_text: spansOf(text), icon: { type: "emoji", emoji: "💡" } } };
    default:
      return typed(type, text);
  }
}

// Notion rejects unknown code languages; unrecognized fence tags fall back to
// "plain text".
const CODE_LANGS = new Set([
  "abap", "bash", "c", "c#", "c++", "css", "dart", "docker", "elixir", "erlang",
  "go", "graphql", "haskell", "html", "java", "javascript", "json", "kotlin",
  "latex", "lua", "makefile", "markdown", "matlab", "objective-c", "perl",
  "php", "plain text", "powershell", "protobuf", "python", "r", "ruby", "rust",
  "scala", "shell", "sql", "swift", "typescript", "xml", "yaml",
]);
const LANG_ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", cs: "c#", cpp: "c++", sh: "shell", zsh: "shell",
  yml: "yaml", md: "markdown", golang: "go", dockerfile: "docker",
};

function codeLanguage(tag: string): string {
  const lang = LANG_ALIASES[tag.toLowerCase()] ?? tag.toLowerCase();
  return CODE_LANGS.has(lang) ? lang : "plain text";
}

// Markdown-style line prefixes map to Notion block types; everything else
// (including empty lines) becomes a paragraph.
const LINE_RULES: [RegExp, (m: RegExpMatchArray) => NotionBlock][] = [
  [/^###\s+(.*)$/, (m) => typed("heading_3", m[1])],
  [/^##\s+(.*)$/, (m) => typed("heading_2", m[1])],
  [/^#\s+(.*)$/, (m) => typed("heading_1", m[1])],
  [/^[-*]\s+(.*)$/, (m) => typed("bulleted_list_item", m[1])],
  [/^\d+[.)]\s+(.*)$/, (m) => typed("numbered_list_item", m[1])],
  [
    /^\[( |x|X)?\]\s+(.*)$/,
    (m) => ({ type: "to_do", to_do: { rich_text: spansOf(m[2]), checked: /x/i.test(m[1] ?? "") } }),
  ],
  [/^>\s+(.*)$/, (m) => typed("quote", m[1])],
  [/^(-{3,}|\*{3,})\s*$/, () => ({ type: "divider", divider: {} })],
];

export function parseContent(content: string): ParsedBlock[] {
  const lines = content.split("\n");
  const out: ParsedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^```(\S*)\s*$/);
    if (fence) {
      const start = i;
      const code: string[] = [];
      // An unterminated fence swallows the rest of the draft as code.
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      out.push({
        line: start,
        block: { type: "code", code: { rich_text: spansOf(code.join("\n")), language: codeLanguage(fence[1]) } },
      });
      continue;
    }
    const rule = LINE_RULES.find(([re]) => re.test(lines[i]));
    out.push({
      line: i,
      block: rule ? rule[1](lines[i].match(rule[0])!) : typed("paragraph", lines[i]),
    });
  }
  return out;
}

export function remainingContent(content: string, parsed: ParsedBlock[], writtenBlocks: number): string {
  if (writtenBlocks >= parsed.length) return "";
  return content.split("\n").slice(parsed[writtenBlocks].line).join("\n");
}

// Batched append that remembers how many blocks landed before the failure.
export class AppendFailure extends Error {
  appendedBlocks: number;
  constructor(appendedBlocks: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.appendedBlocks = appendedBlocks;
  }
}

export async function appendBlocks(id: string, blocks: NotionBlock[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += BLOCKS_PER_REQUEST) {
    try {
      await tangram.performAction(
        { resourceType: "Block", action: "Append" },
        {
          parameters: { block_id: id },
          requestBody: { children: blocks.slice(i, i + BLOCKS_PER_REQUEST) },
        },
      );
    } catch (e) {
      throw new AppendFailure(i, e);
    }
  }
}

export async function fetchBlockChildren(blockId: string, maxPages: number): Promise<Children> {
  const blocks: Block[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const params: Record<string, unknown> = { block_id: blockId, page_size: 100 };
    if (cursor) params.start_cursor = cursor;
    const res: BlockList = await tangram.performAction(
      { resourceType: "Block", action: "List" },
      { parameters: params },
    );
    blocks.push(...(res.results ?? []));
    if (!res.has_more || !res.next_cursor) return { blocks, truncated: false };
    cursor = res.next_cursor;
  }
  return { blocks, truncated: true };
}

// The page's title property: its key (Page.Update needs it) and spans.
export function titleProp(page: Page): { key: string; rich: RichText[] } | null {
  for (const [key, prop] of Object.entries(page.properties ?? {})) {
    if (prop?.type === "title") return { key, rich: prop.title ?? [] };
  }
  return null;
}

export function pageTitle(page: Page): string {
  return (titleProp(page)?.rich ?? []).map((t) => t.plain_text ?? "").join("");
}

export function payload(block: Block): BlockPayload {
  return ((block as Record<string, unknown>)[block.type] ?? {}) as BlockPayload;
}

export function plainText(block: Block): string {
  return (payload(block).rich_text ?? []).map((s) => s.plain_text ?? "").join("");
}

// True when replacing these spans with plain text loses nothing: plain text
// spans only — no links, mentions, equations, colors, or annotations.
export function isPlainRich(rich: RichText[] | undefined): boolean {
  return (rich ?? []).every((s) => {
    if ((s.type ?? "text") !== "text" || s.href) return false;
    const a = s.annotations ?? {};
    return !a.bold && !a.italic && !a.strikethrough && !a.underline && !a.code && (a.color ?? "default") === "default";
  });
}

// Block types whose text the page edits inline via Block.Update (rich_text is
// replaced wholesale, so formatted text stays read-only).
const INLINE_TYPES = new Set([
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item",
  "numbered_list_item", "to_do", "toggle", "quote", "callout", "code",
]);

export function canEditInline(block: Block): boolean {
  if (!INLINE_TYPES.has(block.type)) return false;
  // Toggle headings carry their children behind a caret; keep them read-only.
  if (payload(block).is_toggleable) return false;
  return isPlainRich(payload(block).rich_text);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
