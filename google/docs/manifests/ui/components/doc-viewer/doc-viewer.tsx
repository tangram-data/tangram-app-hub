// Read-only renderer over the connector's Document.Get action. Walks the
// Docs API structural elements and renders a safe subset — headings,
// paragraphs (bold/italic/underline/links), bullet lists, and tables — as
// plain React nodes; anything else (images, drawings, TOC) is skipped. An
// Edit button emits an `edit` output for wiring to the doc-composer.
import { EditOutlined, LinkOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Spin, Typography } from "antd";
import React, { useEffect, useRef, useState } from "react";

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

// Heading render sizes; the document h1 maps below the component chrome.
const HEADING_LEVEL: Record<string, 3 | 4 | 5> = {
  TITLE: 3,
  HEADING_1: 4,
  HEADING_2: 5,
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
  const level = HEADING_LEVEL[style];
  if (level) {
    return (
      <Typography.Title key={key} level={level} style={{ marginTop: 14, marginBottom: 6 }}>
        {runs}
      </Typography.Title>
    );
  }
  if (style.startsWith("HEADING_")) {
    return (
      <Typography.Text key={key} strong style={{ display: "block", marginTop: 10, marginBottom: 4 }}>
        {runs}
      </Typography.Text>
    );
  }
  return (
    <div key={key} style={{ marginBottom: 6, lineHeight: 1.55 }}>
      {runs}
    </div>
  );
}

function renderElements(elements: StructuralElement[], ctx: RenderCtx): React.ReactNode[] {
  return elements.map((el, i) => {
    if (el.paragraph) return renderParagraph(el.paragraph, i, ctx);
    if (el.table) {
      return (
        <table key={i} style={{ borderCollapse: "collapse", margin: "8px 0", width: "100%" }}>
          <tbody>
            {(el.table.tableRows ?? []).map((row, r) => (
              <tr key={r}>
                {(row.tableCells ?? []).map((cell, c) => (
                  <td key={c} style={{ border: "1px solid #d9d9d9", padding: "4px 8px", verticalAlign: "top" }}>
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
          {doc?.title ?? "Document"}
        </Typography.Title>
        <Space size={8}>
          {docUrl ? (
            <Typography.Link href={docUrl} target="_blank" rel="noreferrer">
              <LinkOutlined /> Open in Google Docs
            </Typography.Link>
          ) : null}
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!doc}
            onClick={() =>
              tangram.emit("edit", { documentId, title: doc?.title ?? "" })
            }
          >
            Append
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            disabled={state.kind === "loading" || !documentId}
            onClick={() => load(documentId)}
          />
        </Space>
      </Space>
      {state.kind === "loading" || state.kind === "init" ? (
        <Spin style={{ display: "block", margin: "24px auto" }} />
      ) : null}
      {state.kind === "error" ? <Alert type="error" showIcon message={state.message} /> : null}
      {doc ? (
        <div style={{ wordBreak: "break-word" }}>
          {renderElements(doc.body?.content ?? [], { lists: doc.lists ?? {}, counters: new Map() })}
        </div>
      ) : null}
    </div>
  );
}
