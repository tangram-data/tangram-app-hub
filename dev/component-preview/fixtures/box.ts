// Box fixtures: a small All Files tree (folders, files, https + http web links), marker-paged folder listings,
// offset-paged search, file metadata, and downloads in the platform's app_action_result envelope.
import { Args, missing, UpstreamError } from "../mock-tangram";

export const previews = [
  { component: "file-browser", title: "All Files (root), web links, marker paging in Finance", inputs: {}, height: 560 },
  { component: "file-browser", title: "Search “budget”", inputs: { query: "budget" }, height: 520 },
  { component: "file-viewer", title: "CSV file — table preview", inputs: { fileId: "1102" }, height: 600 },
  { component: "file-viewer", title: "PDF — not previewed, save to workspace files", inputs: { fileId: "1104" }, height: 420 },
  { component: "file-viewer", title: "Error — file not found", inputs: { fileId: "9999" }, height: 260 },
];

type Entry = { id: string; name: string };
type User = { type: "user"; id: string; name: string; login: string };

const ana: User = { type: "user", id: "501", name: "Ana Ortiz", login: "ana@example.com" };
const ben: User = { type: "user", id: "502", name: "Ben Okafor", login: "ben@example.com" };
const chen: User = { type: "user", id: "503", name: "Chen Wei", login: "chen@example.com" };

const day = (d: number, h = 10) => new Date(Date.UTC(2026, 9, 10 - d, h, 12)).toISOString().replace(".000Z", "-07:00");

type Node = {
  type: "file" | "folder" | "web_link";
  id: string;
  name: string;
  parent: string;
  size?: number;
  modified_at: string;
  modified_by: User;
  owned_by?: User;
  description?: string;
  url?: string;
};

const ALL_FILES: Entry = { id: "0", name: "All Files" };

const nodes: Node[] = [
  { type: "folder", id: "101", name: "Finance", parent: "0", size: 18_422_113, modified_at: day(0), modified_by: ana },
  { type: "folder", id: "102", name: "Marketing", parent: "0", size: 96_120_400, modified_at: day(3), modified_by: ben },
  { type: "folder", id: "103", name: "Contracts", parent: "0", size: 4_201_998, modified_at: day(12), modified_by: chen },
  { type: "file", id: "1101", name: "Q3 board notes.md", parent: "0", size: 6_180, modified_at: day(0, 8), modified_by: ana,
    description: "Notes for the Q3 board meeting" },
  { type: "file", id: "1102", name: "budget-2026.csv", parent: "101", size: 2_944, modified_at: day(1), modified_by: ana,
    description: "Department budgets by quarter (USD)" },
  { type: "file", id: "1103", name: "Budget review — FY26.pptx", parent: "101", size: 3_811_220, modified_at: day(4), modified_by: ben },
  { type: "file", id: "1104", name: "Vendor agreement — Northwind.pdf", parent: "103", size: 412_877, modified_at: day(30), modified_by: chen,
    description: "Signed master services agreement" },
  { type: "file", id: "1105", name: "Launch plan.docx", parent: "102", size: 88_214, modified_at: day(2), modified_by: ben },
  { type: "file", id: "1106", name: "brand-colors.json", parent: "102", size: 512, modified_at: day(40), modified_by: ben },
  { type: "web_link", id: "1201", name: "Company handbook", parent: "0", modified_at: day(20), modified_by: chen,
    url: "https://handbook.example.com" },
  { type: "web_link", id: "1202", name: "Legacy intranet (http)", parent: "0", modified_at: day(200), modified_by: chen,
    url: "http://intranet.example.local/home" },
];

// 64 monthly statements in Finance, so its listing needs two marker pages.
for (let i = 0; i < 64; i++) {
  const y = 2021 + Math.floor(i / 12);
  const m = String((i % 12) + 1).padStart(2, "0");
  nodes.push({ type: "file", id: String(1300 + i), name: `Statement ${y}-${m}.pdf`, parent: "101",
    size: 140_000 + ((i * 7919) % 90_000), modified_at: day(60 + i * 30), modified_by: ana });
}

const byId = new Map(nodes.map((n) => [n.id, n]));

function pathOf(n: Node): Entry[] {
  const path: Entry[] = [];
  let p = n.parent;
  while (p !== "0") {
    const parent = byId.get(p)!;
    path.unshift({ id: parent.id, name: parent.name });
    p = parent.parent;
  }
  return [ALL_FILES, ...path];
}

function mini(n: Node) {
  const base = { type: n.type, id: n.id, etag: "0", name: n.name };
  return n.type === "file" ? { ...base, sequence_id: "0", sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" } : base;
}

// A listing row with the fields the component asks for (Box returns only requested fields + type/id/etag).
function row(n: Node) {
  const ext = n.type === "file" && n.name.includes(".") ? n.name.split(".").pop()!.toLowerCase() : undefined;
  return {
    ...mini(n),
    size: n.type === "web_link" ? undefined : n.size,
    modified_at: n.modified_at,
    modified_by: n.modified_by,
    ...(ext ? { extension: ext } : {}),
    ...(n.url ? { url: n.url } : {}),
  };
}

function full(n: Node) {
  return {
    ...row(n),
    description: n.description ?? "",
    created_at: n.modified_at,
    owned_by: n.owned_by ?? n.modified_by,
    path_collection: { total_count: pathOf(n).length, entries: pathOf(n).map((e) => ({ type: "folder", ...e })) },
    shared_link: null,
  };
}

function notFound(kind: string, id: string): never {
  throw new UpstreamError(404, {
    type: "error",
    status: 404,
    code: "not_found",
    message: `Not Found`,
    context_info: { errors: [{ reason: "invalid_parameter", name: `${kind}_id`, message: `Invalid value '${id}'.` }] },
    request_id: "f7k2pq3h9x1mz0aa",
  });
}

function listFolder(p: Record<string, unknown>) {
  const id = String(p.folder_id ?? "0");
  if (id !== "0" && byId.get(id)?.type !== "folder") notFound("folder", id);
  const limit = Math.min(Number(p.limit) || 100, 1000);
  const children = nodes
    .filter((n) => n.parent === id)
    .sort((a, b) => (a.type === "folder") === (b.type === "folder") ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1);
  if (p.usemarker === true || p.usemarker === "true") {
    const start = p.marker ? Number(atob(String(p.marker)).replace("pos:", "")) : 0;
    const page = children.slice(start, start + limit);
    const next = start + limit < children.length ? btoa(`pos:${start + limit}`) : null;
    return { limit, entries: page.map(row), next_marker: next, prev_marker: null };
  }
  const offset = Number(p.offset) || 0;
  return {
    total_count: children.length,
    offset,
    limit,
    order: [{ by: "type", direction: "ASC" }, { by: "name", direction: "ASC" }],
    entries: children.slice(offset, offset + limit).map(row),
  };
}

function search(p: Record<string, unknown>) {
  const words = String(p.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.min(Number(p.limit) || 30, 200);
  const offset = Number(p.offset) || 0;
  if (offset > 10000) throw new UpstreamError(400, { type: "error", status: 400, code: "bad_request", message: "offset must be <= 10000" });
  const hits = nodes.filter((n) => words.every((w) => `${n.name} ${n.description ?? ""}`.toLowerCase().includes(w)));
  return {
    total_count: hits.length,
    limit,
    offset,
    type: "search_results_items",
    entries: hits.slice(offset, offset + limit).map(full),
  };
}

const CSV = `Department,Q1,Q2,Q3,Q4,Owner
Engineering,412000,431500,455000,470250,Ana Ortiz
Marketing,180000,205000,198500,240000,Ben Okafor
Sales,265000,270000,288000,301000,Chen Wei
Support,98000,99500,101000,104500,Ana Ortiz
"Facilities, HQ",54000,54000,56500,57000,Ben Okafor
Legal,72000,70000,74500,76000,Chen Wei
`;

const TEXT: Record<string, string> = {
  "1101": `# Q3 board notes

## Highlights
- Revenue up 14% QoQ; churn steady at 2.1%.
- Northwind agreement signed (see Contracts).

## Decisions
1. Approve FY26 budget draft for review.
2. Hire two support engineers in Q4.

## Follow-ups
- Ben: launch plan dates by Oct 20.
- Chen: renewal terms for legacy vendors.
`,
  "1102": CSV,
  "1106": JSON.stringify({ primary: "#0061d5", secondary: "#2a62b9", accent: "#26874a" }, null, 2),
};

function envelope(contentType: string, text: string) {
  return { kind: "app_action_result", contentType, sizeBytes: new TextEncoder().encode(text).length, text };
}

function download(p: Record<string, unknown>) {
  const id = String(p.file_id ?? "");
  const n = byId.get(id);
  if (!n || n.type !== "file") notFound("file", id);
  if (id === "1106") return JSON.parse(TEXT[id]); // a JSON file passes through un-enveloped
  if (TEXT[id] !== undefined) return envelope(id === "1102" ? "text/csv" : "text/markdown", TEXT[id]);
  const name = n.name.replace(/[^\w.-]+/g, "_");
  return {
    kind: "app_action_result",
    contentType: name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    sizeBytes: n.size,
    file: { workspace: "acme", folder: "preview-user/app_action_results/7f3a91", name },
  };
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const p = args.parameters ?? {};
  switch (`${resourceType}.${action}`) {
    case "Item.Search":
      return search(p);
    case "Folder.ListItems":
      return listFolder(p);
    case "File.Get": {
      const id = String(p.file_id ?? "");
      const n = byId.get(id);
      if (!n || n.type !== "file") notFound("file", id);
      return full(n);
    }
    case "File.Download":
      return download(p);
    default:
      return missing(resourceType, action);
  }
}
