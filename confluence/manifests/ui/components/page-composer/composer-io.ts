// Confluence reads the page composer needs: page links, cursor paging, spaces, and the pages already holding a title.
const tangram = (window as any).tangram;

export type Space = { id: string; key?: string; name?: string };
export type Page = {
  id: string;
  title?: string;
  spaceId?: string;
  parentId?: string;
  version?: { number?: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
};

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function cursorOf(next?: string): string {
  if (!next) return "";
  const q = next.indexOf("?");
  return q < 0 ? "" : new URLSearchParams(next.slice(q + 1)).get("cursor") ?? "";
}

// The host relay opens https only.
export function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  if (tangram?.openUrl) tangram.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export async function pageUrl(p: Page): Promise<string> {
  if (!p._links?.webui) return "";
  if (p._links.base) return p._links.base + p._links.webui;
  const sites = (await tangram.performAction({ resourceType: "Site", action: "List" }, {}).catch(() => [])) as {
    url?: string;
  }[];
  return Array.isArray(sites) && sites.length === 1 && sites[0].url ? `${sites[0].url}/wiki${p._links.webui}` : "";
}

export const getPage = (id: string): Promise<Page> =>
  tangram.performAction({ resourceType: "Page", action: "Get" }, { parameters: { id, "body-format": "storage" } });

// Every space, cursor by cursor (bounded).
export async function allSpaces(): Promise<Space[]> {
  const all: Space[] = [];
  let cursor = "";
  for (let n = 0; n < 20; n++) {
    const r = await tangram.performAction({ resourceType: "Space", action: "List" }, {
      parameters: { limit: 250, status: "current", ...(cursor ? { cursor } : {}) },
    });
    all.push(...((r?.results as Space[]) ?? []));
    cursor = cursorOf(r?._links?.next);
    if (!cursor) break;
  }
  return all;
}

// Pages already titled `wanted` in the space: none of them can be the result of a create about to happen.
export const titledPages = (space: string, wanted: string): Promise<Page[]> =>
  tangram
    .performAction({ resourceType: "Page", action: "List" }, {
      parameters: { "space-id": space, title: wanted, status: "current", limit: 50 },
    })
    .then((r: { results?: Page[] }) => r?.results ?? []);
