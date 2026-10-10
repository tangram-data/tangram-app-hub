// Datadog monitors through the connector's read-only Monitor.Search: an editable
// monitor query (prefilled by render inputs), one quiet line per monitor, and a
// row click that expands its definition and non-OK groups (Monitor.Get).
// Select emits `open` {monitorId, name} for the host/agent.
import { LoadingOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/datadog.css";
import "../../shared/tangram-buttons.css";
import { MonitorDetail } from "./monitor-detail";
import { errorText, fullTime, statusLook, timeLabel } from "./monitor-status";

const tangram = (window as any).tangram;

const DEFAULT_QUERY = 'status:(alert OR warn OR "no data")';
const PER_PAGE = 30;

type Monitor = {
  id: number;
  name?: string;
  status?: string;
  type?: string;
  tags?: string[];
  last_triggered_ts?: number | null;
};
type SearchResult = {
  monitors?: Monitor[];
  metadata?: { page?: number; page_count?: number; per_page?: number; total_count?: number };
};

export default function MonitorList() {
  const [text, setText] = useState(DEFAULT_QUERY);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  // "loading" until the first onInput delivers the real inputs.
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const seq = useRef(0);
  // The query the shown results came from; paging and refresh reuse it, not the edited box.
  const active = useRef(DEFAULT_QUERY);
  // The last query/page tried (success or not): Refresh retries it.
  const attempted = useRef({ query: DEFAULT_QUERY, page: 0 });

  const load = useCallback((query: string, p: number) => {
    const mine = ++seq.current;
    attempted.current = { query, page: p };
    setState("loading");
    setError("");
    tangram
      .performAction(
        { resourceType: "Monitor", action: "Search" },
        { parameters: { query: query.trim() || undefined, page: p, per_page: PER_PAGE, sort: "status,asc" } },
      )
      .then((r: SearchResult) => {
        if (mine !== seq.current) return;
        active.current = query;
        setMonitors(r?.monitors ?? []);
        setPage(r?.metadata?.page ?? p);
        setPageCount(r?.metadata?.page_count ?? 0);
        setTotal(r?.metadata?.total_count ?? null);
        setOpenId(null);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setMonitors([]);
        setPageCount(0);
        setTotal(null);
        setError(errorText(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      // The alert-only default applies only to a bare render; a presentation's absent/empty query means all monitors.
      const bare = !inputs || Object.keys(inputs).length === 0;
      const q = typeof inputs?.query === "string" ? inputs.query : bare ? DEFAULT_QUERY : "";
      setText(q);
      load(q, 0);
    };
    // onInput fires at once when the frame is initialised and again on every new input; getInputs() is a promise.
    tangram.onInput((inputs: Record<string, unknown> | null | undefined) => apply(inputs ?? {}));
  }, [load]);

  const busy = state === "loading";
  const open = (m: Monitor) => tangram.emit("open", { monitorId: m.id, name: m.name ?? "" });
  const toggle = (id: number) => setOpenId((cur) => (cur === id ? null : id));

  return (
    <div className="dd-root">
      <div className="dd-head">
        <form
          className="dd-search"
          onSubmit={(e) => {
            e.preventDefault();
            load(text, 0);
          }}
        >
          <button type="submit" className="dd-iconbtn" aria-label="Search monitors">
            {busy ? <LoadingOutlined aria-hidden="true" /> : <SearchOutlined aria-hidden="true" />}
          </button>
          <input
            aria-label="Monitor query"
            value={text}
            placeholder='status:alert service:checkout tag:env:prod — or words in the name'
            onChange={(e) => setText(e.target.value)}
          />
        </form>
        <Tooltip title="Refresh">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            aria-label="Refresh"
            disabled={busy}
            onClick={() => load(attempted.current.query, attempted.current.page)}
          />
        </Tooltip>
      </div>
      <div className="dd-bar">
        <span className="sp" title={active.current}>
          {state === "ready" && total !== null
            ? `${total} monitor${total === 1 ? "" : "s"} · ${active.current.trim() || "all monitors"}`
            : "Datadog monitors"}
        </span>
      </div>
      {state === "error" ? (
        <div className="dd-error">
          <b>Couldn't search monitors</b>
          {error ? <div>{error}</div> : null}
        </div>
      ) : busy && monitors.length === 0 ? (
        <div style={{ padding: "10px 14px" }}>
          <Skeleton active title={false} paragraph={{ rows: 5 }} />
        </div>
      ) : monitors.length === 0 ? (
        <div className="dd-empty">No monitors match</div>
      ) : (
        <table className="dd-table" aria-busy={busy}>
          <thead>
            <tr>
              <th style={{ width: 96 }}>Status</th>
              <th>Monitor</th>
              <th className="dd-col2" style={{ width: 92 }}>
                Type
              </th>
              <th className="dd-col2" style={{ width: "24%" }}>
                Tags
              </th>
              <th className="dd-col2" style={{ width: 120 }}>
                Triggered
              </th>
            </tr>
          </thead>
          <tbody>
            {monitors.map((m) => {
              const look = statusLook(m.status);
              const tags = m.tags ?? [];
              const isOpen = openId === m.id;
              return (
                <React.Fragment key={m.id}>
                  <tr
                    className={`dd-row${isOpen ? " sel" : ""}${look.bad && !isOpen ? " flag" : ""}`}
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={() => toggle(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(m.id);
                      }
                    }}
                  >
                    <td>
                      <span className={`dd-status${look.bad ? " bad" : ""}`}>
                        <span className="dd-dot" style={{ background: look.color }} aria-hidden="true" />
                        {look.bad ? <b>{look.word}</b> : look.word}
                      </span>
                    </td>
                    <td title={m.name}>{m.name || `Monitor ${m.id}`}</td>
                    <td className="dd-muted dd-col2" title={m.type}>
                      {m.type ?? ""}
                    </td>
                    <td className="dd-muted dd-col2" title={tags.join(", ")}>
                      {tags.slice(0, 4).map((t) => (
                        <span className="dd-tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </td>
                    <td className="dd-mono dd-muted dd-col2" title={fullTime(m.last_triggered_ts)}>
                      {timeLabel(m.last_triggered_ts) || "—"}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={5} className="dd-detail-cell">
                        <MonitorDetail id={m.id} name={m.name ?? ""} onOpen={() => open(m)} />
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {state !== "error" && pageCount > 1 ? (
        <div className="dd-foot">
          <span className="sp">
            Page {page + 1} of {pageCount}
          </span>
          <Button size="small" disabled={busy || page <= 0} onClick={() => load(active.current, page - 1)}>
            Previous
          </Button>
          <Button size="small" disabled={busy || page + 1 >= pageCount} onClick={() => load(active.current, page + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
