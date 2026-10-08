// The agent's proposed content (`draft` input) shown as a highlighted pending
// insertion at the end of the page; the user previews/edits, then confirms.
import { Button, Input } from "antd";
import React, { useState } from "react";
import { BlockShell } from "./block-render";
import { parseContent } from "./notion-blocks";

function spanText(block: Record<string, any>): string {
  const rich = block[block.type]?.rich_text ?? [];
  return rich.map((s: any) => s?.text?.content ?? "").join("");
}

function Preview({ draft }: { draft: string }) {
  let n = 0;
  return (
    <>
      {parseContent(draft).map(({ block, line }) => {
        const ordinal = block.type === "numbered_list_item" ? ++n : (n = 0);
        if (block.type === "divider") return <hr key={line} className="n-divider" />;
        const p = (block as Record<string, any>)[block.type] ?? {};
        return (
          <div key={line} className="n-block">
            <BlockShell type={block.type} ordinal={ordinal} checked={Boolean(p.checked)} language={p.language}>
              <div className="n-editable">{spanText(block)}</div>
            </BlockShell>
          </div>
        );
      })}
    </>
  );
}

export function PendingDraft({
  draft,
  setDraft,
  saving,
  error,
  onAppend,
  onDiscard,
}: {
  draft: string;
  setDraft: (text: string) => void;
  saving: boolean;
  error: string;
  onAppend: () => void;
  onDiscard: () => void;
}) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="n-pending" id="n-pending">
      <div className="label">Suggested addition — not on the page yet</div>
      {raw ? (
        <Input.TextArea
          className="n-plain"
          autoSize={{ minRows: 3, maxRows: 16 }}
          value={draft}
          disabled={saving}
          placeholder={"# heading, - bullet, 1. numbered, [] to-do, > quote, --- divider, ``` code"}
          onChange={(e) => setDraft(e.target.value)}
          style={{ fontSize: 15, padding: 0, border: 0, background: "transparent", boxShadow: "none" }}
        />
      ) : (
        <Preview draft={draft} />
      )}
      {error ? <div className="n-error">{error}</div> : null}
      <div className="n-bar">
        <Button size="small" type="text" disabled={saving} onClick={onDiscard}>
          Discard
        </Button>
        <span className="sp" />
        <Button size="small" disabled={saving} onClick={() => setRaw((v) => !v)}>
          {raw ? "Preview" : "Edit"}
        </Button>
        <Button size="small" type="primary" loading={saving} disabled={!draft.trim()} onClick={onAppend}>
          Append to page
        </Button>
      </div>
    </div>
  );
}
