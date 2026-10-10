// Confluence Cloud (REST v2) fixtures for the page-viewer and page-composer previews. Fictional site and people.
import { Args, UpstreamError, missing } from "../mock-tangram";

export const previews = [
  { component: "page-viewer", title: "Rich page with comments (Load more pages comments)", inputs: { pageId: "1001" }, height: 900 },
  {
    component: "page-composer",
    title: "New page — space picker, agent-drafted body",
    inputs: {
      title: "Q4 on-call rotation",
      body: "## Who\n- Primary: platform team\n- Secondary: data team\n\n## Escalation\n1. Page the primary\n2. After 15 min, page the secondary\n\n> Swap shifts in #oncall, not by DM.",
    },
    height: 640,
  },
  {
    component: "page-composer",
    title: "Editing a page with a table and a macro — lossy warning",
    inputs: { pageId: "1002", body: "# Release checklist\n\nRewritten by the agent." },
    height: 560,
  },
  { component: "page-composer", title: "Editing an existing simple page (round-trips cleanly)", inputs: { pageId: "1003" }, height: 560 },
  { component: "page-viewer", title: "Error — page not found", inputs: { pageId: "404" }, height: 280 },
];

const BASE = "https://acme-demo.atlassian.net/wiki";
const now = Date.now();
const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

const spaces = [
  { id: "65537", key: "ENG", name: "Engineering", type: "global", status: "current", homepageId: "1000" },
  { id: "65538", key: "OPS", name: "Operations", type: "global", status: "current", homepageId: "2000" },
  { id: "65539", key: "PM", name: "Product", type: "global", status: "current", homepageId: "3000" },
];

type Page = {
  id: string;
  title: string;
  spaceId: string;
  parentId?: string;
  status: string;
  createdAt: string;
  version: { number: number; createdAt: string; authorId: string };
  body: { storage: { value: string; representation: "storage" } };
  _links: { webui: string; base: string };
};

const page = (id: string, title: string, spaceId: string, value: string, parentId?: string, v = 3): Page => ({
  id,
  title,
  spaceId,
  parentId,
  status: "current",
  createdAt: ago(60 * 24 * 30),
  version: { number: v, createdAt: ago(95), authorId: "5f1a-alex" },
  body: { storage: { value, representation: "storage" } },
  _links: { webui: `/spaces/${spaces.find((s) => s.id === spaceId)?.key}/pages/${id}`, base: BASE },
});

const RICH = `<h1 local-id="h1">Service overview</h1>
<p>The <strong>billing gateway</strong> fronts every payment call. See the <a href="https://status.example.com">status page</a> or the <ac:link><ri:page ri:content-title="Runbook: billing gateway" /><ac:plain-text-link-body><![CDATA[runbook]]></ac:plain-text-link-body></ac:link>.</p>
<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="a1"><ac:parameter ac:name="title">Heads up</ac:parameter><ac:rich-text-body><p>Deploy freeze runs <em>Dec 18 – Jan 2</em>.</p></ac:rich-text-body></ac:structured-macro>
<h2>Dependencies</h2>
<ul><li>Postgres (primary + 2 replicas)</li><li>Kafka topic <code>payments.events</code></li><li>Fraud scoring service</li></ul>
<h2>Rollback</h2>
<ol start="1"><li>Freeze the deploy pipeline</li><li>Run the rollback job</li><li>Confirm error rate &lt; 0.5%</li></ol>
<ac:structured-macro ac:name="code" ac:macro-id="c1"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[kubectl -n billing rollout undo deploy/gateway
kubectl -n billing rollout status deploy/gateway]]></ac:plain-text-body></ac:structured-macro>
<h2>Owners</h2>
<table><tbody><tr><th>Area</th><th>Team</th><th>Slack</th></tr><tr><td>Gateway</td><td>Payments</td><td>#payments</td></tr><tr><td>Database</td><td>Platform</td><td>#platform</td></tr></tbody></table>
<ac:structured-macro ac:name="warning" ac:macro-id="w1"><ac:rich-text-body><p>Never run migrations during peak hours.</p></ac:rich-text-body></ac:structured-macro>
<blockquote><p>If in doubt, page the on-call first.</p></blockquote>`;

const LOSSY = `<h1>Release checklist</h1><p>Before each release:</p>
<table><tbody><tr><th>Step</th><th>Owner</th></tr><tr><td>Tag build</td><td>Release lead</td></tr></tbody></table>
<ac:structured-macro ac:name="jira" ac:macro-id="j1"><ac:parameter ac:name="jqlQuery">fixVersion = 4.2</ac:parameter></ac:structured-macro>
<ol start="3"><li>Announce in #releases</li></ol>`;

const SIMPLE = `<h1>Team norms</h1><p>We review pull requests within <strong>one working day</strong>.</p>
<ul><li>Small PRs over big ones</li><li>Write the <em>why</em> in the description</li></ul>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">text</ac:parameter><ac:plain-text-body><![CDATA[git commit -m "fix: keep it short"]]></ac:plain-text-body></ac:structured-macro>`;

const pages: Record<string, Page> = {
  "1000": page("1000", "Engineering home", "65537", "<p>Welcome.</p>"),
  "1001": page("1001", "Billing gateway", "65537", RICH, "1000", 7),
  "1002": page("1002", "Release checklist", "65537", LOSSY, "1000", 12),
  "1003": page("1003", "Team norms", "65537", SIMPLE, "1000", 2),
};

type Comment = { id: string; status: string; title: string; pageId: string; version: { number: number; createdAt: string; authorId: string }; body: { storage: { value: string; representation: "storage" } } };
const comment = (id: string, pageId: string, mins: number, author: string, text: string): Comment => ({
  id,
  status: "current",
  title: "Re: page",
  pageId,
  version: { number: 1, createdAt: ago(mins), authorId: author },
  body: { storage: { value: `<p>${text}</p>`, representation: "storage" } },
});

const comments: Record<string, Comment[]> = {
  "1001": [
    comment("c-1", "1001", 60 * 26, "7a2c-sam", "Should we add the fraud service SLO here?"),
    comment("c-2", "1001", 60 * 25, "5f1a-alex", "Good call — added under <strong>Dependencies</strong>."),
    comment("c-3", "1001", 60 * 3, "9d4e-rivka", "The rollback job name changed to <code>gateway-rollback-v2</code>."),
    comment("c-4", "1001", 40, "7a2c-sam", "Updated the runbook link."),
  ],
};

const PAGE_SIZE = 2;
let nextId = 5000;

function listComments(args: Args) {
  const p = args.parameters ?? {};
  const all = [...(comments[String(p.id)] ?? [])];
  if (p.sort === "-created-date") all.reverse();
  // The viewer's own list pages 2 at a time here (to show "Load more"); duplicate-post snapshots read the newest 25.
  const size = p.sort ? Number(p.limit) || 25 : PAGE_SIZE;
  const start = p.cursor ? Number(p.cursor) : 0;
  const slice = all.slice(start, start + size);
  const more = start + slice.length < all.length;
  return {
    results: slice,
    _links: more ? { next: `/wiki/api/v2/pages/${p.id}/footer-comments?cursor=${start + slice.length}&limit=${size}` } : {},
  };
}

function getPage(args: Args): Page {
  const id = String(args.parameters?.id ?? "");
  const p = pages[id];
  if (!p) throw new UpstreamError(404, { statusCode: 404, message: `No content found with id: ContentId{id=${id}}` });
  return p;
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const key = `${resourceType}.${action}`;
  const body = (args.requestBody ?? {}) as Record<string, any>;
  switch (key) {
    case "Site.List":
      return [{ id: "11111111-2222-3333-4444-555555555555", name: "acme-demo", url: "https://acme-demo.atlassian.net", scopes: ["read:page:confluence"] }];
    case "Space.Get": {
      const s = spaces.find((x) => x.id === String(args.parameters?.id));
      if (!s) throw new UpstreamError(404, { message: "Space not found" });
      return s;
    }
    case "Space.List":
      return { results: spaces, _links: {} };
    case "Page.Get":
      return getPage(args);
    case "Page.List": {
      const p = args.parameters ?? {};
      const results = Object.values(pages).filter(
        (x) => (!p["space-id"] || x.spaceId === String(p["space-id"])) && (!p.title || x.title === p.title),
      );
      return { results: results.map(({ body: _b, ...rest }) => rest), _links: {} };
    }
    case "Page.Create": {
      const id = String(nextId++);
      const created = page(id, String(body.title), String(body.spaceId), String(body.body?.value ?? ""), body.parentId, 1);
      created.createdAt = new Date().toISOString();
      pages[id] = created;
      return created;
    }
    case "Page.Update": {
      const current = getPage(args);
      if (body.version?.number !== current.version.number + 1)
        throw new UpstreamError(409, { statusCode: 409, message: "Version must be incremented when updating a page." });
      const updated = {
        ...current,
        title: String(body.title),
        body: { storage: { value: String(body.body?.value ?? ""), representation: "storage" as const } },
        version: { number: body.version.number, createdAt: new Date().toISOString(), authorId: "5f1a-alex" },
      };
      pages[current.id] = updated;
      return updated;
    }
    case "Comment.List":
      return listComments(args);
    case "Comment.Create": {
      const pageId = String(body.pageId);
      const c: Comment = {
        ...comment(`c-${nextId++}`, pageId, 0, "5f1a-alex", ""),
        body: { storage: { value: String(body.body?.value ?? ""), representation: "storage" } },
      };
      (comments[pageId] ??= []).push(c);
      return c;
    }
  }
  return missing(resourceType, action);
}
