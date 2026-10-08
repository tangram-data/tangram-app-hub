// Plain-text contentEditable line (Notion's "viewing = editing"), plus the
// unsaved new-block draft with its "/" slash menu and markdown shortcuts.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BlockShell } from "./block-render";

// plaintext-only keeps the browser from inserting markup; older engines fall
// back to "true" with paste/drop/format shortcuts intercepted below.
const EDIT_MODE: "plaintext-only" | "true" = (() => {
  try {
    const d = document.createElement("div");
    d.contentEditable = "plaintext-only";
    return d.contentEditable === "plaintext-only" ? "plaintext-only" : "true";
  } catch {
    return "true";
  }
})();

function insertText(text: string) {
  if (document.execCommand?.("insertText", false, text)) return;
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const node = document.createTextNode(text);
  r.insertNode(node);
  r.setStartAfter(node);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

export function focusEnd(el: HTMLElement | null) {
  if (!el) return;
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

// Text before and after the caret (a selection between them is dropped).
function splitAtCaret(el: HTMLElement): [string, string] {
  const text = el.textContent ?? "";
  const sel = window.getSelection();
  if (!sel?.rangeCount) return [text, ""];
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return [text, ""];
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange();
  post.selectNodeContents(el);
  post.setStart(r.endContainer, r.endOffset);
  return [pre.toString(), post.toString()];
}

export type EditableProps = {
  // Server text; synced into the DOM only while the line is not focused, so
  // refreshes never clobber typing.
  text: string;
  placeholder?: string;
  className?: string;
  // Code blocks: Enter inserts a newline instead of splitting the block.
  multiline?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  elRef?: React.MutableRefObject<HTMLDivElement | null>;
  onCommit: (text: string) => void;
  onEnter?: (before: string, after: string) => void;
  onBackspaceEmpty?: () => void;
  onInput?: (text: string, el: HTMLDivElement) => void;
  // Return true when handled (slash-menu navigation).
  onKey?: (e: React.KeyboardEvent<HTMLDivElement>) => boolean;
};

export function Editable(props: EditableProps) {
  const own = useRef<HTMLDivElement | null>(null);
  const ref = props.elRef ?? own;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== props.text) el.textContent = props.text;
  }, [props.text]);

  useEffect(() => {
    if (props.autoFocus) focusEnd(ref.current);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el || e.nativeEvent.isComposing) return;
    if (props.onKey?.(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    // No rich formatting: the API write is plain text.
    if (mod && ["b", "i", "u"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (props.multiline) {
        if (mod) el.blur();
        else insertText("\n");
      } else if (!props.onEnter) {
        el.blur();
      } else if (e.shiftKey) {
        insertText("\n");
      } else {
        const [before, after] = splitAtCaret(el);
        props.onEnter(before, after);
      }
      return;
    }
    if (e.key === "Backspace" && !(el.textContent ?? "") && props.onBackspaceEmpty) {
      e.preventDefault();
      props.onBackspaceEmpty();
      return;
    }
    if (e.key === "Escape") el.blur();
  }

  return (
    <div
      ref={ref}
      className={`n-editable${props.className ? ` ${props.className}` : ""}`}
      contentEditable={(props.readOnly ? false : EDIT_MODE) as React.HTMLAttributes<HTMLDivElement>["contentEditable"]}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={props.placeholder}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (!props.readOnly) props.onCommit(ref.current?.textContent ?? "");
      }}
      onInput={() => ref.current && props.onInput?.(ref.current.textContent ?? "", ref.current)}
      onPaste={(e) => {
        e.preventDefault();
        const t = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
        // Single-line fields (the title) flatten pasted newlines.
        insertText(props.multiline || props.onEnter ? t : t.replace(/\n+/g, " "));
      }}
      onDrop={(e) => e.preventDefault()}
    />
  );
}

export const SLASH_ITEMS: { type: string; label: string; ic: string; hint: string }[] = [
  { type: "paragraph", label: "Text", ic: "Aa", hint: "" },
  { type: "heading_1", label: "Heading 1", ic: "H1", hint: "#" },
  { type: "heading_2", label: "Heading 2", ic: "H2", hint: "##" },
  { type: "heading_3", label: "Heading 3", ic: "H3", hint: "###" },
  { type: "bulleted_list_item", label: "Bulleted list", ic: "•", hint: "-" },
  { type: "numbered_list_item", label: "Numbered list", ic: "1.", hint: "1." },
  { type: "to_do", label: "To-do list", ic: "☐", hint: "[]" },
  { type: "quote", label: "Quote", ic: "❝", hint: ">" },
  { type: "callout", label: "Callout", ic: "💡", hint: "" },
  { type: "code", label: "Code", ic: "</>", hint: "```" },
  { type: "divider", label: "Divider", ic: "—", hint: "---" },
];

// Typed at the start of an empty Text draft, these switch its type (Notion's
// markdown shortcuts); the prefix is consumed.
const SHORTCUTS: [RegExp, string][] = [
  [/^### /, "heading_3"],
  [/^## /, "heading_2"],
  [/^# /, "heading_1"],
  [/^[-*] /, "bulleted_list_item"],
  [/^1[.)] /, "numbered_list_item"],
  [/^\[\] /, "to_do"],
  [/^> /, "quote"],
  [/^```$/, "code"],
  [/^---$/, "divider"],
];

const PLACEHOLDER: Record<string, string> = {
  paragraph: "Type '/' for commands",
  heading_1: "Heading 1",
  heading_2: "Heading 2",
  heading_3: "Heading 3",
  bulleted_list_item: "List",
  numbered_list_item: "List",
  to_do: "To-do",
  quote: "Empty quote",
  callout: "Type something…",
  code: "Code",
};

export type NewBlock = {
  key: number;
  // Insert after this block id; "" appends at the end of the page.
  after: string;
  type: string;
  initial: string;
  busy: boolean;
};

// An unsaved block: created via Block.Append on blur/Enter, never per keystroke.
export function DraftBlock({
  nb,
  ordinal,
  onType,
  onCreate,
  onDrop,
}: {
  nb: NewBlock;
  ordinal: number;
  onType: (type: string, text: string) => void;
  onCreate: (text: string, opts: { next: boolean; type?: string }) => void;
  onDrop: (focusPrev: boolean) => void;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ filter: string; idx: number } | null>(null);
  const items = menu
    ? SLASH_ITEMS.filter((i) => `${i.label} ${i.ic} ${i.type}`.toLowerCase().includes(menu.filter.toLowerCase()))
    : [];
  const committing = useRef(false);

  // A type switch remounts the line inside a new shell; the old element's
  // blur during that swap must not commit or drop the draft.
  const switching = useRef(false);
  function pick(type: string, rest = "") {
    setMenu(null);
    if (type === "divider") {
      committing.current = true;
      onCreate("", { next: true, type: "divider" });
      return;
    }
    if (type === nb.type) {
      // Same shell, no remount: just replace the "/filter" text in place.
      if (el.current) el.current.textContent = rest;
      focusEnd(el.current);
      return;
    }
    switching.current = true;
    onType(type, rest);
    requestAnimationFrame(() => (switching.current = false));
  }

  function create(text: string, next: boolean) {
    if (committing.current || nb.busy) return;
    committing.current = true;
    onCreate(text, { next });
  }
  useEffect(() => {
    if (!nb.busy) committing.current = false;
  }, [nb.busy]);

  const editor = (
    <Editable
      key={nb.type}
      elRef={el}
      text={nb.initial}
      autoFocus
      readOnly={nb.busy}
      multiline={nb.type === "code"}
      placeholder={PLACEHOLDER[nb.type] ?? ""}
      onInput={(text, node) => {
        if (nb.type === "paragraph" && !text.startsWith("/")) {
          const hit = SHORTCUTS.find(([re]) => re.test(text));
          if (hit) {
            pick(hit[1], text.replace(hit[0], ""));
            return;
          }
        }
        // "/" at the start of an empty block opens the menu; the rest filters.
        setMenu(text.startsWith("/") && !text.includes("\n") ? { filter: text.slice(1), idx: 0 } : null);
      }}
      onKey={(e) => {
        if (!menu) return false;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const d = e.key === "ArrowDown" ? 1 : -1;
          setMenu({ ...menu, idx: items.length ? (menu.idx + d + items.length) % items.length : 0 });
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (items[menu.idx]) pick(items[menu.idx].type);
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMenu(null);
          return true;
        }
        return false;
      }}
      onEnter={(before, after) => {
        const text = before + after;
        if (!text.trim()) {
          // Enter on an empty list item ends the list, like Notion.
          if (nb.type !== "paragraph") pick("paragraph");
          return;
        }
        create(text, true);
      }}
      onBackspaceEmpty={() => (nb.type !== "paragraph" ? pick("paragraph") : onDrop(true))}
      onCommit={(text) => {
        if (switching.current) return;
        if (menu) {
          setMenu(null);
          return;
        }
        if (text.trim()) create(text, false);
        else if (!nb.busy) onDrop(false);
      }}
    />
  );

  return (
    <div className={`n-block${nb.busy ? " busy" : ""}`}>
      <BlockShell type={nb.type} ordinal={ordinal} checked={false}>
        {editor}
      </BlockShell>
      {menu ? (
        <div className="n-menu slash" onMouseDown={(e) => e.preventDefault()}>
          <div className="sec">Basic blocks</div>
          {items.length ? (
            items.map((it, i) => (
              <div
                key={it.type}
                className={`it${i === menu.idx ? " on" : ""}`}
                onMouseEnter={() => setMenu({ ...menu, idx: i })}
                onClick={() => pick(it.type)}
              >
                <span className="ic">{it.ic}</span>
                {it.label}
                {it.hint ? <span className="sub">{it.hint}</span> : null}
              </div>
            ))
          ) : (
            <div className="empty">No results</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
