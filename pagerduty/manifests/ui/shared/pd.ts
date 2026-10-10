// Shared helpers for the PagerDuty components: the window.tangram bridge,
// status/time formatting, and stable avatar colors.
import dayjs from "dayjs";

export const tangram = (window as any).tangram;

export type Ref = { id?: string; summary?: string; html_url?: string };

export function call<T>(resourceType: string, action: string, req: Record<string, unknown>): Promise<T> {
  return tangram.performAction({ resourceType, action }, req) as Promise<T>;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const STATUS_WORD: Record<string, string> = {
  triggered: "Triggered",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

// Table-language time: "Oct 3 09:12", year only when not this year; relative in the title.
export function timeLabel(iso?: string): string {
  if (!iso) return "";
  const d = dayjs(iso);
  return d.isSame(dayjs(), "year") ? d.format("MMM D HH:mm") : d.format("MMM D, YYYY HH:mm");
}

export function relative(iso?: string): string {
  if (!iso) return "";
  const mins = dayjs().diff(dayjs(iso), "minute");
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const AVATAR = ["#06ac38", "#0b7285", "#5e35b1", "#c2185b", "#e37400", "#1a73e8", "#00897b", "#6d4c41"];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR[h % AVATAR.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

// Only absolute https URLs from API responses become links (the host relay opens https only); anything else is text.
export function safeUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// The sandbox frame blocks popups: links open through the host (https only, matching the host relay).
export function openExternal(e: { preventDefault(): void }, url?: string | null) {
  e.preventDefault();
  const u = safeUrl(url);
  if (!u) return;
  if (tangram?.openUrl) tangram.openUrl(u);
  else window.open(u, "_blank", "noopener,noreferrer");
}

// A failed write whose outcome is known: the user declined, the platform refused, or the vendor answered 4xx
// (other than 408). Anything else — network loss, timeout, 5xx, no answer — may have landed upstream.
export function definiteFailure(e: unknown): boolean {
  const m = errText(e);
  if (/\b(408|5\d\d)\b|time(d)?\s?out|failed to fetch|load failed|network\s?error|abort/i.test(m)) return false;
  if (/declin|unauthori[sz]ed|forbidden|denied|not allowed|invalid|required|\b4\d\d\b/i.test(m)) return true;
  return false;
}
