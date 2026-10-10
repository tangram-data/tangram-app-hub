// HubSpot connector helpers shared by the record-viewer and deal-board components:
// action calls, owner / property / pipeline lookups (cached per page load) and value formatting.
import dayjs from "dayjs";

const tangram = (window as any).tangram;

export type ObjectType = "contacts" | "companies" | "deals" | "tickets";
export const OBJECT_TYPES: ObjectType[] = ["contacts", "companies", "deals", "tickets"];

// Manifest resource type behind each CRM object type.
export const RESOURCE: Record<ObjectType, string> = {
  contacts: "Contact",
  companies: "Company",
  deals: "Deal",
  tickets: "Ticket",
};

export const SINGULAR: Record<ObjectType, string> = {
  contacts: "Contact",
  companies: "Company",
  deals: "Deal",
  tickets: "Ticket",
};

export type CrmRecord = { id: string; properties?: Record<string, string | null>; associations?: Record<string, { results?: { id: string; type?: string }[] }> };
export type PropertyDef = { name: string; label?: string; type?: string; fieldType?: string; options?: { label: string; value: string }[] };
export type Stage = { id: string; label: string; displayOrder?: number; metadata?: Record<string, string> };
export type Pipeline = { id: string; label: string; displayOrder?: number; stages?: Stage[] };
export type Owner = { id: string; email?: string; firstName?: string; lastName?: string };

export function call<T>(resourceType: string, action: string, args: Record<string, unknown>): Promise<T> {
  return tangram.performAction({ resourceType, action }, args) as Promise<T>;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Lookups are fetched once per page load; a failed lookup is retried on the next request.
const cache = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export function properties(type: ObjectType): Promise<Map<string, PropertyDef>> {
  return once(`props:${type}`, () =>
    call<{ results?: PropertyDef[] }>("Property", "List", { parameters: { objectType: type } }).then(
      (r) => new Map((r?.results ?? []).map((p) => [p.name, p])),
    ),
  );
}

export function pipelines(type: "deals" | "tickets"): Promise<Pipeline[]> {
  return once(`pipelines:${type}`, () =>
    call<{ results?: Pipeline[] }>("Pipeline", "List", { parameters: { objectType: type } }).then((r) =>
      [...(r?.results ?? [])]
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map((p) => ({ ...p, stages: [...(p.stages ?? [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)) })),
    ),
  );
}

// Every owner page (max 10 pages of 500): boards and records need names for any owner id.
export function owners(): Promise<Map<string, Owner>> {
  return once("owners", async () => {
    const all = new Map<string, Owner>();
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await call<{ results?: Owner[]; paging?: { next?: { after?: string } } }>("Owner", "List", {
        parameters: { limit: 500, after },
      });
      (r?.results ?? []).forEach((o) => all.set(String(o.id), o));
      after = r?.paging?.next?.after;
      if (!after) break;
    }
    return all;
  });
}

export function ownerName(o: Owner | undefined, id: string): string {
  if (!o) return `Owner ${id}`;
  return [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || `Owner ${id}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const AVATAR_COLORS = ["#00a4bd", "#ff7a59", "#00bda5", "#6a78d1", "#f2547d", "#516f90", "#f5c26b", "#7fd1de"];
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Display name of a record of any type, from its title properties.
export const TITLE_PROPS: Record<ObjectType, string[]> = {
  contacts: ["firstname", "lastname", "email"],
  companies: ["name", "domain"],
  deals: ["dealname", "amount"],
  tickets: ["subject"],
};

export function recordTitle(type: ObjectType, p: Record<string, string | null> | undefined, id: string): string {
  const v = (k: string) => (p?.[k] ?? "").trim();
  switch (type) {
    case "contacts":
      return [v("firstname"), v("lastname")].filter(Boolean).join(" ") || v("email") || `Contact ${id}`;
    case "companies":
      return v("name") || v("domain") || `Company ${id}`;
    case "deals":
      return v("dealname") || `Deal ${id}`;
    case "tickets":
      return v("subject") || `Ticket ${id}`;
  }
}

export function formatMoney(value: number, currency?: string): string {
  if (!Number.isFinite(value)) return "";
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
    } catch {
      // unknown currency code: plain number below
    }
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

// HubSpot sends dates as YYYY-MM-DD, ISO datetimes, or epoch milliseconds.
export function parseDate(raw: string): dayjs.Dayjs | null {
  const d = /^\d{11,}$/.test(raw) ? dayjs(Number(raw)) : dayjs(raw);
  return d.isValid() ? d : null;
}

export function formatDate(raw: string | null | undefined, withTime = false): string {
  if (!raw) return "";
  const d = parseDate(raw);
  if (!d) return raw;
  const fmt = d.isSame(dayjs(), "year") ? "MMM D" : "MMM D, YYYY";
  return withTime ? d.format(`${fmt} h:mm A`) : d.format(fmt);
}

// A property value as HubSpot shows it: option labels, owner names, stage labels, dates, numbers.
export function displayValue(
  name: string,
  raw: string | null | undefined,
  def: PropertyDef | undefined,
  lookups: { owners?: Map<string, Owner>; stages?: Map<string, string>; currency?: string },
): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (name === "hubspot_owner_id") return ownerName(lookups.owners?.get(raw), raw);
  if (name === "dealstage" || name === "hs_pipeline_stage") return lookups.stages?.get(raw) ?? raw;
  if (name === "amount") return formatMoney(Number(raw), lookups.currency);
  if (def?.options?.length) {
    const label = new Map(def.options.map((o) => [o.value, o.label]));
    return raw
      .split(";")
      .map((v) => label.get(v) ?? v)
      .join(", ");
  }
  if (def?.type === "datetime") return formatDate(raw, true);
  if (def?.type === "date") return formatDate(raw);
  if (def?.type === "number" && Number.isFinite(Number(raw))) return new Intl.NumberFormat().format(Number(raw));
  if (def?.type === "bool") return raw === "true" ? "Yes" : raw === "false" ? "No" : raw;
  return raw;
}
