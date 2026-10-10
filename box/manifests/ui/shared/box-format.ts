// Shared Box helpers: item shape, file-type badges, size/date labels.
import dayjs from "dayjs";

export type BoxItem = {
  type: "file" | "folder" | "web_link";
  id: string;
  name: string;
  size?: number;
  modified_at?: string;
  extension?: string;
  description?: string;
  modified_by?: { name?: string; login?: string };
  owned_by?: { name?: string; login?: string };
  path_collection?: { entries?: { id: string; name: string }[] };
};

export type Badge = { text: string; color: string; label: string };

// Box's file-type colours: docs blue, sheets green, slides orange, PDF red.
const BADGES: [RegExp, Badge][] = [
  [/^pdf$/, { text: "PDF", color: "#d0021b", label: "PDF" }],
  [/^(docx?|gdoc|pages|rtf|odt)$/, { text: "DOC", color: "#2a62b9", label: "Document" }],
  [/^(xlsx?|xlsm|gsheet|numbers|ods|csv|tsv)$/, { text: "XLS", color: "#26874a", label: "Spreadsheet" }],
  [/^(pptx?|gslide|key|odp)$/, { text: "PPT", color: "#d24726", label: "Presentation" }],
  [/^(png|jpe?g|gif|svg|webp|heic|bmp|tiff?)$/, { text: "IMG", color: "#3c9a9a", label: "Image" }],
  [/^(mp4|mov|avi|mkv|webm)$/, { text: "VID", color: "#7b3fb6", label: "Video" }],
  [/^(zip|tar|gz|tgz|7z|rar)$/, { text: "ZIP", color: "#6f6f6f", label: "Archive" }],
  [/^(txt|md|log|json|xml|ya?ml|html?)$/, { text: "TXT", color: "#4e5a66", label: "Text" }],
];

export function extensionOf(item: Pick<BoxItem, "name" | "extension">): string {
  return (item.extension || (item.name.includes(".") ? item.name.split(".").pop() : "") || "").toLowerCase();
}

export function badgeFor(item: BoxItem): Badge {
  if (item.type === "web_link") return { text: "URL", color: "#0061d5", label: "Web link" };
  const ext = extensionOf(item);
  const hit = BADGES.find(([re]) => re.test(ext));
  return hit ? hit[1] : { text: ext ? ext.slice(0, 4).toUpperCase() : "FILE", color: "#6f6f6f", label: "File" };
}

export function formatSize(size: number | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Box-style "Updated": time today, "Oct 6" this year, else full date.
export function modifiedLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = dayjs(iso);
  if (d.isSame(dayjs(), "day")) return d.format("h:mm A");
  if (d.isSame(dayjs(), "year")) return d.format("MMM D");
  return d.format("MMM D, YYYY");
}

// "All Files › Finance › Q3" without the root "All Files" when deeper.
export function pathLabel(item: BoxItem): string {
  const parts = (item.path_collection?.entries ?? []).map((e) => e.name);
  return parts.join(" › ");
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// External links relay through the host (the sandbox has no allow-popups, so
// target="_blank" would be swallowed); the host confirms the destination.
export function openExternal(url: string) {
  const tangram = (window as any).tangram;
  if (!/^https:\/\//i.test(url)) return;
  if (tangram?.openUrl) tangram.openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function boxUrl(item: Pick<BoxItem, "type" | "id">): string {
  return item.type === "folder" ? `https://app.box.com/folder/${item.id}` : `https://app.box.com/file/${item.id}`;
}
