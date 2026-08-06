// Renderer over the connector's Page.Get + Block.List + Block.Append +
// Block.Update + Block.Delete actions. Fetches the page for its title/url,
// pages through the top-level blocks, and renders a safe subset — headings,
// paragraphs, lists, to-dos, quotes, callouts, code, dividers, bookmarks,
// tables — as plain React nodes. Blocks with children (toggles, toggle
// headings, nested lists) expand on click, fetching their subtree lazily via
// Block.List; layout containers (columns, synced blocks, tables) auto-expand.
// Depth is capped.
// The pencil button toggles a Notion-style edit mode: hovering a top-level
// block reveals controls to edit its text in place (Block.Update, plain text
// only — saving flattens formatting), insert new blocks after it
// (Block.Append with `after`), or delete it (Block.Delete, host-confirmed);
// an append editor writes to the end of the page. Drafts parse markdown-style
// prefixes (#, -, 1., [], >, ---, ```) into matching block types. The append
// draft is exposed through provideState so the agent can read it, and a
// re-render with a `draft` input prefills/refines it.
import { DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Space, Spin, Typography } from "antd";
import React, { useEffect, useRef, useState } from "react";

const tangram = (window as any).tangram;

// External links relay through the host (the sandbox has no allow-popups, so
// target="_blank" would be silently swallowed); the host confirms the
// destination and opens the tab. Older shells without openUrl fall back to
// window.open, which the sandbox may block — harmless either way.
function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  if (tangram?.openUrl) tangram.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

type Annotations = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
};
type RichText = { plain_text?: string; href?: string | null; annotations?: Annotations };
type BlockPayload = {
  rich_text?: RichText[];
  checked?: boolean;
  language?: string;
  url?: string;
  title?: string;
  icon?: { type?: string; emoji?: string };
  cells?: RichText[][];
  has_column_header?: boolean;
};
type Block = {
  id: string;
  type: string;
  has_children?: boolean;
} & Record<string, unknown>;
type Page = {
  id?: string;
  url?: string;
  archived?: boolean;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
};
type BlockList = { results?: Block[]; next_cursor?: string | null; has_more?: boolean };
type Children = { blocks: Block[]; truncated: boolean };

// Top-level blocks fetched at most this many pages of 100 — beyond that the
// viewer shows a truncation notice instead of hammering the API.
const MAX_BLOCK_PAGES = 5;
// Nested subtrees are user-initiated one at a time, so a smaller cap suffices.
const MAX_CHILD_PAGES = 2;
// Expansion stops here; deeper content defers to "Open in Notion".
const MAX_DEPTH = 5;
// Containers whose children ARE the visible content — no caret, fetch on mount.
const AUTO_EXPAND = ["column_list", "column", "synced_block", "table"];
// Children are separate documents/data sources, never inlined.
const NEVER_EXPAND = ["child_page", "child_database"];

// Notion API limits: 100 blocks per request, 2000 chars per rich-text span.
const BLOCKS_PER_REQUEST = 100;
const SPAN_CHAR_LIMIT = 2000;

type Span = { type: "text"; text: { content: string } };
type NotionBlock = { type: string } & Record<string, unknown>;
// `line` is the block's first source line, so partial-failure recovery can
// trim exactly the already-written content from the draft.
type ParsedBlock = { block: NotionBlock; line: number };

function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < text.length; i += SPAN_CHAR_LIMIT) {
    spans.push({ type: "text", text: { content: text.slice(i, i + SPAN_CHAR_LIMIT) } });
  }
  return spans;
}

function typed(type: string, text: string): NotionBlock {
  return { type, [type]: { rich_text: spansOf(text) } };
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

function parseContent(content: string): ParsedBlock[] {
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

function remainingContent(content: string, parsed: ParsedBlock[], writtenBlocks: number): string {
  if (writtenBlocks >= parsed.length) return "";
  return content.split("\n").slice(parsed[writtenBlocks].line).join("\n");
}

// Batched append that remembers how many blocks landed before the failure.
class AppendFailure extends Error {
  appendedBlocks: number;
  constructor(appendedBlocks: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.appendedBlocks = appendedBlocks;
  }
}

async function appendBlocks(id: string, blocks: NotionBlock[]): Promise<void> {
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

async function fetchBlockChildren(blockId: string, maxPages: number): Promise<Children> {
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

function pageTitle(page: Page): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === "title") {
      return (prop.title ?? []).map((t) => t.plain_text ?? "").join("");
    }
  }
  return "";
}

// https only, matching the host relay — http links render as plain text
// rather than as anchors that would silently do nothing.
function safeHref(url?: string | null): string {
  return url && /^https:\/\//i.test(url) ? url : "";
}

function renderRich(rich: RichText[] | undefined, keyBase: string): React.ReactNode[] {
  return (rich ?? []).map((span, i) => {
    const text = span.plain_text ?? "";
    if (!text) return null;
    const a = span.annotations ?? {};
    let node: React.ReactNode = text;
    if (a.code) {
      node = (
        <code style={{ background: "#f4f4f4", padding: "0 4px", borderRadius: 3 }}>{node}</code>
      );
    }
    if (a.bold) node = <strong>{node}</strong>;
    if (a.italic) node = <em>{node}</em>;
    if (a.strikethrough) node = <s>{node}</s>;
    if (a.underline) node = <u>{node}</u>;
    const href = safeHref(span.href);
    if (href) {
      node = (
        <a
          href={href}
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            openExternal(href);
          }}
        >
          {node}
        </a>
      );
    }
    return <React.Fragment key={`${keyBase}:${i}`}>{node}</React.Fragment>;
  });
}

const HEADING_LEVEL: Record<string, 4 | 5> = { heading_1: 4, heading_2: 5 };

function payload(block: Block): BlockPayload {
  return ((block as Record<string, unknown>)[block.type] ?? {}) as BlockPayload;
}

function plainText(block: Block): string {
  return (payload(block).rich_text ?? []).map((s) => s.plain_text ?? "").join("");
}

// Lets the side navigation expand a collapsed section before jumping to it.
const expandFns = new Map<string, () => void>();

type TocEntry = { id: string; text: string; level: number };

function headingLevel(type: string): number | null {
  return type === "heading_1" ? 1 : type === "heading_2" ? 2 : type === "heading_3" ? 3 : null;
}

function tocEntries(blocks: Block[]): TocEntry[] {
  return blocks.flatMap((b) => {
    const level = headingLevel(b.type);
    return level ? [{ id: b.id, text: plainText(b), level }] : [];
  });
}

function TocItem({ entry, active, onClick }: { entry: TocEntry; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "4px 10px",
        paddingLeft: 10 + (entry.level - 1) * 12,
        cursor: "pointer",
        borderRadius: 4,
        fontSize: 13,
        lineHeight: "18px",
        color: active ? "#1677ff" : "#37352f",
        background: hover ? "rgba(0,0,0,0.05)" : undefined,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {entry.text || "Untitled"}
    </div>
  );
}

// Notion-style table of contents: a rail of bars on the right edge that
// expands to a heading list on hover. Fixed-positioned, so it floats over the
// frame viewport regardless of scroll.
function SideNav({ entries }: { entries: TocEntry[] }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    const onScroll = () => {
      let current = entries[0]?.id ?? "";
      for (const e of entries) {
        const el = document.getElementById(`blk-${e.id}`);
        if (el && el.getBoundingClientRect().top <= 96) current = e.id;
      }
      setActiveId(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [entries]);

  if (entries.length < 2) return null;

  const jump = (id: string) => {
    expandFns.get(id)?.();
    requestAnimationFrame(() =>
      document.getElementById(`blk-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{ position: "fixed", top: 88, right: 6, zIndex: 20 }}
    >
      {open ? (
        <div
          style={{
            background: "#fff",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            border: "1px solid #eee",
            padding: "6px 4px",
            minWidth: 170,
            maxWidth: 260,
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          {entries.map((e) => (
            <TocItem key={e.id} entry={e} active={e.id === activeId} onClick={() => jump(e.id)} />
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-end", padding: "4px 6px" }}>
          {entries.map((e) => (
            <div
              key={e.id}
              style={{
                height: 2,
                borderRadius: 1,
                width: 22 - (e.level - 1) * 6,
                background: e.id === activeId ? "#37352f" : "#d9d9d9",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// The block's own line, without its children. Containers (columns, tables)
// have no line of their own and render null here.
function blockContent(block: Block, ordinal: number): React.ReactNode {
  const p = payload(block);
  const rich = renderRich(p.rich_text, block.id);

  switch (block.type) {
    case "paragraph":
      if (!plainText(block).trim()) return <div style={{ height: 8 }} />;
      return <div style={{ marginBottom: 6, lineHeight: 1.55 }}>{rich}</div>;
    case "heading_1":
    case "heading_2":
      return (
        <Typography.Title level={HEADING_LEVEL[block.type]} style={{ marginTop: 14, marginBottom: 6 }}>
          {rich}
        </Typography.Title>
      );
    case "heading_3":
      return (
        <Typography.Text strong style={{ display: "block", marginTop: 10, marginBottom: 4 }}>
          {rich}
        </Typography.Text>
      );
    case "bulleted_list_item":
      return <div style={{ marginBottom: 2 }}>• {rich}</div>;
    case "numbered_list_item":
      return (
        <div style={{ marginBottom: 2 }}>
          {ordinal}. {rich}
        </div>
      );
    case "to_do":
      return (
        <div style={{ marginBottom: 2 }}>
          {p.checked ? "☑" : "☐"}{" "}
          <span style={p.checked ? { textDecoration: "line-through", color: "#999" } : undefined}>
            {rich}
          </span>
        </div>
      );
    case "toggle":
      return <div style={{ marginBottom: 4 }}>{rich}</div>;
    case "quote":
      return (
        <div style={{ borderLeft: "3px solid #d9d9d9", paddingLeft: 10, margin: "6px 0", color: "#555" }}>
          {rich}
        </div>
      );
    case "callout":
      return (
        <div style={{ background: "#f7f6f3", borderRadius: 4, padding: "8px 12px", margin: "6px 0" }}>
          {p.icon?.type === "emoji" ? `${p.icon.emoji} ` : ""}
          {rich}
        </div>
      );
    case "code":
      return (
        <div style={{ margin: "6px 0" }}>
          <pre style={{ background: "#f4f4f4", borderRadius: 4, padding: 10, overflowX: "auto", margin: 0 }}>
            {plainText(block)}
          </pre>
          {p.language ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {p.language}
            </Typography.Text>
          ) : null}
        </div>
      );
    case "divider":
      return <hr style={{ border: "none", borderTop: "1px solid #e8e8e8", margin: "10px 0" }} />;
    case "bookmark": {
      const href = safeHref(p.url);
      return href ? (
        <div style={{ marginBottom: 6 }}>
          <a
            href={href}
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              openExternal(href);
            }}
          >
            <LinkOutlined /> {href}
          </a>
        </div>
      ) : null;
    }
    case "child_page":
      return (
        <div style={{ marginBottom: 4 }}>
          📄 <strong>{p.title ?? "Untitled"}</strong>
        </div>
      );
    case "child_database":
      return (
        <div style={{ marginBottom: 4 }}>
          🗃 <strong>{p.title ?? "Untitled database"}</strong>
        </div>
      );
    case "column_list":
    case "column":
    case "synced_block":
    case "table":
      return null;
    default:
      // Unknown-but-textual blocks render as plain paragraphs; the rest skip.
      if (!plainText(block).trim()) return null;
      return <div style={{ marginBottom: 6 }}>{rich}</div>;
  }
}

// table_row children rendered as one table; anything unexpected is skipped.
function TableRows({ rows, headerRow }: { rows: Block[]; headerRow: boolean }) {
  const cellStyle: React.CSSProperties = {
    border: "1px solid #e8e8e8",
    padding: "4px 8px",
    textAlign: "left",
    verticalAlign: "top",
  };
  return (
    <table style={{ borderCollapse: "collapse", margin: "6px 0", width: "100%" }}>
      <tbody>
        {rows
          .filter((r) => r.type === "table_row")
          .map((row, ri) => {
            const cells = payload(row).cells ?? [];
            const Cell = headerRow && ri === 0 ? "th" : "td";
            return (
              <tr key={row.id || ri}>
                {cells.map((cell, ci) => (
                  <Cell key={ci} style={cellStyle}>
                    {renderRich(cell, `${row.id}:${ci}`)}
                  </Cell>
                ))}
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

function BlockNode({ block, depth, ordinal }: { block: Block; depth: number; ordinal: number }) {
  const expandable =
    Boolean(block.has_children) && !NEVER_EXPAND.includes(block.type) && depth < MAX_DEPTH;
  const auto = expandable && AUTO_EXPAND.includes(block.type);
  const [expanded, setExpanded] = useState(auto);
  const [children, setChildren] = useState<Children | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!expanded || children || loading) return;
    setLoading(true);
    setError("");
    fetchBlockChildren(block.id, MAX_CHILD_PAGES)
      .then(setChildren)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [expanded]);

  useEffect(() => {
    if (!expandable || auto) return;
    expandFns.set(block.id, () => setExpanded(true));
    return () => {
      expandFns.delete(block.id);
    };
  }, [expandable, auto, block.id]);

  const content = blockContent(block, ordinal);
  if (!expandable) {
    return (
      <>
        {content}
        {block.has_children && depth >= MAX_DEPTH ? (
          <Typography.Text type="secondary" italic style={{ fontSize: 12 }}>
            (deeper content not shown — open the page in Notion)
          </Typography.Text>
        ) : null}
      </>
    );
  }

  const childArea = !expanded ? null : loading ? (
    <Spin size="small" style={{ display: "block", margin: "4px 0 4px 18px" }} />
  ) : error ? (
    <Typography.Text type="danger" style={{ display: "block", marginLeft: 18, fontSize: 12 }}>
      failed to load section: {error}
    </Typography.Text>
  ) : !children ? null : (
    <div
      style={
        block.type === "column_list"
          ? { display: "flex", gap: 16 }
          : auto
            ? undefined
            : { marginLeft: 18 }
      }
    >
      {block.type === "table" ? (
        <TableRows rows={children.blocks} headerRow={Boolean(payload(block).has_column_header)} />
      ) : block.type === "column_list" ? (
        children.blocks.map((col, i) => (
          <div key={col.id || i} style={{ flex: 1, minWidth: 0 }}>
            <BlockNode block={col} depth={depth + 1} ordinal={0} />
          </div>
        ))
      ) : (
        <>
          <Blocks blocks={children.blocks} depth={depth + 1} />
          {children.truncated ? (
            <Typography.Text type="secondary" italic style={{ fontSize: 12 }}>
              (section truncated — open the page in Notion to see the rest)
            </Typography.Text>
          ) : null}
        </>
      )}
    </div>
  );

  if (auto) {
    return (
      <>
        {content}
        {childArea}
      </>
    );
  }

  return (
    <div>
      {/* Baseline, not flex-start: headings carry their own margin-top, which
          would otherwise leave the caret floating above the text line. */}
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <span
          onClick={() => setExpanded((v) => !v)}
          role="button"
          aria-expanded={expanded}
          style={{ cursor: "pointer", userSelect: "none", width: 18, flexShrink: 0, color: "#888" }}
        >
          {expanded ? "▾" : "▸"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
      </div>
      {childArea}
    </div>
  );
}

function Blocks({
  blocks,
  depth,
  row,
}: {
  blocks: Block[];
  depth: number;
  // Edit mode wraps each top-level block with hover controls; nested
  // recursion never passes `row`, so children stay view-only.
  row?: (block: Block, node: React.ReactNode) => React.ReactNode;
}) {
  // Contiguous numbered_list_item runs share a counter; anything else resets it.
  let n = 0;
  return (
    <>
      {blocks.map((b, i) => {
        const ordinal = b.type === "numbered_list_item" ? ++n : (n = 0);
        const node = <BlockNode block={b} depth={depth} ordinal={ordinal} />;
        return (
          <div key={b.id || i} id={b.id ? `blk-${b.id}` : undefined}>
            {row ? row(b, node) : node}
          </div>
        );
      })}
    </>
  );
}

// Blocks whose text can be edited in place via Block.Update (rich_text
// replacement). Containers, dividers, tables, and child pages cannot.
const EDITABLE_TYPES = new Set([
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item",
  "numbered_list_item", "to_do", "toggle", "quote", "callout", "code",
]);

// Shared draft box for in-place edits and inserts. Top-level component (not a
// closure inside PageViewer) so its text state survives parent re-renders.
function BlockEditor({
  initial,
  placeholder,
  saveLabel,
  hint,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  saveLabel: string;
  hint?: string;
  busy: boolean;
  error: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div style={{ margin: "2px 0 8px", padding: 8, background: "#fafafa", border: "1px solid #ececec", borderRadius: 6 }}>
      <Input.TextArea
        autoFocus
        autoSize={{ minRows: 1, maxRows: 14 }}
        value={text}
        disabled={busy}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSave(text);
          if (e.key === "Escape") onCancel();
        }}
      />
      {error ? (
        <Typography.Text type="danger" style={{ display: "block", marginTop: 6, fontSize: 12 }}>
          {error}
        </Typography.Text>
      ) : null}
      <Space style={{ marginTop: 8 }}>
        <Button size="small" type="primary" loading={busy} onClick={() => onSave(text)}>
          {saveLabel}
        </Button>
        <Button size="small" type="text" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {hint ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        ) : null}
      </Space>
    </div>
  );
}

// One editing/inserting target at a time; PageViewer owns the state and
// passes it down so every row stays in sync.
type RowEdit = {
  editingId: string;
  insertingId: string;
  busy: boolean;
  error: string;
  start: (b: Block) => void;
  insert: (b: Block) => void;
  cancel: () => void;
  saveEdit: (b: Block, text: string) => void;
  saveInsert: (b: Block, text: string) => void;
  remove: (b: Block) => void;
};

function EditRow({ block, node, edit }: { block: Block; node: React.ReactNode; edit: RowEdit }) {
  const [hover, setHover] = useState(false);
  if (edit.editingId === block.id) {
    return (
      <BlockEditor
        initial={plainText(block)}
        placeholder="Block text"
        saveLabel="Save"
        hint="⌘⏎ · saving replaces the block's formatting with plain text"
        busy={edit.busy}
        error={edit.error}
        onSave={(t) => edit.saveEdit(block, t)}
        onCancel={edit.cancel}
      />
    );
  }
  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ position: "relative", borderRadius: 4, background: hover ? "rgba(55,53,47,0.05)" : undefined }}
      >
        {node}
        {hover ? (
          <Space
            size={0}
            style={{
              position: "absolute",
              top: -4,
              right: 0,
              background: "#fff",
              border: "1px solid #eee",
              borderRadius: 4,
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
            }}
          >
            {EDITABLE_TYPES.has(block.type) ? (
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                title="Edit this block"
                onClick={() => edit.start(block)}
              />
            ) : null}
            <Button
              size="small"
              type="text"
              icon={<PlusOutlined />}
              title="Insert below"
              onClick={() => edit.insert(block)}
            />
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              title="Delete this block (moves to Notion's trash)"
              onClick={() => edit.remove(block)}
            />
          </Space>
        ) : null}
      </div>
      {edit.insertingId === block.id ? (
        <BlockEditor
          initial=""
          placeholder={"New blocks — # heading, - bullet, 1. numbered, [] to-do, > quote, --- divider, ``` code"}
          saveLabel="Insert"
          hint="⌘⏎"
          busy={edit.busy}
          error={edit.error}
          onSave={(t) => edit.saveInsert(block, t)}
          onCancel={edit.cancel}
        />
      ) : null}
    </>
  );
}

type State =
  | { kind: "init" }
  | { kind: "loading" }
  | { kind: "ready"; page: Page; blocks: Block[]; truncated: boolean }
  | { kind: "error"; message: string };

export default function PageViewer() {
  const [pageId, setPageId] = useState("");
  const [state, setState] = useState<State>({ kind: "init" });
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // In-place block editing: one editing or inserting target at a time.
  const [editingId, setEditingId] = useState("");
  const [insertingId, setInsertingId] = useState("");
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState("");
  // Guards stale responses when the target page changes mid-fetch.
  const loadSeq = useRef(0);

  function load(id: string) {
    if (!id) {
      setState({ kind: "error", message: "No pageId provided." });
      return;
    }
    const seq = ++loadSeq.current;
    setState({ kind: "loading" });
    Promise.all([
      tangram.performAction(
        { resourceType: "Page", action: "Get" },
        { parameters: { page_id: id } },
      ) as Promise<Page>,
      fetchBlockChildren(id, MAX_BLOCK_PAGES),
    ])
      .then(([page, { blocks, truncated }]) => {
        if (seq !== loadSeq.current) return;
        setState({ kind: "ready", page, blocks, truncated });
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }

  useEffect(() => {
    // Track applied values locally (not via state updaters — those must stay
    // side-effect free) so token-renewal replays of the same inputs don't
    // refetch or wipe in-progress edits.
    let lastId = "";
    let lastDraft = "";
    const apply = (inputs: Record<string, unknown>) => {
      // Agent-supplied draft: open the editor prefilled/refined. Dedup so a
      // renewal replay can't clobber what the user typed since.
      const agentDraft = String(inputs?.draft ?? "");
      if (agentDraft !== lastDraft) {
        lastDraft = agentDraft;
        if (agentDraft.trim()) {
          setDraft(agentDraft);
          setMode("edit");
          setSaveError("");
        }
      }
      const id = String(inputs?.pageId ?? "").trim();
      // Inputs arrived without a pageId: surface it instead of spinning forever.
      if (!id) {
        if (!lastId) setState({ kind: "error", message: "No pageId provided." });
        return;
      }
      if (id === lastId) return;
      lastId = id;
      setPageId(id);
      load(id);
    };
    // getInputs() resolves after the host's init handshake delivers the inputs.
    Promise.resolve(tangram.getInputs()).then((inputs: Record<string, unknown>) =>
      apply(inputs ?? {}),
    );
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, []);

  const ready = state.kind === "ready" ? state : null;
  const title = ready ? pageTitle(ready.page) : "";

  // Snapshot for the agent's tangram_get_component_state tool: what page is
  // shown and what the user is drafting, so the agent can assist the edit.
  const stateRef = useRef<Record<string, unknown>>({});
  stateRef.current = {
    pageId,
    title,
    mode,
    ...(mode === "edit" ? { draft } : {}),
  };
  useEffect(() => {
    tangram.provideState?.(() => stateRef.current);
  }, []);

  async function saveDraft() {
    if (!draft.trim() || !pageId || saving) return;
    setSaving(true);
    setSaveError("");
    const parsed = parseContent(draft);
    try {
      await appendBlocks(pageId, parsed.map((p) => p.block));
      setDraft("");
      setMode("view");
      load(pageId);
    } catch (e) {
      if (e instanceof AppendFailure && e.appendedBlocks > 0) {
        setDraft(remainingContent(draft, parsed, e.appendedBlocks));
        setSaveError(`Partially appended; the draft keeps only the unwritten lines. ${e.message}`);
      } else {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }

  function patchBlocks(fn: (blocks: Block[]) => Block[]) {
    setState((s) => (s.kind === "ready" ? { ...s, blocks: fn(s.blocks) } : s));
  }

  function cancelBlockEdit() {
    setEditingId("");
    setInsertingId("");
    setBlockError("");
  }

  async function saveBlockEdit(block: Block, text: string) {
    if (blockBusy) return;
    setBlockBusy(true);
    setBlockError("");
    try {
      // The response is the full updated block — swap it into local state so
      // the new text shows without refetching the page.
      const updated: Block = await tangram.performAction(
        { resourceType: "Block", action: "Update" },
        {
          parameters: { block_id: block.id },
          requestBody: { [block.type]: { rich_text: spansOf(text) } },
        },
      );
      patchBlocks((bs) => bs.map((b) => (b.id === block.id ? { ...b, ...updated } : b)));
      setEditingId("");
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : String(e));
    } finally {
      setBlockBusy(false);
    }
  }

  async function saveBlockInsert(block: Block, text: string) {
    const parsed = parseContent(text);
    if (blockBusy || !text.trim() || !parsed.length) return;
    if (parsed.length > BLOCKS_PER_REQUEST) {
      // `after` pins one position, so this can't batch like appends do.
      setBlockError(`Inserting is limited to ${BLOCKS_PER_REQUEST} blocks at a time.`);
      return;
    }
    setBlockBusy(true);
    setBlockError("");
    try {
      await tangram.performAction(
        { resourceType: "Block", action: "Append" },
        {
          parameters: { block_id: pageId },
          requestBody: { children: parsed.map((p) => p.block), after: block.id },
        },
      );
      setInsertingId("");
      load(pageId);
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : String(e));
    } finally {
      setBlockBusy(false);
    }
  }

  async function removeBlock(block: Block) {
    if (blockBusy) return;
    setBlockBusy(true);
    setBlockError("");
    try {
      // Block.Delete is confirmation-gated by its resource action policy; the
      // trusted host prompts outside the sandbox before execution resumes.
      await tangram.performAction(
        { resourceType: "Block", action: "Delete" },
        { parameters: { block_id: block.id } },
      );
      patchBlocks((bs) => bs.filter((b) => b.id !== block.id));
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : String(e));
    } finally {
      setBlockBusy(false);
    }
  }

  const rowEdit: RowEdit = {
    editingId,
    insertingId,
    busy: blockBusy,
    error: blockError,
    start: (b) => {
      setEditingId(b.id);
      setInsertingId("");
      setBlockError("");
    },
    insert: (b) => {
      setInsertingId(b.id);
      setEditingId("");
      setBlockError("");
    },
    cancel: cancelBlockEdit,
    saveEdit: saveBlockEdit,
    saveInsert: saveBlockInsert,
    remove: removeBlock,
  };

  return (
    <div
      style={{
        padding: 16,
        maxWidth: 760,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <Space style={{ marginBottom: 8, width: "100%", justifyContent: "space-between", display: "flex" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title || "Page"}
        </Typography.Title>
        <Space size={8}>
          {safeHref(ready?.page.url) ? (
            <Typography.Link
              href={safeHref(ready?.page.url)}
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                openExternal(safeHref(ready?.page.url));
              }}
            >
              <LinkOutlined /> Open in Notion
            </Typography.Link>
          ) : null}
          <Button
            size="small"
            type={mode === "edit" ? "primary" : "text"}
            icon={<EditOutlined />}
            title={mode === "edit" ? "Done editing" : "Edit this page"}
            disabled={!ready && mode !== "edit"}
            onClick={() => {
              if (mode === "edit") {
                setMode("view");
                cancelBlockEdit();
              } else {
                setMode("edit");
              }
              setSaveError("");
            }}
          >
            {mode === "edit" ? "Done" : null}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            title="Refresh"
            disabled={state.kind === "loading" || !pageId}
            onClick={() => load(pageId)}
          />
        </Space>
      </Space>
      {mode === "edit" && ready ? (
        <div
          style={{
            margin: "4px 0 16px",
            padding: 12,
            background: "#fafafa",
            border: "1px solid #ececec",
            borderRadius: 6,
          }}
        >
          <Input.TextArea
            autoSize={{ minRows: 4, maxRows: 14 }}
            placeholder={
              "Write content to append — # heading, - bullet, 1. numbered, [] to-do, > quote, --- divider, ``` code; other lines become paragraphs. The agent can see this draft and help refine it."
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
          />
          {saveError ? (
            <Typography.Text type="danger" style={{ display: "block", marginTop: 6, fontSize: 12 }}>
              {saveError}
            </Typography.Text>
          ) : null}
          <Space style={{ marginTop: 8 }}>
            <Button size="small" type="primary" loading={saving} disabled={!draft.trim()} onClick={saveDraft}>
              Append to page
            </Button>
            <Button
              size="small"
              type="text"
              disabled={saving}
              onClick={() => {
                setMode("view");
                setSaveError("");
              }}
            >
              Cancel
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Appends to the end of the page — or hover any block below to edit, insert, or delete in place
            </Typography.Text>
          </Space>
        </div>
      ) : null}
      {state.kind === "loading" || state.kind === "init" ? (
        <Spin style={{ display: "block", margin: "24px auto" }} />
      ) : null}
      {state.kind === "error" ? <Alert type="error" showIcon message={state.message} /> : null}
      {ready?.page.archived ? (
        <Alert type="warning" showIcon message="This page is in the trash." style={{ marginBottom: 8 }} />
      ) : null}
      {ready ? <SideNav entries={tocEntries(ready.blocks)} /> : null}
      {mode === "edit" && blockError && !editingId && !insertingId ? (
        <Alert type="error" showIcon message={blockError} style={{ marginBottom: 8 }} />
      ) : null}
      {ready ? (
        <div style={{ wordBreak: "break-word" }}>
          <Blocks
            blocks={ready.blocks}
            depth={0}
            row={
              mode === "edit"
                ? (b, node) => <EditRow block={b} node={node} edit={rowEdit} />
                : undefined
            }
          />
          {ready.truncated ? (
            <Typography.Text type="secondary" italic>
              Content truncated — open the page in Notion to see the rest.
            </Typography.Text>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
