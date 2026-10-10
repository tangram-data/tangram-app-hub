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
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const seq = useRef(0);
  // The query the shown results came from; paging and refresh reuse it, not the edited box.
  const active = useRef(DEFAULT_QUERY);

  const load = useCallback((query: string, p: number) => {
    const mine = ++seq.current;
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
      const q = typeof inputs?.query === "string" && inputs.query.trim() ? inputs.query : DEFAULT_QUERY;
      setText(q);
      load(q, 0);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
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
            onClick={() => load(active.current, page)}
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
          <colgroup>
            <col style={{ width: 96 }} />
            <col />
            <col style={{ width: 92 }} />
            <col style={{ width: "24%" }} />
            <col style={{ width: 120 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Status</th>
              <th>Monitor</th>
              <th>Type</th>
              <th>Tags</th>
              <th>Triggered</th>
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
                    <td className="dd-muted" title={m.type}>
                      {m.type ?? ""}
                    </td>
                    <td className="dd-muted" title={tags.join(", ")}>
                      {tags.slice(0, 4).map((t) => (
                        <span className="dd-tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </td>
                    <td className="dd-mono dd-muted" title={fullTime(m.last_triggered_ts)}>
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
