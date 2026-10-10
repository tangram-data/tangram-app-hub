// The draft as it will read in Confluence: draft → storage (storage-draft.ts) → the page viewer's allowlisted
// renderer, re-rendered ~150 ms after typing stops.
import React, { useEffect, useState } from "react";
import { StorageBody } from "../page-viewer/storage-render";
import { draftToStorage } from "./storage-draft";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function DraftPreview({ draft, label, context }: { draft: string; label: string; context?: string }) {
  const shown = useDebounced(draft, 150);
  return (
    <div className="a-preview" aria-label={label} aria-live="polite">
      <div className="lbl">{label}</div>
      {context ? <div className="ctx">{context}</div> : null}
      {shown.trim() ? <StorageBody xhtml={draftToStorage(shown)} /> : <p className="a-hint">Nothing to preview yet.</p>}
    </div>
  );
}
