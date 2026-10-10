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

// Salesforce datetimes end in "+0000"; Safari's Date only takes "+00:00".
export function parseDateTime(s: string): dayjs.Dayjs {
  return dayjs(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

function picklistLabel(f: Field, value: string): string {
  return f.picklistValues?.find((p) => p.value === value)?.label ?? value;
}

export type Display =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "link"; text: string; href: string }
  | { kind: "ref"; text: string; sobject: string; id: string }
  | { kind: "check"; on: boolean };

// How a value reads on the record page. Currency uses the record's CurrencyIsoCode (multi-currency orgs) or USD.
export function display(f: Field, v: unknown, rec: SfRecord): Display {
  if (isEmpty(v)) return { kind: "text", text: "" };
  switch (f.type) {
    case "boolean":
      return { kind: "check", on: v === true || v === "true" };
    case "currency": {
      const code = typeof rec.CurrencyIsoCode === "string" ? rec.CurrencyIsoCode : "USD";
      const n = Number(v);
      if (!Number.isFinite(n)) return { kind: "text", text: String(v) };
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
      const target = f.referenceTo?.[0];
      return target ? { kind: "ref", text: String(v), sobject: target, id: String(v) } : { kind: "text", text: String(v), mono: true };
    }
    case "id":
      return { kind: "text", text: String(v), mono: true };
    case "url": {
      const s = String(v);
      const href = /^https?:\/\//i.test(s) ? s : /^[\w.-]+\.[a-z]{2,}/i.test(s) ? `https://${s}` : "";
      return href ? { kind: "link", text: s, href } : { kind: "text", text: s };
    }
    case "email":
      return { kind: "link", text: String(v), href: `mailto:${String(v)}` };
    case "phone":
      return { kind: "link", text: String(v), href: `tel:${String(v).replace(/[^\d+]/g, "")}` };
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
