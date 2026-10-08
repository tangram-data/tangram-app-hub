// Read-only rendering in the Notion kit: rich text, per-type block shells
// (shared with the inline editor), nested/expandable blocks, tables, page
// properties, and the heading side-nav.
import React, { useEffect, useState } from "react";
import {
  Block,
  Children,
  fetchBlockChildren,
  MAX_CHILD_PAGES,
  openExternal,
  Page,
  payload,
  plainText,
  RichText,
  safeHref,
} from "./notion-blocks";

// Expansion stops here; deeper content defers to "Open in Notion".
const MAX_DEPTH = 5;
// Containers whose children ARE the visible content — no caret, fetch on mount.
const AUTO_EXPAND = ["column_list", "column", "synced_block", "table"];
// Children are separate documents/data sources, never inlined.
const NEVER_EXPAND = ["child_page", "child_database"];

function linkProps(href: string) {
  return {
    href,
    rel: "noreferrer",
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      openExternal(href);
    },
  };
}

export function renderRich(rich: RichText[] | undefined, keyBase: string): React.ReactNode[] {
  return (rich ?? []).map((span, i) => {
    const text = span.plain_text ?? "";
    if (!text) return null;
    const a = span.annotations ?? {};
    let node: React.ReactNode = text;
    if (a.code) node = <code className="n-inline-code">{node}</code>;
    if (a.bold) node = <strong>{node}</strong>;
    if (a.italic) node = <em>{node}</em>;
    if (a.strikethrough) node = <s>{node}</s>;
    if (a.underline) node = <u>{node}</u>;
    const href = safeHref(span.href);
    if (href) node = <a className="n-link" {...linkProps(href)}>{node}</a>;
    return <React.Fragment key={`${keyBase}:${i}`}>{node}</React.Fragment>;
  });
}

// The per-type frame around a block's text — used for read-only rich text and
// for the contentEditable line alike, so both look identical.
export function BlockShell({
  type,
  ordinal,
  checked,
  onCheck,
  icon,
  language,
  children,
}: {
  type: string;
  ordinal?: number;
  checked?: boolean;
  onCheck?: () => void;
  icon?: string;
  language?: string;
  children: React.ReactNode;
}) {
  const body = <div style={{ flex: 1, minWidth: 0 }}>{children}</div>;
  switch (type) {
    case "heading_1":
      return <div className="n-h1">{children}</div>;
    case "heading_2":
      return <div className="n-h2">{children}</div>;
    case "heading_3":
      return <div className="n-h3">{children}</div>;
    case "bulleted_list_item":
      return <div className="n-li"><span className="m">•</span>{body}</div>;
    case "numbered_list_item":
      return <div className="n-li"><span className="m">{ordinal ?? 1}.</span>{body}</div>;
    case "to_do":
      return (
        <div className={`n-todo${checked ? " done" : ""}`}>
          <button
            type="button"
            className={`n-box${checked ? " on" : ""}`}
            aria-checked={Boolean(checked)}
            role="checkbox"
            disabled={!onCheck}
            onClick={onCheck}
            style={onCheck ? undefined : { cursor: "default" }}
          >
            {checked ? "✓" : ""}
          </button>
          {body}
        </div>
      );
    case "quote":
      return <div className="n-quote">{children}</div>;
    case "callout":
      return <div className="n-callout"><span>{icon || "💡"}</span>{body}</div>;
    case "code":
      return (
        <div className="n-code">
          <span className="lang">{language || "plain text"}</span>
          {children}
        </div>
      );
    default:
      return <div>{children}</div>;
  }
}

// The block's own line, without its children. Containers (columns, tables)
// have no line of their own and render null here.
function blockContent(block: Block, ordinal: number): React.ReactNode {
  const p = payload(block);
  const shell = (children: React.ReactNode) => (
    <BlockShell
      type={block.type}
      ordinal={ordinal}
      checked={p.checked}
      icon={p.icon?.type === "emoji" ? p.icon.emoji : undefined}
      language={p.language}
    >
      {children}
    </BlockShell>
  );
  switch (block.type) {
    case "paragraph":
    case "heading_1":
    case "heading_2":
    case "heading_3":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "to_do":
    case "toggle":
    case "quote":
    case "callout":
      return shell(<div className="n-editable">{renderRich(p.rich_text, block.id)}</div>);
    case "code":
      return shell(plainText(block));
    case "divider":
      return <hr className="n-divider" />;
    case "bookmark": {
      const href = safeHref(p.url);
      return href ? <a className="n-bookmark" {...linkProps(href)}>🔗 {href}</a> : null;
    }
    case "child_page":
      return <div className="n-child"><span>📄</span><span>{p.title || "Untitled"}</span></div>;
    case "child_database":
      return <div className="n-child"><span>🗃</span><span>{p.title || "Untitled database"}</span></div>;
    case "column_list":
    case "column":
    case "synced_block":
    case "table":
      return null;
    default:
      // Unknown-but-textual blocks render as plain paragraphs; the rest skip.
      if (!plainText(block).trim()) return null;
      return <div className="n-editable">{renderRich(p.rich_text, block.id)}</div>;
  }
}

// table_row children rendered as one table; anything unexpected is skipped.
function TableRows({ rows, headerRow }: { rows: Block[]; headerRow: boolean }) {
  return (
    <table className="n-table">
      <tbody>
        {rows
          .filter((r) => r.type === "table_row")
          .map((row, ri) => {
            const cells = payload(row).cells ?? [];
            const Cell = headerRow && ri === 0 ? "th" : "td";
            return (
              <tr key={row.id || ri}>
                {cells.map((cell, ci) => (
                  <Cell key={ci}>{renderRich(cell, `${row.id}:${ci}`)}</Cell>
                ))}
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

// Lets the side navigation expand a collapsed section before jumping to it.
const expandFns = new Map<string, () => void>();

// `line` overrides the block's own line (the inline editor passes its
// contentEditable shell); children still expand/fetch as usual.
export function BlockNode({
  block,
  depth,
  ordinal,
  line,
}: {
  block: Block;
  depth: number;
  ordinal: number;
  line?: React.ReactNode;
}) {
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

  const content = line ?? blockContent(block, ordinal);
  if (!expandable) {
    return (
      <>
        {block.type === "toggle" ? (
          <div className="n-toggle" style={{ alignItems: "baseline" }}>
            <span className="tri" style={{ cursor: "default" }}>▸</span>
            <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
          </div>
        ) : (
          content
        )}
        {block.has_children && depth >= MAX_DEPTH ? (
          <div className="n-note">(deeper content not shown — open the page in Notion)</div>
        ) : null}
      </>
    );
  }

  const childArea = !expanded ? null : loading ? (
    <div className="n-note n-children">Loading…</div>
  ) : error ? (
    <div className="n-note n-children" style={{ color: "rgb(212,76,71)" }}>failed to load section: {error}</div>
  ) : !children ? null : block.type === "table" ? (
    <TableRows rows={children.blocks} headerRow={Boolean(payload(block).has_column_header)} />
  ) : block.type === "column_list" ? (
    <div className="n-cols">
      {children.blocks.map((col, i) => (
        <div key={col.id || i}>
          <BlockNode block={col} depth={depth + 1} ordinal={0} />
        </div>
      ))}
    </div>
  ) : (
    <div className={auto ? undefined : "n-children"}>
      <Blocks blocks={children.blocks} depth={depth + 1} />
      {children.truncated ? (
        <div className="n-note">(section truncated — open the page in Notion to see the rest)</div>
      ) : null}
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
      {/* Baseline: headings carry their own margin-top, which would otherwise
          leave the caret floating above the text line. */}
      <div className="n-toggle" style={{ alignItems: "baseline" }}>
        <span
          className="tri"
          onClick={() => setExpanded((v) => !v)}
          role="button"
          aria-expanded={expanded}
          style={{ userSelect: "none" }}
        >
          {expanded ? "▾" : "▸"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
      </div>
      {childArea}
    </div>
  );
}

// Nested (read-only) block lists; contiguous numbered items share a counter.
function Blocks({ blocks, depth }: { blocks: Block[]; depth: number }) {
  let n = 0;
  return (
    <>
      {blocks.map((b, i) => {
        const ordinal = b.type === "numbered_list_item" ? ++n : (n = 0);
        return (
          <div key={b.id || i} className="n-block" id={b.id ? `blk-${b.id}` : undefined}>
            <BlockNode block={b} depth={depth} ordinal={ordinal} />
          </div>
        );
      })}
    </>
  );
}

// Simple read-only page properties (database items); unknown types skip.
function propValue(prop: Record<string, any>): React.ReactNode {
  const v = prop[prop.type];
  const tag = (name: string, i = 0) => <span key={i} className="n-tag">{name}</span>;
  switch (prop.type) {
    case "select":
    case "status":
      return v?.name ? tag(v.name) : null;
    case "multi_select":
      return Array.isArray(v) && v.length ? <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{v.map((o: any, i: number) => tag(o?.name ?? "", i))}</span> : null;
    case "rich_text":
      return Array.isArray(v) ? v.map((s: any) => s?.plain_text ?? "").join("") || null : null;
    case "number":
      return typeof v === "number" ? String(v) : null;
    case "checkbox":
      return v ? "✓" : "—";
    case "date":
      return v?.start ? `${v.start}${v.end ? ` → ${v.end}` : ""}` : null;
    case "people":
      return Array.isArray(v) && v.length ? v.map((u: any) => u?.name ?? "Someone").join(", ") : null;
    case "url":
    case "email":
    case "phone_number":
      return typeof v === "string" && v ? v : null;
    default:
      return null;
  }
}

export function PageProps({ page }: { page: Page }) {
  const rows = Object.entries(page.properties ?? {})
    .filter(([, p]) => p?.type && p.type !== "title")
    .map(([k, p]) => [k, propValue(p as Record<string, any>)] as const)
    .filter(([, v]) => v !== null && v !== "");
  if (!rows.length) return null;
  return (
    <div className="n-props">
      {rows.map(([k, v]) => (
        <div className="n-prop" key={k}>
          <span className="k">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

export type TocEntry = { id: string; text: string; level: number };

export function tocEntries(blocks: Block[]): TocEntry[] {
  return blocks.flatMap((b) => {
    const level = b.type === "heading_1" ? 1 : b.type === "heading_2" ? 2 : b.type === "heading_3" ? 3 : 0;
    return level ? [{ id: b.id, text: plainText(b), level }] : [];
  });
}

// Notion-style table of contents: a rail of bars on the right edge that
// expands to a heading list on hover. Fixed-positioned, so it floats over the
// frame viewport regardless of scroll.
export function SideNav({ entries }: { entries: TocEntry[] }) {
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
        <div className="n-menu" style={{ position: "static", width: "auto", minWidth: 170, maxWidth: 260, maxHeight: "70vh", overflowY: "auto" }}>
          {entries.map((e) => (
            <div
              key={e.id}
              className={`it${e.id === activeId ? " on" : ""}`}
              onClick={() => jump(e.id)}
              style={{ paddingLeft: 14 + (e.level - 1) * 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block", color: e.id === activeId ? "rgb(35,131,226)" : undefined }}
            >
              {e.text || "Untitled"}
            </div>
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
                background: e.id === activeId ? "rgb(55,53,47)" : "rgba(55,53,47,.2)",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
