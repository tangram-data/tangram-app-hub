// Simple Iceberg database list — Tier-2 sandboxed component. Data comes from
// the local Database.List resource action, invoked under the viewer's IAM via
// the governed component facade. Row click emits a `select` output back to the
// agent. Auto-mounted into #root by the platform.
import { useEffect, useState } from "react";

interface ResourceAction {
  resourceType: string;
  action: string;
}

interface PerformActionArgs {
  parameters?: Record<string, unknown>;
  requestBody?: unknown;
}

interface TangramSDK {
  performAction(action: ResourceAction, args?: PerformActionArgs): Promise<unknown>;
  emit(event: string, payload: Record<string, unknown>): void;
}
declare global {
  interface Window {
    tangram: TangramSDK;
  }
}

// Iceberg REST listNamespaces returns { namespaces: [["db1"], ["db2"], ...] };
// parse defensively so gateway envelope variations degrade to an empty list.
function parseDatabases(result: unknown): string[] {
  const root = result as Record<string, unknown> | null;
  const envelope = (root?.envelope ?? null) as Record<string, unknown> | null;
  const candidates = [root, root?.result, root?.data, envelope?.data] as Array<
    Record<string, unknown> | null | undefined
  >;
  for (const c of candidates) {
    const namespaces = c?.namespaces;
    if (Array.isArray(namespaces)) {
      return namespaces
        .map((ns) => (Array.isArray(ns) ? ns.join(".") : String(ns)))
        .filter((name) => name.length > 0);
    }
  }
  return [];
}

export default function DbList() {
  const [databases, setDatabases] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;
    window.tangram
      .performAction({ resourceType: "Database", action: "List" })
      .then((result) => {
        if (!alive) return;
        setDatabases(parseDatabases(result));
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state === "loading") return <div style={{ padding: 16 }}>Loading databases…</div>;
  if (state === "error")
    return <div style={{ color: "#c00", padding: 16 }}>Couldn’t load databases: {error}</div>;
  if (databases.length === 0) return <div style={{ padding: 16 }}>No databases yet.</div>;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Databases ({databases.length})</div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {databases.map((db) => (
          <li key={db}>
            <button
              onClick={() => window.tangram.emit("select", { database: db })}
              style={{
                background: "none",
                border: "none",
                color: "#1677ff",
                cursor: "pointer",
                display: "block",
                padding: "6px 4px",
                textAlign: "left",
                width: "100%",
              }}
            >
              {db}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
