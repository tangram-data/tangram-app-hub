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
  const el = useRef<HTMLDivElement | null>(null);
  const p = payload(block);
  const inline = api.editable && canEditInline(block);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

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
          onCommit={(t) => {
            if (t !== plainText(block)) api.saveText(block, t);
          }}
          onEnter={(before, after) => {
            // Caret at the start: open a fresh block below, text stays put.
            if (!before) {
              api.openDraft(block.id, "paragraph", "");
              return;
            }
            // Otherwise split: the tail moves into the new block (this line
            // saves on the blur that follows).
            if (api.openDraft(block.id, continueType(block.type), after) && after && el.current) {
              el.current.textContent = before;
            }
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
          <button type="button" className="n-handle" title="Block menu" onClick={() => setMenu((v) => !v)}>
            ⋮⋮
          </button>
        </div>
      ) : null}
      <BlockNode block={block} depth={0} ordinal={ordinal} line={line} />
      {menu ? (
        <div className="n-menu" ref={menuRef}>
          <div className="sec">{TYPE_LABEL[block.type] ?? block.type.replace(/_/g, " ")}</div>
          {api.editable && !inline && block.type !== "divider" ? (
            <div className="empty" style={{ fontSize: 12 }}>
              Read-only here (formatting or block type) — open in Notion to edit
            </div>
          ) : null}
          <div
            className="it"
            onClick={() => {
              setMenu(false);
              api.openDraft(block.id, "paragraph", "");
            }}
          >
            <span className="ic">+</span>Add block below
          </div>
          <div
            className="it danger"
            onClick={() => {
              setMenu(false);
              api.remove(block);
            }}
          >
            <span className="ic">🗑</span>Delete
          </div>
        </div>
      ) : null}
    </div>
  );
}
