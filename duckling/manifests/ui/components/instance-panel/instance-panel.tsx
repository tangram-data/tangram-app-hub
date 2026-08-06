// Duckling instance panel — Tier-2 sandboxed component. Lists instances via
// the contract's `list_instances` action binding and starts/stops them via
// `start_instance` / `stop_instance`, all under the viewer's IAM through the
// component facade. Emits a `changed` output back to the agent after a
// successful start/stop. Auto-mounted into #root by the platform.
import { useCallback, useEffect, useState } from "react";

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

interface Instance {
  name: string;
  description: string;
  cpu?: number;
  memory?: number;
  status: string;
  statusDetail?: string;
}

// InstanceStatus is a oneOf of empty variant objects; accept a plain string, a
// {type: "..."} tag, a single-key wrapper ({"Running": {}}), or Failed's
// {errorMsg} shape, and degrade to "Unknown".
function statusOf(raw: unknown): { name: string; detail?: string } {
  if (typeof raw === "string" && raw) return { name: raw };
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.errorMsg === "string") return { name: "Failed", detail: rec.errorMsg };
    if (typeof rec.type === "string") return { name: rec.type };
    const keys = Object.keys(rec);
    if (keys.length === 1) {
      const inner = rec[keys[0]] as Record<string, unknown> | null;
      const detail = typeof inner?.errorMsg === "string" ? inner.errorMsg : undefined;
      return { name: keys[0], detail };
    }
  }
  return { name: "Unknown" };
}

// listDucklingInstances returns [DucklingInstance]; parse defensively so
// gateway envelope variations degrade to an empty list.
function parseInstances(result: unknown): Instance[] {
  const root = result as Record<string, unknown> | null;
  const envelope = (root?.envelope ?? null) as Record<string, unknown> | null;
  const candidates = [result, root?.result, root?.data, envelope?.data];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    return c
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => {
        const status = statusOf(item.status);
        return {
          name: typeof item.name === "string" ? item.name : "",
          description: typeof item.description === "string" ? item.description : "",
          cpu: typeof item.cpu === "number" ? item.cpu : undefined,
          memory: typeof item.memory === "number" ? item.memory : undefined,
          status: status.name,
          statusDetail: status.detail,
        };
      })
      .filter((i) => i.name.length > 0);
  }
  return [];
}

const STATUS_COLORS: Record<string, string> = {
  Running: "#389e0d",
  Starting: "#d48806",
  Stopping: "#d48806",
  Stopped: "#8c8c8c",
  Failed: "#cf1322",
  Unknown: "#8c8c8c",
};

function startable(status: string): boolean {
  return status === "Stopped" || status === "Failed" || status === "Unknown";
}

function stoppable(status: string): boolean {
  return status === "Running" || status === "Starting";
}

export default function InstancePanel() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>("");

  const load = useCallback(async () => {
    const result = await window.tangram.performAction({ resourceType: "Instance", action: "List" });
    setInstances(parseInstances(result));
  }, []);

  useEffect(() => {
    let alive = true;
    load()
      .then(() => alive && setState("ready"))
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const run = async (action: "start" | "stop", instance: string) => {
    setBusy(instance);
    setActionError("");
    try {
      // Action args follow the resolved-action input schema: path/query params
      // ride under `parameters` (request bodies would ride under `requestBody`).
      await window.tangram.performAction(
        { resourceType: "Instance", action: action === "start" ? "Start" : "Stop" },
        { parameters: { instance } },
      );
      window.tangram.emit("changed", { instance, action });
      await load();
    } catch (e) {
      setActionError(`Could not ${action} ${instance}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (state === "loading") return <div style={{ padding: 16 }}>Loading instances…</div>;
  if (state === "error")
    return <div style={{ color: "#c00", padding: 16 }}>Couldn’t load instances: {error}</div>;
  if (instances.length === 0) return <div style={{ padding: 16 }}>No Duckling instances yet.</div>;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Instances ({instances.length})</div>
      {actionError && <div style={{ color: "#c00", marginBottom: 8 }}>{actionError}</div>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {instances.map((instance) => (
          <li
            key={instance.name}
            style={{
              alignItems: "center",
              borderBottom: "1px solid #f0f0f0",
              display: "flex",
              gap: 12,
              padding: "8px 4px",
            }}
          >
            <span
              title={instance.statusDetail}
              style={{
                background: STATUS_COLORS[instance.status] ?? STATUS_COLORS.Unknown,
                borderRadius: "50%",
                display: "inline-block",
                flex: "none",
                height: 8,
                width: 8,
              }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{instance.name}</span>
              <span style={{ color: "#8c8c8c", marginLeft: 8, fontSize: 12 }}>
                {instance.status}
                {instance.cpu !== undefined && instance.memory !== undefined
                  ? ` · ${instance.cpu} CPU / ${instance.memory} GB`
                  : ""}
              </span>
              {instance.description && (
                <div style={{ color: "#595959", fontSize: 12 }}>{instance.description}</div>
              )}
            </span>
            {startable(instance.status) && (
              <button
                disabled={busy !== null}
                onClick={() => run("start", instance.name)}
                style={buttonStyle("#389e0d", busy === instance.name)}
              >
                {busy === instance.name ? "Starting…" : "Start"}
              </button>
            )}
            {stoppable(instance.status) && (
              <button
                disabled={busy !== null}
                onClick={() => run("stop", instance.name)}
                style={buttonStyle("#cf1322", busy === instance.name)}
              >
                {busy === instance.name ? "Stopping…" : "Stop"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function buttonStyle(color: string, active: boolean): React.CSSProperties {
  return {
    background: "none",
    border: `1px solid ${color}`,
    borderRadius: 4,
    color,
    cursor: active ? "wait" : "pointer",
    flex: "none",
    fontSize: 12,
    opacity: active ? 0.6 : 1,
    padding: "2px 10px",
  };
}
