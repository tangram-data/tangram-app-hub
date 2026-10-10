// Datadog monitor states → status dot colour + word (table language: dot + word, never a tag).
import dayjs from "dayjs";

export type StatusLook = { color: string; word: string; bad: boolean };

const LOOKS: Record<string, StatusLook> = {
  alert: { color: "#e0312c", word: "Alert", bad: true },
  warn: { color: "#f2a32c", word: "Warn", bad: false },
  "no data": { color: "#9aa4ab", word: "No Data", bad: false },
  ok: { color: "#28a745", word: "OK", bad: false },
  ignored: { color: "#9aa4ab", word: "Ignored", bad: false },
  skipped: { color: "#9aa4ab", word: "Skipped", bad: false },
  unknown: { color: "#9aa4ab", word: "Unknown", bad: false },
};

export function statusLook(status: string | undefined): StatusLook {
  const key = (status ?? "").trim().toLowerCase();
  return LOOKS[key] ?? { color: "#9aa4ab", word: status?.trim() || "Unknown", bad: false };
}

// Non-OK first, worst first, when listing a monitor's groups.
export function statusRank(status: string | undefined): number {
  switch ((status ?? "").toLowerCase()) {
    case "alert":
      return 0;
    case "warn":
      return 1;
    case "no data":
      return 2;
    case "ok":
      return 4;
    default:
      return 3;
  }
}

// `MMM D HH:mm`, year only when not this year; Datadog sends UNIX seconds.
export function timeLabel(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "";
  const d = dayjs.unix(unixSeconds);
  return d.isSame(dayjs(), "year") ? d.format("MMM D HH:mm") : d.format("MMM D, YYYY HH:mm");
}

export function fullTime(unixSeconds: number | null | undefined): string {
  return unixSeconds ? dayjs.unix(unixSeconds).format("YYYY-MM-DD HH:mm:ss") : "";
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
