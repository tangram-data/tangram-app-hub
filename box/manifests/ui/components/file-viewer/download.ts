// Box downloads are non-JSON, so the platform wraps them in an
// `app_action_result` envelope — inline text up to 32 KB, larger/binary content
// saved to workspace files. This unwraps both shapes (same contract as the
// OneDrive viewer).
export type Unwrapped = { text?: string; truncated: boolean; saved?: { where?: string }; note?: string };

export function unwrapDownload(result: unknown): Unwrapped {
  if (typeof result === "string") return { text: result, truncated: false };
  if (result && typeof result === "object") {
    const env = result as Record<string, any>;
    const truncated = env.truncated === true;
    const note = typeof env.note === "string" ? env.note : undefined;
    if (typeof env.text === "string") return { text: env.text, truncated, note };
    if (typeof env.base64 === "string") {
      const bytes = Uint8Array.from(atob(env.base64), (c) => c.charCodeAt(0));
      return { text: new TextDecoder("utf-8").decode(bytes), truncated, note };
    }
    if (env.file && typeof env.file === "object") {
      const { folder, name } = env.file as Record<string, unknown>;
      const where =
        typeof folder === "string" && folder && typeof name === "string" && name ? `${folder}/${name}` : undefined;
      return { truncated, saved: { where }, note };
    }
    return { text: JSON.stringify(result, null, 2), truncated };
  }
  return { text: String(result ?? ""), truncated: false };
}

const TEXT_EXT = /^(txt|md|markdown|log|json|xml|ya?ml|csv|tsv|ini|conf|cfg|sql|py|js|ts|tsx|jsx|java|scala|go|rb|sh|css|html?)$/;

export function isTextLike(ext: string): boolean {
  return TEXT_EXT.test(ext);
}

export function isTable(ext: string): boolean {
  return ext === "csv" || ext === "tsv";
}

// RFC 4180 CSV (or TSV): quoted cells, "" escapes, CRLF/LF rows.
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
