// Shared by the Salesforce record components: describe cache, field ordering,
// and Lightning-style value formatting driven by the describe field type.
import dayjs from "dayjs";

const tangram = (window as any).tangram;

export type Picklist = { value: string; label?: string; active?: boolean; defaultValue?: boolean };
export type Field = {
  name: string;
  label: string;
  type: string;
  nillable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  defaultedOnCreate?: boolean;
  nameField?: boolean;
  calculated?: boolean;
  autoNumber?: boolean;
  compoundFieldName?: string | null;
  referenceTo?: string[];
  picklistValues?: Picklist[];
  length?: number;
  inlineHelpText?: string | null;
  defaultValue?: unknown;
};
export type Describe = { name: string; label: string; keyPrefix?: string; fields: Field[] };
export type SfRecord = Record<string, unknown> & { attributes?: { type?: string; url?: string } };

// One describe call per object per frame: describes are large and rarely change.
const describes = new Map<string, Promise<Describe>>();

export function describe(sobject: string): Promise<Describe> {
  let p = describes.get(sobject);
  if (!p) {
    p = tangram
      .performAction({ resourceType: "Record", action: "Describe" }, { parameters: { sobject } })
      .then((d: Describe) => {
        if (!d || !Array.isArray(d.fields)) throw new Error(`No field metadata for ${sobject}`);
        return d;
      });
    p!.catch(() => describes.delete(sobject));
    describes.set(sobject, p!);
  }
  return p!;
}

// Record-id key prefix (first 3 chars) → sobject, for polymorphic lookups (WhoId, WhatId, OwnerId).
let prefixes: Promise<Map<string, string>> | null = null;

export function keyPrefixes(): Promise<Map<string, string>> {
  if (!prefixes) {
    prefixes = tangram
      .performAction({ resourceType: "Record", action: "ListObjects" }, {})
      .then((r: { sobjects?: { name?: string; keyPrefix?: string | null }[] }) => {
        const m = new Map<string, string>();
        for (const o of r?.sobjects ?? []) if (o.name && o.keyPrefix) m.set(o.keyPrefix, o.name);
        return m;
      });
    prefixes!.catch(() => (prefixes = null));
  }
  return prefixes!;
}

export function isPolymorphic(f: Field): boolean {
  return f.type === "reference" && (f.referenceTo?.length ?? 0) > 1;
}

// The object a lookup value points at: its only target, or (polymorphic) the target whose key prefix the id carries.
export function referenceTarget(f: Field, id: string, keyMap?: Map<string, string>): string | undefined {
  const to = f.referenceTo ?? [];
  if (to.length === 1) return to[0];
  const byPrefix = keyMap?.get(id.slice(0, 3));
  return byPrefix && to.includes(byPrefix) ? byPrefix : undefined;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function nameField(d: Describe): Field | undefined {
  return d.fields.find((f) => f.nameField) ?? d.fields.find((f) => f.name === "Name");
}

// Fields users never read on a record page.
const SYSTEM = new Set([
  "Id", "IsDeleted", "SystemModstamp", "LastViewedDate", "LastReferencedDate", "MasterRecordId", "PhotoUrl",
  "CleanStatus", "JigsawContactId", "Jigsaw", "JigsawCompanyId", "ConnectionReceivedId", "ConnectionSentId",
]);

export function isSystem(f: Field): boolean {
  return SYSTEM.has(f.name) || !!f.compoundFieldName || f.type === "base64" || f.type === "location";
}

// The values a rep looks at first, in priority order; the first four present become the highlights.
const KEY_FIELDS = [
  "Title", "AccountId", "Company", "StageName", "Amount", "CloseDate", "Status", "Priority", "Type", "Industry",
  "Phone", "Email", "OwnerId", "Website", "Rating", "LeadSource",
];

export function highlightFields(d: Describe, rec: SfRecord): Field[] {
  const byName = new Map(d.fields.map((f) => [f.name, f]));
  return KEY_FIELDS.map((n) => byName.get(n))
    .filter((f): f is Field => !!f && !isEmpty(rec[f.name]))
    .slice(0, 4);
}

export function commonFieldNames(): Set<string> {
  return new Set(KEY_FIELDS);
}

export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (typeof v === "object" && !Array.isArray(v) && isAddressEmpty(v));
}

function isAddressEmpty(v: object): boolean {
  return Object.values(v as Record<string, unknown>).every((x) => x === null || x === undefined || x === "");
}

// Lightning-style object badge colors for common objects.
const ICONS: Record<string, string> = {
  Account: "#5867e8", Contact: "#a094ed", Lead: "#f88962", Opportunity: "#ff5d2d", Case: "#f2cf5b",
  Task: "#3ba755", Event: "#cb65ff", Campaign: "#f49756", User: "#7f8ced",
};

export function iconFor(sobject: string): { color: string; text: string } {
  return { color: ICONS[sobject] ?? "#0176d3", text: sobject.replace(/__c$/, "").slice(0, 2).toUpperCase() };
}

// Only absolute https URLs leave the frame (through tangram.openUrl, which relays https only; the sandbox has no
// popups). http values render as plain text.
export function safeHttpUrl(s: string): string {
  try {
    const u = new URL(s.trim());
    return u.protocol === "https:" && u.hostname.includes(".") ? u.href : "";
  } catch {
    return "";
  }
}

export function openExternal(url: string): void {
  const safe = safeHttpUrl(url);
  if (safe) tangram.openUrl?.(safe);
}

// Salesforce datetimes end in "+0000"; Safari's Date only takes "+00:00".
export function parseDateTime(s: string): dayjs.Dayjs {
  return dayjs(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

function picklistLabel(f: Field, value: string): string {
  return f.picklistValues?.find((p) => p.value === value)?.label ?? value;
}

export type Display =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "link"; text: string; href: string } // validated http(s), opened through the host
  | { kind: "ref"; text: string; sobject: string; id: string }
  | { kind: "check"; on: boolean };

// How a value reads on the record page. Currency uses the record's CurrencyIsoCode (multi-currency orgs); without one
// the org currency isn't known here, so the amount shows without a symbol.
export function display(f: Field, v: unknown, rec: SfRecord, keyMap?: Map<string, string>): Display {
  if (isEmpty(v)) return { kind: "text", text: "" };
  switch (f.type) {
    case "boolean":
      return { kind: "check", on: v === true || v === "true" };
    case "currency": {
      const code = typeof rec.CurrencyIsoCode === "string" && rec.CurrencyIsoCode ? rec.CurrencyIsoCode : "";
      const n = Number(v);
      if (!Number.isFinite(n)) return { kind: "text", text: String(v) };
      if (!code)
        return { kind: "text", text: n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
      try {
        return { kind: "text", text: new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(n) };
      } catch {
        return { kind: "text", text: `${code} ${n.toLocaleString()}` };
      }
    }
    case "percent":
      return { kind: "text", text: `${Number(v).toLocaleString()}%` };
    case "double":
    case "int":
    case "long":
      return { kind: "text", text: Number.isFinite(Number(v)) ? Number(v).toLocaleString() : String(v) };
    case "date":
      return { kind: "text", text: dayjs(String(v)).isValid() ? dayjs(String(v)).format("MMM D, YYYY") : String(v) };
    case "datetime": {
      const d = parseDateTime(String(v));
      return { kind: "text", text: d.isValid() ? d.format("MMM D, YYYY h:mm A") : String(v) };
    }
    case "picklist":
      return { kind: "text", text: picklistLabel(f, String(v)) };
    case "multipicklist":
      return { kind: "text", text: String(v).split(";").map((x) => picklistLabel(f, x)).join(", ") };
    case "reference": {
      const target = referenceTarget(f, String(v), keyMap);
      return target ? { kind: "ref", text: String(v), sobject: target, id: String(v) } : { kind: "text", text: String(v), mono: true };
    }
    case "id":
      return { kind: "text", text: String(v), mono: true };
    case "url": {
      const s = String(v);
      const href = safeHttpUrl(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
      return href ? { kind: "link", text: s, href } : { kind: "text", text: s };
    }
    case "encryptedstring":
      return { kind: "text", text: "••••••" };
    case "address": {
      const a = v as Record<string, unknown>;
      const parts = [a.street, [a.city, a.state].filter(Boolean).join(", "), [a.postalCode, a.country].filter(Boolean).join(" ")];
      return { kind: "text", text: parts.filter((p) => p && String(p).trim()).join("\n") };
    }
    default:
      return { kind: "text", text: typeof v === "object" ? JSON.stringify(v) : String(v) };
  }
}
