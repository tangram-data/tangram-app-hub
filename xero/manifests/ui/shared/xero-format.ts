// Xero JSON quirks shared by the Xero components: "/Date(1700000000000+0000)/"
// timestamps next to ISO DateString fields, and money as plain numbers.
import dayjs from "dayjs";

const MS_DATE = /\/Date\((-?\d+)([+-]\d{4})?\)\//;

// A Xero date: prefer the ISO DateString, else the /Date(ms)/ form.
export function xeroDate(dateString?: string, msForm?: string): dayjs.Dayjs | null {
  if (dateString) {
    const d = dayjs(dateString);
    if (d.isValid()) return d;
  }
  const m = msForm ? MS_DATE.exec(msForm) : null;
  if (m) return dayjs(Number(m[1]));
  if (msForm) {
    const d = dayjs(msForm);
    if (d.isValid()) return d;
  }
  return null;
}

export function dateLabel(d: dayjs.Dayjs | null): string {
  if (!d) return "—";
  return d.isSame(dayjs(), "year") ? d.format("D MMM") : d.format("D MMM YYYY");
}

export function money(n: unknown, currency?: string): string {
  const v = typeof n === "number" ? n : Number(n);
  if (n === undefined || n === null || n === "" || !Number.isFinite(v)) return "—";
  const s = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}

// Status dot colours per the table language: green ok, blue in progress, amber waiting, red failed, grey inactive.
export const STATUS: Record<string, { color: string; label: string; bad?: boolean }> = {
  DRAFT: { color: "#9ca3af", label: "Draft" },
  SUBMITTED: { color: "#f59e0b", label: "Awaiting approval" },
  AUTHORISED: { color: "#2563eb", label: "Awaiting payment" },
  PAID: { color: "#16a34a", label: "Paid" },
  VOIDED: { color: "#d92d20", label: "Voided", bad: true },
  DELETED: { color: "#d92d20", label: "Deleted", bad: true },
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
