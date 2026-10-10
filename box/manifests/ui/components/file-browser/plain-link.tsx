// An http bookmark: the host only opens https links, so its URL is shown to copy instead.
import { CopyOutlined } from "@ant-design/icons";
import { Button } from "antd";
import React, { useRef, useState } from "react";
import { BoxItem } from "../../shared/box-format";

export function PlainLink({ item, onClose }: { item: BoxItem; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState("");
  const url = (item.url ?? "").trim();

  function selectText() {
    input.current?.focus();
    input.current?.select();
  }

  function copy() {
    const done = () => setCopied("Copied");
    const fallback = () => {
      selectText();
      setCopied("Selected — press ⌘C / Ctrl+C to copy");
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, fallback);
    else fallback();
  }

  return (
    <div className="bx-note" role="status" style={{ margin: "0 16px 12px" }}>
      <b style={{ display: "block" }}>{item.name}</b>
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0" }}>
        <input
          ref={input}
          readOnly
          value={url}
          aria-label="Link address"
          onFocus={selectText}
          style={{ flex: 1, minWidth: 0, font: "inherit", padding: "2px 6px", border: "1px solid var(--bx-line)", borderRadius: 4 }}
        />
        <Button size="small" icon={<CopyOutlined aria-hidden="true" />} onClick={copy}>
          Copy
        </Button>
        <Button size="small" type="text" onClick={onClose}>
          Close
        </Button>
      </div>
      <span className="bx-faint">
        {copied || "Only https links open from here — copy this http address and open it in your browser."}
      </span>
    </div>
  );
}
