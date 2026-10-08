// Notion-editor-style composer over the connector's Page.Create /
// Block.Append actions. Looks like a fresh Notion page (shared Notion kit): a
// big "Untitled" title over a seamless body, the parent-page picker as the
// breadcrumb line, and a docked Tangram primary button to commit. Content is plain text
// where markdown-style prefixes become real Notion blocks — #/##/### headings,
// -/* bullets, "1." numbered items, []/[x] to-dos, > quotes, --- dividers,
// ``` fenced code — and every other line a paragraph (long lines split at
// Notion's 2000-char span limit). An agent prefills parentPageId/title/content
// via render inputs; the user edits before saving. Create carries the first
// 100 blocks inline; any remainder — and all of append mode (`pageId` input
// set) — goes through Block.Append in batches of 100. Without a parentPageId,
// create makes a private workspace-level page (supported for public OAuth
// connections, which is what this connector uses).
import { Button } from "antd";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/notion.css";
import "../../shared/tangram-buttons.css";

const tangram = (window as any).tangram;

// External links relay through the host (the sandbox has no allow-popups, so
// target="_blank" would be silently swallowed); the host confirms the
// destination and opens the tab. https only, matching the host relay.
function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  if (tangram?.openUrl) tangram.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

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

function fallbackUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

// Only ever link to https URLs (what openExternal relays); anything else falls
// back to the id-derived notion.so address.
function safePageUrl(url: string | undefined, id: string): string {
  return url && /^https:\/\//i.test(url) ? url : fallbackUrl(id);
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

type SavedPage = { pageId: string; title: string; url: string; appended: boolean };

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved"; page: SavedPage }
  // The create succeeded but appending the overflow blocks failed — the page
  // exists with partial content. `remaining` holds only the not-yet-written
  // lines so a retry can't duplicate what already landed.
  | { kind: "created-append-failed"; pageId: string; url: string; message: string; remaining: string }
  | { kind: "error"; message: string };

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export default function PageComposer() {
  const [pageId, setPageId] = useState("");
  const [parentPageId, setParentPageId] = useState("");
  const [parentOpen, setParentOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Bumped on every input apply and save start; async save callbacks check it
  // so a superseded save can't overwrite newer state or emit a stale `saved`.
  const saveSeq = useRef(0);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Token renewal replays `init` with the same inputs — dedup on a canonical
    // key so a renewal can't wipe the user's in-progress edits. A real input
    // change (agent re-render, e.g. refined content) applies the new fields.
    const canonical = (v: unknown): string =>
      Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : v !== null && typeof v === "object"
          ? `{${Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
              .join(",")}}`
          : (JSON.stringify(v) ?? "null");
    let lastApplied = "";
    const apply = (inputs: Record<string, unknown>) => {
      const key = canonical(inputs ?? {});
      if (key === lastApplied) return;
      lastApplied = key;
      saveSeq.current++;
      setPageId(String(inputs?.pageId ?? "").trim());
      setParentPageId(String(inputs?.parentPageId ?? "").trim());
      setTitle(String(inputs?.title ?? ""));
      setContent(String(inputs?.content ?? ""));
      setStatus({ kind: "idle" });
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, []);

  // Expose the draft to the agent (tangram_get_component_state) so "refine
  // the page" can read the user's edits and re-render this instance.
  const draftRef = useRef({ pageId: "", parentPageId: "", title: "", content: "" });
  draftRef.current = { pageId, parentPageId, title, content };
  useEffect(() => {
    tangram.provideState?.(() => ({ ...draftRef.current }));
  }, []);

  const appending = pageId !== "";
  const disabled = status.kind === "busy";

  useEffect(() => autosize(titleRef.current), [title, status.kind, appending]);
  useEffect(() => autosize(bodyRef.current), [content, status.kind, appending]);

  function finish(seq: number, page: SavedPage) {
    if (seq !== saveSeq.current) return;
    setStatus({ kind: "saved", page });
    tangram.emit("saved", { pageId: page.pageId, title: page.title, url: page.url });
  }

  function save() {
    const seq = ++saveSeq.current;
    const fail = (message: string) => {
      if (seq === saveSeq.current) setStatus({ kind: "error", message });
    };
    if (appending) {
      if (!content.trim()) {
        fail("Content is required when appending.");
        return;
      }
      setStatus({ kind: "busy" });
      const snapshot = content;
      const parsed = parseContent(snapshot);
      appendBlocks(pageId, parsed.map((p) => p.block))
        .then(() => finish(seq, { pageId, title, url: fallbackUrl(pageId), appended: true }))
        .catch((e: unknown) => {
          if (seq !== saveSeq.current) return;
          const written = e instanceof AppendFailure ? e.appendedBlocks : 0;
          if (written > 0) {
            // Keep only the unwritten lines so Append-again can't duplicate.
            setContent(remainingContent(snapshot, parsed, written));
            fail(
              `${written} block(s) were appended before the failure; the editor now holds only the remaining content — Append again to retry. ${e instanceof Error ? e.message : String(e)}`,
            );
          } else {
            fail(e instanceof Error ? e.message : String(e));
          }
        });
      return;
    }
    if (!title.trim()) {
      fail("Title is required.");
      return;
    }
    setStatus({ kind: "busy" });
    const snapshot = content;
    const parsed = snapshot.trim() ? parseContent(snapshot) : [];
    const blocks = parsed.map((p) => p.block);
    const inline = blocks.slice(0, BLOCKS_PER_REQUEST);
    const overflow = blocks.slice(BLOCKS_PER_REQUEST);
    const parent = parentPageId.trim();
    tangram
      .performAction(
        { resourceType: "Page", action: "Create" },
        {
          requestBody: {
            // Omitting parent creates a private workspace-level page.
            ...(parent ? { parent: { page_id: parent } } : {}),
            properties: {
              title: { title: [{ type: "text", text: { content: title.trim() } }] },
            },
            ...(inline.length ? { children: inline } : {}),
          },
        },
      )
      .then((page: { id?: string; url?: string }) => {
        const id = page?.id ?? "";
        if (!id) throw new Error("Create returned no page id.");
        const url = safePageUrl(page?.url, id);
        if (!overflow.length) {
          finish(seq, { pageId: id, title: title.trim(), url, appended: false });
          return;
        }
        return appendBlocks(id, overflow).then(
          () => finish(seq, { pageId: id, title: title.trim(), url, appended: false }),
          (e: unknown) => {
            if (seq !== saveSeq.current) return;
            const written =
              inline.length + (e instanceof AppendFailure ? e.appendedBlocks : 0);
            setStatus({
              kind: "created-append-failed",
              pageId: id,
              url,
              message: e instanceof Error ? e.message : String(e),
              remaining: remainingContent(snapshot, parsed, written),
            });
          },
        );
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
  }

  const openLink = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (url) openExternal(url);
  };

  if (status.kind === "saved") {
    const page = status.page;
    return (
      <div className="n-root">
        <div className="n-page">
          <div className="n-callout" style={{ marginBottom: 20 }}>
            <span>✅</span>
            <span>{page.appended ? "Content appended" : "Page created"}</span>
          </div>
          <h1 className="n-title">{page.title || "Untitled"}</h1>
          <div className="n-bar">
            <Button href={page.url} onClick={openLink(page.url)}>
              Open in Notion
            </Button>
            <Button
              type="text"
              onClick={() => {
                // Continue as an append to the saved page; re-saving the same
                // fields would create (or append) a duplicate.
                setPageId(page.pageId);
                setContent("");
                setStatus({ kind: "idle" });
              }}
            >
              Back to editor
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (status.kind === "created-append-failed") {
    return (
      <div className="n-root">
        <div className="n-page">
          <div className="n-error" style={{ display: "block" }}>
            <strong>Page created, but appending part of the content failed.</strong>
            <div>{status.message}</div>
          </div>
          <div className="n-bar">
            <Button href={status.url} onClick={openLink(status.url)}>
              Open the partial page
            </Button>
            <Button
              type="primary"
              onClick={() => {
                // Retry as an append of only the not-yet-written lines.
                saveSeq.current++;
                setPageId(status.pageId);
                setContent(status.remaining);
                setStatus({ kind: "idle" });
              }}
            >
              Retry as append
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="n-root"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !disabled) save();
      }}
    >
      <div className="n-page">
        <div className="n-crumbline">
          {appending ? (
            <span>Appending to page {pageId}</span>
          ) : parentOpen || parentPageId ? (
            <input
              className="n-plain"
              value={parentPageId}
              disabled={disabled}
              autoFocus={parentOpen}
              placeholder="Parent page id — leave empty for a private page"
              onChange={(e) => setParentPageId(e.target.value)}
              onBlur={() => {
                if (!parentPageId.trim()) setParentOpen(false);
              }}
            />
          ) : (
            <span role="button" onClick={() => setParentOpen(true)}>
              📄 Private page · Add to a parent page…
            </span>
          )}
        </div>
        {status.kind === "error" ? <div className="n-error">{status.message}</div> : null}
        {!appending ? (
          <textarea
            className="n-plain n-title"
            ref={titleRef}
            rows={1}
            value={title}
            disabled={disabled}
            placeholder="Untitled"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // Enter moves into the body, like Notion's title line.
              if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                bodyRef.current?.focus();
              }
            }}
          />
        ) : null}
        <textarea
          className="n-plain n-body"
          ref={bodyRef}
          rows={1}
          value={content}
          disabled={disabled}
          placeholder={
            "Write something…  Start a line with # heading · - bullet · 1. numbered · [] to-do · > quote · --- divider · ``` code"
          }
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className="n-dock">
        <span>⌘⏎</span>
        <Button type="primary" onClick={save} disabled={disabled} loading={status.kind === "busy"}>
          {appending ? "Append" : "Create page"}
        </Button>
      </div>
    </div>
  );
}
