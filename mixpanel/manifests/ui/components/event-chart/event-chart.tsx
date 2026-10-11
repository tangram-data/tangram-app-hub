// One Mixpanel event over time through the connector's read-only Event.Segment: totals or uniques per day/week/month,
// optionally broken down by a property (top 10 values). Inputs: event (required), range or from_date/to_date, unit,
// type, on, where.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip as AntTooltip } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line as ChartLine, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "../../shared/mixpanel.css";
import "../../shared/tangram-buttons.css";
import { compact, DateWindow, errorText, RANGES, resolveWindow, windowFromInputs, windowLabel } from "../../shared/mp-format";
import { onNewInputs } from "../../shared/sandbox-inputs";
import { hasData, normalizeUnit, SegmentResult, toChart, unitParams, UNITS } from "./segment-series";

const tangram = (window as any).tangram;

type Query = { event: string; on: string; where: string; win: DateWindow; unit: string; type: "general" | "unique" };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export default function EventChart() {
  const [q, setQ] = useState<Query>({ event: "", on: "", where: "", win: { range: "30d" }, unit: "day", type: "general" });
  const [result, setResult] = useState<SegmentResult | null>(null);
  const [span, setSpan] = useState({ from: "", to: "" });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback((next: Query) => {
    const mine = ++seq.current;
    setQ(next);
    if (!next.event) {
      setResult(null);
      setState("idle");
      return;
    }
    const { from, to } = resolveWindow(next.win);
    const parameters: Record<string, unknown> = {
      event: next.event,
      from_date: from,
      to_date: to,
      type: next.type,
      ...unitParams(next.unit),
    };
    if (next.on) {
      parameters.on = next.on;
      parameters.limit = 50;
    }
    if (next.where) parameters.where = next.where;
    setState("loading");
    setError("");
    tangram
      .performAction({ resourceType: "Event", action: "Segment" }, { parameters })
      .then((r: SegmentResult) => {
        if (mine !== seq.current) return;
        if (r?.error) throw new Error(r.error);
        setResult(r ?? {});
        setSpan({ from, to });
        setHidden(new Set());
        setState("ready");
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setResult(null);
        setError(errorText(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    onNewInputs((inputs) => {
      // a new event never shows the previous event's chart under its heading
      setResult(null);
      load({
        event: str(inputs.event),
        on: str(inputs.on),
        where: str(inputs.where),
        win: windowFromInputs(inputs),
        unit: normalizeUnit(inputs.unit),
        type: inputs.type === "unique" ? "unique" : "general",
      });
    });
  }, [load]);

  const { rows, lines, more } = useMemo(() => (result ? toChart(result) : { rows: [], lines: [], more: 0 }), [result]);
  const busy = state === "loading";
  const total = lines.reduce((a, l) => a + l.total, 0);
  // includes the current, still-filling period
  const average = rows.length ? total / rows.length : null;
  const shown = span.from ? span : resolveWindow(q.win);

  function toggle(key: string) {
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const tick = (d: string) => (q.unit === "month" ? dayjs(d).format("MMM YYYY") : dayjs(d).format("MMM D"));

  return (
    <div className="mp-root">
      <div className="mp-head">
        <div className="mp-title">
          <span className="mp-mark" aria-hidden="true" />
          <span className="n" title={q.event}>
            {q.event || "No event"}
          </span>
          {q.event ? <span className="sub">{windowLabel(shown)}</span> : null}
        </div>
        <AntTooltip title="Refresh">
          <Button size="small" icon={<ReloadOutlined />} aria-label="Refresh" disabled={busy || !q.event} onClick={() => load(q)} />
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
              disabled={busy || !q.event}
              onClick={() => load({ ...q, win: { range: r.key } })}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="mp-seg" role="group" aria-label="Interval">
          {UNITS.map((u) => (
            <button
              type="button"
              key={u.key}
              className={q.unit === u.key ? "on" : ""}
              aria-pressed={q.unit === u.key}
              disabled={busy || !q.event}
              onClick={() => load({ ...q, unit: u.key })}
            >
              {u.label}
            </button>
          ))}
        </div>
        <div className="mp-seg" role="group" aria-label="Measure">
          {(["general", "unique"] as const).map((t) => (
            <button
              type="button"
              key={t}
              className={q.type === t ? "on" : ""}
              aria-pressed={q.type === t}
              disabled={busy || !q.event}
              onClick={() => load({ ...q, type: t })}
            >
              {t === "general" ? "Total" : "Uniques"}
            </button>
          ))}
        </div>
        {q.on ? <span className="mp-chip" title={q.on}>by {q.on}</span> : null}
        {q.where ? <span className="mp-chip" title={q.where}>where {q.where}</span> : null}
      </div>
      {state === "idle" ? (
        <div className="mp-empty">Pass an event name, e.g. Sign Up</div>
      ) : state === "error" ? (
        <div className="mp-error">
          <b>Couldn't load the event</b>
          {error ? <div>{error}</div> : null}
        </div>
      ) : busy && !result ? (
        <div style={{ padding: "14px 16px" }}>
          <Skeleton active title={false} paragraph={{ rows: 7 }} />
        </div>
      ) : !hasData(rows, lines) ? (
        <div className="mp-empty">No {q.event} events in this date range</div>
      ) : (
        <div aria-busy={busy}>
          <div className="mp-kpis">
            {q.type === "general" ? (
              <div className="mp-kpi">
                <div className="k">Total events</div>
                <div className="v">{compact(total)}</div>
              </div>
            ) : null}
            <div className="mp-kpi">
              <div className="k">{q.type === "general" ? "Average" : "Average uniques"} per {UNITS.find((u) => u.key === q.unit)?.label.toLowerCase()}</div>
              <div className="v">{compact(average)}</div>
            </div>
          </div>
          <div className="mp-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="#f0eff4" vertical={false} />
                <XAxis dataKey="date" tickFormatter={tick} tick={{ fontSize: 11, fill: "#8d8a9c" }} stroke="#e9e8ef" minTickGap={28} />
                <YAxis tickFormatter={(v: number) => compact(v)} tick={{ fontSize: 11, fill: "#8d8a9c" }} stroke="#e9e8ef" width={48} allowDecimals={false} />
                <Tooltip
                  labelFormatter={(d: string) => (q.unit === "month" ? dayjs(d).format("MMMM YYYY") : q.unit === "week" ? `Week of ${dayjs(d).format("MMM D, YYYY")}` : dayjs(d).format("ddd, MMM D, YYYY"))}
                  formatter={(v: number, name: string) => [compact(v), lines.find((l) => l.key === name)?.label ?? name]}
                  contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: "#e9e8ef" }}
                />
                {lines.map((l) => (
                  <ChartLine
                    key={l.key}
                    dataKey={l.key}
                    name={l.key}
                    stroke={l.color}
                    strokeWidth={2}
                    dot={rows.length <= 1 ? { r: 3, fill: l.color } : false}
                    isAnimationActive={false}
                    hide={hidden.has(l.key)}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mp-legend">
            {lines.map((l) => (
              <button
                type="button"
                key={l.key}
                className={`it${hidden.has(l.key) ? " off" : ""}`}
                aria-pressed={!hidden.has(l.key)}
                title={hidden.has(l.key) ? `Show ${l.label}` : `Hide ${l.label}`}
                onClick={() => toggle(l.key)}
              >
                <span className="sw" style={{ background: hidden.has(l.key) ? "#d9d7e2" : l.color }} aria-hidden="true" />
                <span className="n">{l.label}</span>
                {q.type === "general" ? <span className="c">{compact(l.total)}</span> : null}
              </button>
            ))}
          </div>
          {more ? <div className="mp-note">Showing the top {lines.length} of {lines.length + more} values — add a where filter to narrow it.</div> : null}
        </div>
      )}
    </div>
  );
}
