// Read-only renderer over the connector's Document.Get action. Walks the
// Docs API structural elements and renders a safe subset — headings,
// paragraphs (bold/italic/underline/links), bullet lists, and tables — as
// plain React nodes; anything else (images, drawings, TOC) is skipped. An
// Edit button emits an `edit` output for wiring to the doc-composer.
import { EditOutlined, ExportOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Spin } from "antd";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/google.css";
import "../../shared/tangram-buttons.css";

const tangram = (window as any).tangram;

type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  link?: { url?: string };
};
type TextRun = { content?: string; textStyle?: TextStyle };
type ParagraphElement = { textRun?: TextRun };
type Paragraph = {
  elements?: ParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
};
type StructuralElement = { paragraph?: Paragraph; table?: DocTable };
type DocTable = { tableRows?: { tableCells?: { content?: StructuralElement[] }[] }[] };
type ListDef = { listProperties?: { nestingLevels?: { glyphType?: string }[] } };
type GoogleDoc = {
  documentId?: string;
  title?: string;
  body?: { content?: StructuralElement[] };
  lists?: Record<string, ListDef>;
};

// List glyphs and ordinal counters, keyed "listId:level"; counters for deeper
// levels reset whenever a shallower item of the same list appears.
type RenderCtx = { lists: Record<string, ListDef>; counters: Map<string, number> };

function safeHref(url?: string): string {
  return url && /^https?:\/\//i.test(url) ? url : "";
}

function romanize(n: number): string {
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

function alphaize(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function listMarker(glyphType: string, n: number): string {
  switch (glyphType) {
    case "DECIMAL":
    case "ZERO_DECIMAL":
      return `${n}.`;
    case "ALPHA":
      return `${alphaize(n)}.`;
    case "UPPER_ALPHA":
      return `${alphaize(n).toUpperCase()}.`;
    case "ROMAN":
      return `${romanize(n)}.`;
    case "UPPER_ROMAN":
      return `${romanize(n).toUpperCase()}.`;
    default:
      return "•";
  }
}

const NUMBERED_GLYPHS = /^(DECIMAL|ZERO_DECIMAL|ALPHA|UPPER_ALPHA|ROMAN|UPPER_ROMAN)$/;

function bulletMarker(bullet: NonNullable<Paragraph["bullet"]>, ctx: RenderCtx): string {
  const listId = bullet.listId ?? "";
  const level = bullet.nestingLevel ?? 0;
  const glyph =
    ctx.lists[listId]?.listProperties?.nestingLevels?.[level]?.glyphType ?? "";
  if (!NUMBERED_GLYPHS.test(glyph)) return "•";
  const key = `${listId}:${level}`;
  const n = (ctx.counters.get(key) ?? 0) + 1;
  ctx.counters.set(key, n);
  for (const k of [...ctx.counters.keys()]) {
    const [id, lvl] = [k.slice(0, k.lastIndexOf(":")), Number(k.slice(k.lastIndexOf(":") + 1))];
    if (id === listId && lvl > level) ctx.counters.delete(k);
  }
  return listMarker(glyph, n);
}

function renderRun(run: TextRun, key: number): React.ReactNode {
  const text = run.content ?? "";
  if (!text) return null;
  const s = run.textStyle ?? {};
  let node: React.ReactNode = text;
  if (s.bold) node = <strong>{node}</strong>;
  if (s.italic) node = <em>{node}</em>;
  if (s.underline && !s.link) node = <u>{node}</u>;
  const href = safeHref(s.link?.url);
  if (href) {
    node = (
      <a href={href} target="_blank" rel="noreferrer">
        {node}
      </a>
    );
  }
  return <React.Fragment key={key}>{node}</React.Fragment>;
}

// Heading elements inside the page (g-doc styles them like Docs).
const HEADING_TAG: Record<string, "h1" | "h2" | "h3"> = {
  TITLE: "h1",
  HEADING_1: "h1",
  HEADING_2: "h2",
  HEADING_3: "h3",
};

function renderParagraph(p: Paragraph, key: number, ctx: RenderCtx): React.ReactNode {
  const runs = (p.elements ?? []).map((el, i) => (el.textRun ? renderRun(el.textRun, i) : null));
  const text = (p.elements ?? []).map((el) => el.textRun?.content ?? "").join("");
  if (!text.trim()) return <div key={key} style={{ height: 8 }} />;
  const style = p.paragraphStyle?.namedStyleType ?? "";
  if (p.bullet) {
    return (
      <div key={key} style={{ marginLeft: 16 + (p.bullet.nestingLevel ?? 0) * 18, marginBottom: 2 }}>
        {bulletMarker(p.bullet, ctx)} {runs}
      </div>
    );
  }
  const Tag = HEADING_TAG[style];
  if (Tag) {
    return (
      <Tag key={key} style={style === "TITLE" ? { fontSize: 30 } : undefined}>
        {runs}
      </Tag>
    );
  }
  if (style.startsWith("HEADING_")) {
    return (
      <div key={key} className="h4">
        {runs}
      </div>
    );
  }
  return <p key={key}>{runs}</p>;
}

function renderElements(elements: StructuralElement[], ctx: RenderCtx): React.ReactNode[] {
  return elements.map((el, i) => {
    if (el.paragraph) return renderParagraph(el.paragraph, i, ctx);
    if (el.table) {
      return (
        <table key={i}>
          <tbody>
            {(el.table.tableRows ?? []).map((row, r) => (
              <tr key={r}>
                {(row.tableCells ?? []).map((cell, c) => (
                  <td key={c}>
                    {renderElements(cell.content ?? [], ctx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return null;
  });
}

type State =
  | { kind: "init" }
  | { kind: "loading" }
  | { kind: "ready"; doc: GoogleDoc }
  | { kind: "error"; message: string };

export default function DocViewer() {
  const [documentId, setDocumentId] = useState("");
  const [state, setState] = useState<State>({ kind: "init" });
  // Guards stale responses when the target document changes mid-fetch.
  const loadSeq = useRef(0);

  function load(id: string) {
    if (!id) {
      setState({ kind: "error", message: "No documentId provided." });
      return;
    }
    const seq = ++loadSeq.current;
    setState({ kind: "loading" });
    tangram
      .performAction({ resourceType: "Document", action: "Get" }, { parameters: { documentId: id } })
      .then((doc: GoogleDoc) => {
        if (seq !== loadSeq.current) return;
        setState({ kind: "ready", doc });
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }

  useEffect(() => {
    // Track the applied id locally (not via a state updater — those must stay
    // side-effect free) so token-renewal replays of the same id don't refetch.
    let lastId = "";
    const apply = (inputs: Record<string, unknown>) => {
      const id = String(inputs?.documentId ?? "").trim();
      if (!id || id === lastId) return;
      lastId = id;
      setDocumentId(id);
      load(id);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, []);

  const doc = state.kind === "ready" ? state.doc : null;
  const docUrl = documentId ? `https://docs.google.com/document/d/${documentId}/edit` : "";

  return (
    <div className="g-root">
      <div className="g-appbar">
        <span className="g-fileicon lg" style={{ background: "#4285f4" }} aria-hidden="true">
          DOC
        </span>
        <span className="t" title={doc?.title ?? ""}>
          {doc?.title ?? "Document"}
        </span>
        <Button
          type="text"
          shape="circle"
          aria-label="Reload"
          icon={<ReloadOutlined aria-hidden="true" />}
          disabled={state.kind === "loading" || !documentId}
          onClick={() => load(documentId)}
        />
        {docUrl ? (
          <Button icon={<ExportOutlined aria-hidden="true" />} href={docUrl} target="_blank" rel="noreferrer">
            Open
          </Button>
        ) : null}
        <Button
          icon={<EditOutlined aria-hidden="true" />}
          disabled={!doc}
          onClick={() => tangram.emit("edit", { documentId, title: doc?.title ?? "" })}
        >
          Append
        </Button>
      </div>
      {state.kind === "loading" || state.kind === "init" ? (
        <Spin style={{ display: "block", margin: "24px auto" }} />
      ) : null}
      {state.kind === "error" ? <div className="g-error">{state.message}</div> : null}
      {doc ? (
        <div className="g-canvas">
          <div className="g-doc page" style={{ wordBreak: "break-word" }}>
            {renderElements(doc.body?.content ?? [], { lists: doc.lists ?? {}, counters: new Map() })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
