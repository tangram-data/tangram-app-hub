// An update whose response was lost, captured immutably at the moment it was sent, and the only thing reconciliation
// compares against. It landed iff the same page now has a newer version, the sent title and a body that reads the same
// as the sent body (canonical storage form — never plain text, never a suffix). An unchanged version means nothing
// happened and a retry is safe; anything else stays unknown.
import { Page, getPage } from "./composer-io";
import { sameStorage } from "./storage-draft";

export type UpdateAttempt = {
  readonly pageId: string;
  readonly gen: number; // input generation the attempt belongs to
  readonly mode: "append" | "whole";
  readonly title: string;
  readonly sentBody: string; // exact storage sent
  readonly baseVersion: number;
  readonly bodyEdited: boolean; // whole mode: the body (not just the title) was being changed
  readonly draft: string; // whole mode: the markdown that produced sentBody (baseline once it lands)
};

export type Reconciled = { outcome: "landed" | "unchanged" | "unknown"; page: Page };

export function judge(a: UpdateAttempt, page: Page): Reconciled["outcome"] {
  const version = page.version?.number ?? 0;
  if (page.id !== a.pageId) return "unknown";
  if (version === a.baseVersion) return "unchanged";
  if (version > a.baseVersion && (page.title ?? "") === a.title && sameStorage(page.body?.storage?.value ?? "", a.sentBody))
    return "landed";
  return "unknown";
}

export async function reconcile(a: UpdateAttempt): Promise<Reconciled> {
  const page = await getPage(a.pageId);
  return { outcome: judge(a, page), page };
}

// What "again anyway" sends on top of the latest page: the section appended to it, an edited whole body as is, or —
// when only the title was changing — the latest body untouched (never the older body the attempt was based on).
export function retryBody(a: UpdateAttempt, latestStorage: string, appended: string, wholeBody: string): string {
  if (a.mode === "append") return latestStorage + appended;
  return a.bodyEdited ? wholeBody : latestStorage;
}

// The page read right after a successful save is exactly that save: the version the save produced (the response's,
// else base + 1; 1 for a new page) and a body that reads as sent. Otherwise someone saved in between.
export function isOurSave(read: Page, response: Page, sentBody: string, baseVersion: number | null): boolean {
  const expected = response.version?.number ?? (baseVersion == null ? 1 : baseVersion + 1);
  return (read.version?.number ?? -1) === expected && sameStorage(read.body?.storage?.value ?? "", sentBody);
}
