// Stand-in for the sandbox shell's window.tangram (tangram core SandboxShellHtml.scala), backed by fixtures.
// Same contract: getInputs() is a promise, onInput fires on init (here: right away), performAction resolves with
// the action's JSON or rejects with an Error("Upstream API error NNN: ...") like core.

export type Args = { parameters?: Record<string, unknown>; requestBody?: unknown };
export type Handler = (resourceType: string, action: string, args: Args) => unknown;

export class UpstreamError extends Error {
  constructor(status: number, body: unknown) {
    super(`Upstream API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

const log = (kind: string, text: string) => {
  const el = document.getElementById("preview-log");
  if (!el) return;
  const row = document.createElement("div");
  row.className = `k-${kind}`;
  row.textContent = `${new Date().toLocaleTimeString()}  ${kind.padEnd(7)} ${text}`;
  el.prepend(row);
};

export function install(handle: Handler, inputs: Record<string, unknown>): void {
  const inputCbs: ((i: Record<string, unknown>) => void)[] = [];
  let current = inputs;
  (window as any).tangram = {
    getInputs: () => Promise.resolve(current),
    onInput: (cb: (i: Record<string, unknown>) => void) => {
      inputCbs.push(cb);
      queueMicrotask(() => cb(current));
    },
    getTheme: () => Promise.resolve({}),
    onTheme: () => {},
    performAction: (target: { resourceType: string; action: string }, args: Args = {}) => {
      const name = `${target.resourceType}.${target.action}`;
      log("action", `${name} ${JSON.stringify(args).slice(0, 220)}`);
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          try {
            resolve(handle(target.resourceType, target.action, args));
          } catch (e) {
            log("error", `${name} → ${e instanceof Error ? e.message : String(e)}`);
            reject(e);
          }
        }, 250),
      );
    },
    emit: (name: string, payload: unknown) => log("emit", `${name} ${JSON.stringify(payload)}`),
    provideState: () => {},
    openUrl: (url: string) => {
      log("openUrl", url);
      return Promise.resolve();
    },
    me: () => Promise.resolve({ id: "u-1", displayName: "Preview User" }),
  };
  // Lets the gallery page drive input changes / token-renewal replays from the console.
  (window as any).previewInputs = (next: Record<string, unknown>) => {
    current = next;
    log("inputs", JSON.stringify(next));
    inputCbs.forEach((cb) => cb(current));
  };
}

// Fixture helper: unknown actions fail loudly so missing fixtures are obvious in the log.
export function missing(resourceType: string, action: string): never {
  throw new UpstreamError(501, `no preview fixture for ${resourceType}.${action}`);
}
