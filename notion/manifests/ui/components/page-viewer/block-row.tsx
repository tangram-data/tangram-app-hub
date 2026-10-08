// One top-level block row: Notion hover handles (+ and ⋮⋮ menu) and, for
// plain-text blocks, the inline contentEditable line that saves on blur.
import React, { useEffect, useRef, useState } from "react";
import { BlockNode, BlockShell, renderRich } from "./block-render";
import { Editable } from "./editable";
import { Block, canEditInline, payload, plainText } from "./notion-blocks";

export type RowApi = {
  // False for trashed pages: everything renders read-only.
  editable: boolean;
  deletingId: string;
  saveText: (block: Block, text: string) => void;
  toggleTodo: (block: Block) => void;
  // False when another new block is still being created.
  openDraft: (after: string, type: string, initial: string) => boolean;
  // Enter mid-line on an existing block (tail appended first, then head saved).
  splitBlock: (block: Block, before: string, after: string) => boolean;
  remove: (block: Block) => void;
};

const TYPE_LABEL: Record<string, string> = {
  paragraph: "Text", heading_1: "Heading 1", heading_2: "Heading 2", heading_3: "Heading 3",
  bulleted_list_item: "Bulleted list", numbered_list_item: "Numbered list", to_do: "To-do",
  toggle: "Toggle", quote: "Quote", callout: "Callout", code: "Code", divider: "Divider",
};

// Enter continues lists and to-dos, like Notion; everything else starts Text.
export function continueType(type: string): string {
  return ["bulleted_list_item", "numbered_list_item", "to_do"].includes(type) ? type : "paragraph";
}

export function BlockRow({ block, ordinal, api }: { block: Block; ordinal: number; api: RowApi }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const el = useRef<HTMLDivElement | null>(null);
  const p = payload(block);
  const inline = api.editable && canEditInline(block);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !handleRef.current?.contains(t)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    menuRef.current?.querySelector<HTMLButtonElement>("button.it")?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  // Roving focus over the menu items; Escape returns focus to the handle.
  function menuKey(e: React.KeyboardEvent) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button.it") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      items[(i + d + items.length) % items.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setMenu(false);
      handleRef.current?.focus();
    }
  }
  const choose = (fn: () => void) => () => {
    setMenu(false);
    fn();
  };

  // Checking a to-do never touches its text, so formatted to-dos toggle too.
  const todoLine = block.type === "to_do" || inline;
  const line = todoLine ? (
    <BlockShell
      type={block.type}
      ordinal={ordinal}
      checked={p.checked}
      onCheck={api.editable ? () => api.toggleTodo(block) : undefined}
      icon={p.icon?.type === "emoji" ? p.icon.emoji : undefined}
      language={p.language}
    >
      {inline ? (
        <Editable
          elRef={el}
          text={plainText(block)}
          multiline={block.type === "code"}
          placeholder={block.type === "paragraph" ? "Write something…" : TYPE_LABEL[block.type]}
          // The write queue compares against the last sent/confirmed value.
          onCommit={(t) => api.saveText(block, t)}
          onEnter={(before, after) => {
            // Caret at the start: open a fresh block below, text stays put.
            if (!before) {
              api.openDraft(block.id, "paragraph", "");
              return;
            }
            // Caret at the end: a fresh (continued) block below.
            if (!after) {
              api.openDraft(block.id, continueType(block.type), "");
              return;
            }
            // Mid-text: a coordinated split; the head shows `before` meanwhile.
            if (api.splitBlock(block, before, after) && el.current) el.current.textContent = before;
          }}
        />
      ) : (
        <div className="n-editable">{renderRich(p.rich_text, block.id)}</div>
      )}
    </BlockShell>
  ) : undefined;

  return (
    <div
      className={`n-block${api.deletingId === block.id ? " busy" : ""}${menu ? " sel" : ""}`}
      id={`blk-${block.id}`}
    >
      {api.editable ? (
        <div className="n-handles">
          <button
            type="button"
            className="n-handle"
            title="Click to add a block below"
            onClick={() => api.openDraft(block.id, "paragraph", "")}
          >
            +
          </button>
          <button
            type="button"
            ref={handleRef}
            className="n-handle"
            title="Block menu"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            ⋮⋮
          </button>
        </div>
      ) : null}
      <BlockNode block={block} depth={0} ordinal={ordinal} line={line} />
      {menu ? (
        <div className="n-menu" ref={menuRef} role="menu" onKeyDown={menuKey}>
          <div className="sec">{TYPE_LABEL[block.type] ?? block.type.replace(/_/g, " ")}</div>
          {api.editable && !inline && block.type !== "divider" ? (
            <div className="empty" style={{ fontSize: 12 }}>
              Read-only here (formatting or block type) — open in Notion to edit
            </div>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="it"
            onClick={choose(() => api.openDraft(block.id, "paragraph", ""))}
          >
            <span className="ic">+</span>Add block below
          </button>
          <button type="button" role="menuitem" className="it danger" onClick={choose(() => api.remove(block))}>
            <span className="ic">🗑</span>Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
