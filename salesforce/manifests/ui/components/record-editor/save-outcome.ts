// Whether a failed save may have happened anyway. Salesforce writes are not
// idempotent: retrying a create whose response was lost duplicates the record
// (and its automation), so only failures that prove nothing was written allow
// a plain retry.
import { Field, parseDateTime } from "../../shared/sf-describe";

export type Failure = { definitive: boolean; message: string };

// Messages that prove the write never happened or Salesforce rejected it:
// the user declined (or another dialog was open), the platform refused before
// sending, or Salesforce answered 4xx (except 408, a timeout).
const DEFINITIVE = [
  /^confirmation declined$/i,
  /another confirmation is already open/i,
  /no workspace context/i,
  /^unauthorized$/i,
  /^Invalid requestBody/i,
  /^Invalid request parameters/i,
  /(Missing|Invalid) path parameter/i,
  /^Header parameter/i,
  /not (allowed|authorized|permitted)|permission denied|forbidden/i,
];

export function classify(e: unknown): Failure {
  const message = e instanceof Error ? e.message : String(e);
  const upstream = /Upstream API error (\d{3})/.exec(message);
  if (upstream) {
    const code = Number(upstream[1]);
    return { definitive: code >= 400 && code < 500 && code !== 408, message };
  }
  return { definitive: DEFINITIVE.some((re) => re.test(message)), message };
}

const blank = (v: unknown) => v === null || v === undefined || v === "";

// Whether a re-read value equals what was sent, across Salesforce's representations.
export function sameValue(f: Field, sent: unknown, now: unknown): boolean {
  if (blank(sent) || blank(now)) return blank(sent) && blank(now);
  switch (f.type) {
    case "datetime":
      return parseDateTime(String(sent)).valueOf() === parseDateTime(String(now)).valueOf();
    case "currency":
    case "percent":
    case "double":
    case "int":
    case "long":
      return Number(sent) === Number(now);
    case "boolean":
      return String(sent) === String(now);
    case "multipicklist":
      return String(sent).split(";").sort().join(";") === String(now).split(";").sort().join(";");
    case "reference":
      // 15- and 18-character ids name the same record
      return String(sent).slice(0, 15) === String(now).slice(0, 15);
    default:
      return String(sent) === String(now);
  }
}

// The fields of an update that the re-read record doesn't reflect.
export function notLanded(fields: Field[], sent: Record<string, unknown>, now: Record<string, unknown>): string[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  return Object.keys(sent).filter((k) => {
    const f = byName.get(k);
    return !f || !sameValue(f, sent[k], now[k]);
  });
}
