// Shared Stripe formatting: money from the smallest currency unit, timestamps, status dots.
import dayjs from "dayjs";

// Stripe's API scale per currency (https://docs.stripe.com/currencies#zero-decimal): zero-decimal currencies are
// whole units; three-decimal ones are thousandths; everything else — including the special cases ISK and UGX,
// which Stripe still takes ×100 — is hundredths.
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
// ×100 on the API but charged in whole units: amounts typed for them may not have fractions.
const WHOLE_UNIT_INPUT = new Set(["isk", "ugx"]);

/** Digits between the API amount and the currency unit. */
export function minorDigits(currency: string | undefined): number {
  const c = (currency ?? "").toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Fraction digits a person may type (and that are shown). */
export function inputDigits(currency: string | undefined): number {
  return WHOLE_UNIT_INPUT.has((currency ?? "").toLowerCase()) ? 0 : minorDigits(currency);
}

export function money(amount: number | null | undefined, currency: string | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const value = amount / 10 ** minorDigits(currency);
  const shown = inputDigits(currency);
  const code = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: shown,
      maximumFractionDigits: Math.max(shown, minorDigits(currency)),
    }).format(value);
  } catch {
    return `${value.toFixed(minorDigits(currency))} ${code}`;
  }
}

/** A decimal amount typed by a person ("12.50") → smallest unit, or null when invalid. */
export function toMinor(text: string, currency: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const digits = minorDigits(currency);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > inputDigits(currency)) return null;
  const n = Number(whole) * 10 ** digits + Number((frac + "000").slice(0, digits) || "0");
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Table-language time: MMM D HH:mm, year only when not this year. */
export function when(unix: number | null | undefined): string {
  if (!unix) return "—";
  const d = dayjs.unix(unix);
  return d.format(d.isSame(dayjs(), "year") ? "MMM D HH:mm" : "MMM D, YYYY");
}

export function day(unix: number | null | undefined): string {
  if (!unix) return "—";
  const d = dayjs.unix(unix);
  return d.format(d.isSame(dayjs(), "year") ? "MMM D" : "MMM D, YYYY");
}

const GREEN = "#16a34a";
const BLUE = "#2563eb";
const AMBER = "#f59e0b";
const RED = "#df1b41";
const GREY = "#9ca3af";

export type Status = { word: string; color: string; bad?: boolean };

export function paymentStatus(s: string | undefined): Status {
  switch (s) {
    case "succeeded":
      return { word: "Succeeded", color: GREEN };
    case "processing":
      return { word: "Processing", color: BLUE };
    case "requires_payment_method":
      return { word: "Incomplete", color: RED, bad: true };
    case "requires_action":
    case "requires_confirmation":
      return { word: "Needs action", color: AMBER };
    case "requires_capture":
      return { word: "Uncaptured", color: AMBER };
    case "canceled":
      return { word: "Canceled", color: GREY };
    default:
      return { word: s ?? "Unknown", color: GREY };
  }
}

export function invoiceStatus(s: string | undefined, dueDate?: number | null): Status {
  switch (s) {
    case "draft":
      return { word: "Draft", color: GREY };
    case "open":
      return dueDate && dayjs.unix(dueDate).isBefore(dayjs())
        ? { word: "Past due", color: RED, bad: true }
        : { word: "Open", color: BLUE };
    case "paid":
      return { word: "Paid", color: GREEN };
    case "uncollectible":
      return { word: "Uncollectible", color: RED, bad: true };
    case "void":
      return { word: "Void", color: GREY };
    default:
      return { word: s ?? "Unknown", color: GREY };
  }
}

export function subscriptionStatus(s: string | undefined): Status {
  switch (s) {
    case "active":
      return { word: "Active", color: GREEN };
    case "trialing":
      return { word: "Trialing", color: BLUE };
    case "past_due":
      return { word: "Past due", color: RED, bad: true };
    case "unpaid":
      return { word: "Unpaid", color: RED, bad: true };
    case "incomplete":
      return { word: "Incomplete", color: AMBER };
    case "paused":
      return { word: "Paused", color: AMBER };
    case "incomplete_expired":
      return { word: "Expired", color: GREY };
    case "canceled":
      return { word: "Canceled", color: GREY };
    default:
      return { word: s ?? "Unknown", color: GREY };
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Dashboard deep link; test-mode objects live under /test/. */
export function dashboardUrl(kind: "customers" | "invoices", id: string, livemode: boolean | undefined): string {
  return `https://dashboard.stripe.com/${livemode === false ? "test/" : ""}${kind}/${encodeURIComponent(id)}`;
}

/** The URL when it is http(s), else undefined — never render other schemes as links. */
export function safeUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
