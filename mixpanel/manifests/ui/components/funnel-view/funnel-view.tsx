// A saved Mixpanel funnel through the connector's read-only Funnel.Query: step counts, conversion from the first
// step, drop-off and average time between steps. Inputs: funnelId (or pick one), range or from_date/to_date.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Select, Skeleton, Tooltip as AntTooltip } from "antd";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../shared/mixpanel.css";
import "../../shared/tangram-buttons.css";
import { compact, DateWindow, duration, errorText, percent, RANGES, resolveWindow, windowFromInputs, windowLabel } from "../../shared/mp-format";
import { onNewInputs } from "../../shared/sandbox-inputs";
import { FunnelRef, FunnelResult, parseFunnelId, ratio, Step, toSteps } from "./funnel-steps";

const tangram = (window as any).tangram;

type Query = { funnelId: number | null; win: DateWindow };

export default function FunnelView() {
  const [q, setQ] = useState<Query>({ funnelId: null, win: { range: "30d" } });
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [span, setSpan] = useState({ from: "", to: "" });
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [funnels, setFunnels] = useState<FunnelRef[] | null>(null);
  const [listState, setListState] = useState<"idle" | "loading" | "error">("idle");
  const seq = useRef(0);
  const listing = useRef(false);

  const load = useCallback((next: Query) => {
    const mine = ++seq.current;
    setQ(next);
    if (next.funnelId === null) {
      setSteps(null);
      setState("idle");
      return;
    }
    // one bucket spanning the whole range, so a user who enters on several days counts once (as in Mixpanel's UI)
    const { from, to, days } = resolveWindow(next.win);
    setState("loading");
    setError("");
    tangram
      .performAction(
        { resourceType: "Funnel", action: "Query" },
        { parameters: { funnel_id: next.funnelId, from_date: from, to_date: to, interval: days } },
      )
      .then((r: FunnelResult) => {
        if (mine !== seq.current) return;
        if (r?.error) throw new Error(r.error);
        setSteps(toSteps(r ?? {}));
        setSpan({ from, to });
        setState("ready");
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setSteps(null);
        setError(errorText(e));
        setState("error");
      });
  }, []);

  // The funnel list is fetched on demand — every Query API call counts against the project's hourly limit.
  const loadList = useCallback(() => {
    if (listing.current) return;
    listing.current = true;
    setListState("loading");
    tangram
      .performAction({ resourceType: "Funnel", action: "List" }, { parameters: {} })
      .then((r: FunnelRef[]) => {
        setFunnels(Array.isArray(r) ? r.filter((f) => parseFunnelId(f?.funnel_id) !== null) : []);
        setListState("idle");
      })
      .catch(() => {
        listing.current = false;
        setListState("error");
      });
  }, []);

  useEffect(() => {
    onNewInputs((inputs) => {
      const funnelId = parseFunnelId(inputs.funnelId ?? inputs.funnel_id);
      setSteps(null);
      load({ funnelId, win: windowFromInputs(inputs) });
      if (funnelId === null) loadList();
    });
  }, [load, loadList]);

  const busy = state === "loading";
  const first = steps?.[0]?.count ?? 0;
  const last = steps?.[steps.length - 1]?.count ?? 0;
  const shown = span.from ? span : resolveWindow(q.win);
  const options = useMemo(() => {
    const list = (funnels ?? []).map((f) => ({ value: f.funnel_id, label: f.name || `Funnel ${f.funnel_id}` }));
    if (q.funnelId !== null && !list.some((o) => o.value === q.funnelId)) list.unshift({ value: q.funnelId, label: `Funnel ${q.funnelId}` });
    return list;
  }, [funnels, q.funnelId]);

  return (
    <div className="mp-root">
      <div className="mp-head">
        <div className="mp-title">
          <span className="mp-mark" aria-hidden="true" />
          <Select
            size="small"
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 200, maxWidth: "100%", flex: 1 }}
            placeholder={listState === "error" ? "Couldn't load funnels — open to retry" : "Pick a saved funnel"}
            value={q.funnelId ?? undefined}
            options={options}
            loading={listState === "loading"}
            notFoundContent={listState === "loading" ? "Loading funnels…" : "No saved funnels"}
            onDropdownVisibleChange={(open) => open && loadList()}
            onChange={(id: number) => load({ ...q, funnelId: id })}
            disabled={busy}
            aria-label="Funnel"
          />
          {q.funnelId !== null ? <span className="sub">{windowLabel(shown)}</span> : null}
        </div>
        <AntTooltip title="Refresh">
          <Button size="small" icon={<ReloadOutlined />} aria-label="Refresh" disabled={busy || q.funnelId === null} onClick={() => load(q)} />
        </AntTooltip>
      </div>
      <div className="mp-controls">
        <div className="mp-seg" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              type="button"
              key={r.key}
              className={q.win.range === r.key ? "on" : ""}
              aria-pressed={q.win.range === r.key}
              disabled={busy || q.funnelId === null}
              onClick={() => load({ ...q, win: { range: r.key } })}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {state === "idle" ? (
        <div className="mp-empty">Pick a saved funnel to see its conversion</div>
      ) : state === "error" ? (
        <div className="mp-error">
          <b>Couldn't load the funnel</b>
          {error ? <div>{error}</div> : null}
        </div>
      ) : busy && !steps ? (
        <div style={{ padding: "14px 16px" }}>
          <Skeleton active title={false} paragraph={{ rows: 6 }} />
        </div>
      ) : !steps || steps.length === 0 || first === 0 ? (
        <div className="mp-empty">No one entered this funnel in this date range</div>
      ) : (
        <div aria-busy={busy}>
          <div className="mp-kpis">
            <div className="mp-kpi">
              <div className="k">Overall conversion</div>
              <div className="v">{percent(ratio(last, first))}</div>
            </div>
            <div className="mp-kpi">
              <div className="k">Entered</div>
              <div className="v">{compact(first)}</div>
            </div>
            <div className="mp-kpi">
              <div className="k">Completed</div>
              <div className="v">{compact(last)}</div>
            </div>
          </div>
          <div className="mp-steps">
            {steps.map((s, i) => {
              const prev = i > 0 ? steps[i - 1].count : 0;
              const dropped = i > 0 ? Math.max(0, prev - s.count) : 0;
              const time = duration(s.avgTime);
              return (
                <React.Fragment key={i}>
                  {i > 0 ? (
                    <div className="mp-step" style={{ padding: 0 }}>
                      <span />
                      <div className="mp-drop">
                        <span>{percent(ratio(s.count, prev))} converted</span>
                        {dropped ? <span className="bad">{compact(dropped)} dropped off</span> : null}
                        {time ? <span>avg {time}</span> : null}
                      </div>
                    </div>
                  ) : null}
                  <div className="mp-step">
                    <span className="ix">{i + 1}</span>
                    <span className="lbl" title={s.label}>
                      {s.label}
                    </span>
                    <span className="num">
                      <b>{compact(s.count)}</b>
                      <span>{percent(ratio(s.count, first))}</span>
                    </span>
                    <div className="bar" aria-hidden="true">
                      <i style={{ width: `${Math.max(0, Math.min(100, (s.count / first) * 100))}%` }} />
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
