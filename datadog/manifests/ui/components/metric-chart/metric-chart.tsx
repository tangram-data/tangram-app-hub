// A Datadog timeseries through the connector's read-only Metric.Query: one line
// per series (scope as legend), a range selector, the series unit on the y-axis.
// Inputs: query (required), range (15m/1h/4h/1d/7d) or from/to UNIX seconds.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip as AntTooltip } from "antd";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line as ChartLine, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "../../shared/datadog.css";
import "../../shared/tangram-buttons.css";
import { axisUnit, compact, fullTime, hasData, MAX_SERIES, QueryResult, RANGES, Series, tickTime, toLines } from "./metric-series";

const tangram = (window as any).tangram;

// A preset range, or "custom" with explicit from/to (UNIX seconds) from render inputs.
type TimeWindow = { range: string; from?: number; to?: number };

function resolveWindow(w: TimeWindow): { from: number; to: number } {
  if (w.range === "custom" && w.from && w.to) return { from: w.from, to: w.to };
  const now = Math.floor(Date.now() / 1000);
  const span = RANGES.find((r) => r.key === w.range)?.seconds ?? 3600;
  return { from: now - span, to: now };
}

function windowFromInputs(inputs: Record<string, unknown>): TimeWindow {
  const from = Number(inputs?.from);
  const to = Number(inputs?.to);
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from) return { range: "custom", from, to };
  const r = String(inputs?.range ?? "1h");
  return { range: RANGES.some((x) => x.key === r) ? r : "1h" };
}

export default function MetricChart() {
  const [query, setQuery] = useState("");
  const [win, setWin] = useState<TimeWindow>({ range: "1h" });
  const [series, setSeries] = useState<Series[]>([]);
  const [span, setSpan] = useState({ from: 0, to: 0 });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback((q: string, w: TimeWindow) => {
    const mine = ++seq.current;
    if (!q.trim()) {
      setState("idle");
      setSeries([]);
      return;
    }
    const { from, to } = resolveWindow(w);
    setState("loading");
    setError("");
    tangram
      .performAction({ resourceType: "Metric", action: "Query" }, { parameters: { query: q, from, to } })
      .then((r: QueryResult) => {
        if (mine !== seq.current) return;
        if (r?.status === "error" || r?.error) throw new Error(r?.error || "Datadog returned an error");
        setSeries(r?.series ?? []);
        setSpan({ from, to });
        setHidden(new Set());
        setState("ready");
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setSeries([]);
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const q = typeof inputs?.query === "string" ? inputs.query : "";
      const w = windowFromInputs(inputs ?? {});
      setQuery(q);
      setWin(w);
      // a new query never shows the previous query's chart under its heading
      setSeries([]);
      load(q, w);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  const lines = useMemo(() => toLines(series.slice(0, MAX_SERIES)), [series]);
  const unit = axisUnit(series.slice(0, MAX_SERIES));
  const spanSeconds = span.to - span.from;
  const busy = state === "loading";

  function pick(range: string) {
    const w: TimeWindow = { range };
    setWin(w);
    load(query, w);
  }

  function toggle(key: string) {
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="dd-root">
      <div className="dd-head">
        <span className="dd-mark" aria-hidden="true" />
        <span className="dd-query" title={query}>
          {query || "No metric query"}
        </span>
        <div className="dd-ranges" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              type="button"
              key={r.key}
              className={win.range === r.key ? "on" : ""}
              aria-pressed={win.range === r.key}
              disabled={busy || !query.trim()}
              onClick={() => pick(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <AntTooltip title="Refresh">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            aria-label="Refresh"
            disabled={busy || !query.trim()}
            onClick={() => load(query, win)}
          />
        </AntTooltip>
      </div>
      {state === "idle" ? (
        <div className="dd-empty">Pass a metric query, e.g. avg:system.cpu.user{"{env:prod}"} by {"{host}"}</div>
      ) : state === "error" ? (
        <div className="dd-error">
          <b>Couldn't query the metric</b>
          {error ? <div>{error}</div> : null}
        </div>
      ) : busy && series.length === 0 ? (
        <div style={{ padding: "14px" }}>
          <Skeleton active title={false} paragraph={{ rows: 6 }} />
        </div>
      ) : !hasData(lines) ? (
        <div className="dd-empty">No data points in this time range</div>
      ) : (
        <>
          <div className="dd-chart" aria-busy={busy}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart margin={{ top: 4, right: 16, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="#eef1f3" vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  allowDuplicatedCategory={false}
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(ms: number) => tickTime(ms, spanSeconds)}
                  tick={{ fontSize: 11, fill: "#87939c" }}
                  stroke="#e3e7ea"
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={(v: number) => compact(v)}
                  tick={{ fontSize: 11, fill: "#87939c" }}
                  stroke="#e3e7ea"
                  width={52}
                  label={
                    unit
                      ? { value: unit, angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "#87939c" } }
                      : undefined
                  }
                />
                <Tooltip
                  labelFormatter={(ms: number) => fullTime(ms)}
                  formatter={(v: number, name: string) => {
                    const line = lines.find((l) => l.key === name);
                    return [`${compact(v)}${line?.unit ? ` ${line.unit}` : ""}`, line?.label ?? name];
                  }}
                  contentStyle={{ fontSize: 12, borderRadius: 4, borderColor: "#e3e7ea" }}
                />
                {lines.map((l) => (
                  <ChartLine
                    key={l.key}
                    name={l.key}
                    data={l.points}
                    dataKey="v"
                    stroke={l.color}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    hide={hidden.has(l.key)}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="dd-legend">
            {lines.map((l) => (
              <button
                type="button"
                key={l.key}
                className={`it${hidden.has(l.key) ? " off" : ""}`}
                aria-pressed={!hidden.has(l.key)}
                title={hidden.has(l.key) ? `Show ${l.label}` : `Hide ${l.label}`}
                onClick={() => toggle(l.key)}
              >
                <span className="sw" style={{ background: hidden.has(l.key) ? "#cfd5da" : l.color }} aria-hidden="true" />
                <span className="n">{l.label}</span>
              </button>
            ))}
          </div>
          {series.length > MAX_SERIES ? (
            <div className="dd-note">
              Showing {MAX_SERIES} of {series.length} series — narrow the query (e.g. top(…, 10, 'mean', 'desc')) to see the rest.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
