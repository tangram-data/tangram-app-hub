// One Mixpanel event over time through the connector's read-only Event.Segment: totals or uniques per day/week/month,
// optionally broken down by a property (top 10 values). Inputs: event (required), range or from_date/to_date, unit,
// interval, type, on, where, limit, workspace_id — the call's own query, kept as asked.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip as AntTooltip } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line as ChartLine, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "../../shared/mixpanel.css";
import "../../shared/tangram-buttons.css";
import { compact, DateWindow, errorText, RANGES, resolveWindow, windowFromInputs, windowLabel } from "../../shared/mp-format";
import { onNewInputs } from "../../shared/sandbox-inputs";
import { hasData, rollUp, SegmentResult, toChart, Unit, unitFromInputs, unitParams, unitsFor } from "./segment-series";

const tangram = (window as any).tangram;

type Measure = "general" | "unique" | "average";
const MEASURES: { key: Measure; label: string }[] = [
  { key: "general", label: "Total" },
  { key: "unique", label: "Uniques" },
  { key: "average", label: "Per user" },
];

type Query = {
  event: string;
  on: string;
  where: string;
  win: DateWindow;
  unit: Unit;
  units: Unit[];
  type: Measure;
  limit: number | null;
  workspaceId: number | null;
};

const posInt = (v: unknown) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export default function EventChart() {
  const [q, setQ] = useState<Query>({
    event: "",
    on: "",
    where: "",
    win: { range: "30d" },
    unit: { key: "day", label: "Day" },
    units: [],
    type: "general",
    limit: null,
    workspaceId: null,
  });
  const [result, setResult] = useState<SegmentResult | null>(null);
  const [span, setSpan] = useState({ from: "", to: "" });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const seq = useRef(0);

  // A refresh keeps the current chart on screen; any other change clears it so nothing shows under the wrong label.
  const load = useCallback((next: Query, refresh = false) => {
    const mine = ++seq.current;
    setQ(next);
    if (!refresh) {
      setResult(null);
      setSpan({ from: "", to: "" });
    }
    if (!next.event) {
      setResult(null);
      setState("idle");
      return;
    }
    const { from, to } = resolveWindow(next.win);
    const { params, rollUpDays } = unitParams(next.unit.key, next.type);
    const parameters: Record<string, unknown> = { event: next.event, from_date: from, to_date: to, type: next.type, ...params };
    if (next.on) {
      parameters.on = next.on;
      parameters.limit = next.limit ?? 50;
    } else if (next.limit) parameters.limit = next.limit;
    if (next.where) parameters.where = next.where;
    if (next.workspaceId) parameters.workspace_id = next.workspaceId;
    setState("loading");
    setError("");
    tangram
      .performAction({ resourceType: "Event", action: "Segment" }, { parameters })
      .then((r: SegmentResult) => {
        if (mine !== seq.current) return;
        if (r?.error) throw new Error(r.error);
        setResult(rollUpDays ? rollUp(r ?? {}, from, rollUpDays) : r ?? {});
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
      const unit = unitFromInputs(inputs.unit, inputs.interval);
      load({
        // event names are exact — "Purchase " is a different event
        event: typeof inputs.event === "string" && inputs.event.trim() ? inputs.event : "",
        on: str(inputs.on),
        where: str(inputs.where),
        win: windowFromInputs(inputs),
        unit,
        units: unitsFor(unit),
        type: MEASURES.find((m) => m.key === inputs.type)?.key ?? "general",
        limit: posInt(inputs.limit),
        workspaceId: posInt(inputs.workspace_id),
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

  // per-bucket figures are only exact without a breakdown (values beyond the top ones, users in several values)
  const kpis = !q.on && q.type !== "average";
  const unitWord = q.unit.label.toLowerCase().replace(/^(\d+) days$/, "$1-day period");
  const tick = (d: string) =>
    ["hour", "minute"].includes(q.unit.key) ? dayjs(d).format("MMM D HH:mm") : q.unit.key === "month" ? dayjs(d).format("MMM YYYY") : dayjs(d).format("MMM D");
  const tipLabel = (d: string) =>
    ["hour", "minute"].includes(q.unit.key)
      ? dayjs(d).format("ddd, MMM D, HH:mm")
      : q.unit.key === "month"
        ? dayjs(d).format("MMMM YYYY")
        : q.unit.key === "day"
          ? dayjs(d).format("ddd, MMM D, YYYY")
          : `${q.unit.label} from ${dayjs(d).format("MMM D, YYYY")}`;

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
          <Button size="small" icon={<ReloadOutlined />} aria-label="Refresh" disabled={busy || !q.event} onClick={() => load(q, true)} />
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
          {q.units.map((u) => (
            <button
              type="button"
              key={u.key}
              className={q.unit.key === u.key ? "on" : ""}
              aria-pressed={q.unit.key === u.key}
              disabled={busy || !q.event}
              onClick={() => load({ ...q, unit: u })}
            >
              {u.label}
            </button>
          ))}
        </div>
        <div className="mp-seg" role="group" aria-label="Measure">
          {MEASURES.map((m) => (
            <button
              type="button"
              key={m.key}
              className={q.type === m.key ? "on" : ""}
              aria-pressed={q.type === m.key}
              disabled={busy || !q.event}
              onClick={() => load({ ...q, type: m.key })}
            >
              {m.label}
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
          {kpis ? (
            <div className="mp-kpis">
              {q.type === "general" ? (
                <div className="mp-kpi">
                  <div className="k">Total events</div>
                  <div className="v">{compact(total)}</div>
                </div>
              ) : null}
              <div className="mp-kpi">
                <div className="k">
                  {q.type === "general" ? "Average" : "Average uniques"} per {unitWord}
                </div>
                <div className="v">{compact(average)}</div>
              </div>
            </div>
          ) : null}
          <div className="mp-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="#f0eff4" vertical={false} />
                <XAxis dataKey="date" tickFormatter={tick} tick={{ fontSize: 11, fill: "#8d8a9c" }} stroke="#e9e8ef" minTickGap={28} />
                <YAxis tickFormatter={(v: number) => compact(v)} tick={{ fontSize: 11, fill: "#8d8a9c" }} stroke="#e9e8ef" width={48} allowDecimals={q.type === "average"} />
                <Tooltip
                  labelFormatter={tipLabel}
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
