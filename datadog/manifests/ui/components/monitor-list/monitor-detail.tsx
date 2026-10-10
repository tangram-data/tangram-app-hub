// Expanded row of the monitor list: Monitor.Get with group_states=all.
import { Button, Skeleton } from "antd";
import React, { useEffect, useRef, useState } from "react";
import { errorText, statusLook, statusRank, timeLabel } from "./monitor-status";

const tangram = (window as any).tangram;
const MAX_GROUPS = 10;

type GroupState = { status?: string; last_triggered_ts?: number | null; name?: string };
type MonitorDetailData = {
  id: number;
  name?: string;
  type?: string;
  query?: string;
  message?: string;
  overall_state?: string;
  options?: { thresholds?: Record<string, number | null | undefined> };
  state?: { groups?: Record<string, GroupState> };
};

function thresholdText(t: Record<string, number | null | undefined> | undefined): string {
  if (!t) return "";
  const order = ["critical", "critical_recovery", "warning", "warning_recovery", "ok", "unknown"];
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.keys(t)
    .sort((a, b) => rank(a) - rank(b))
    .filter((k) => t[k] !== null && t[k] !== undefined)
    .map((k) => `${k.replace(/_/g, " ")} ${t[k]}`)
    .join(" · ");
}

export function MonitorDetail({ id, name, onOpen }: { id: number; name: string; onOpen: () => void }) {
  const [data, setData] = useState<MonitorDetailData | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setData(null);
    setError("");
    tangram
      .performAction(
        { resourceType: "Monitor", action: "Get" },
        { parameters: { monitor_id: id, group_states: "all" } },
      )
      .then((r: MonitorDetailData) => {
        if (mine === seq.current) setData(r ?? null);
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setError(errorText(e));
      });
  }, [id]);

  if (error)
    return (
      <div className="dd-detail">
        <div className="dd-error inline">
          <b>Couldn't load monitor</b>
          <div>{error}</div>
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="dd-detail">
        <Skeleton active title={false} paragraph={{ rows: 3 }} />
      </div>
    );

  const allGroups = Object.entries(data.state?.groups ?? {}).map(([key, g]) => ({ key: g.name ?? key, ...g }));
  const groups = allGroups
    .filter((g) => (g.status ?? "").toLowerCase() !== "ok")
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || (b.last_triggered_ts ?? 0) - (a.last_triggered_ts ?? 0));
  const thresholds = thresholdText(data.options?.thresholds);
  const overall = statusLook(data.overall_state);

  return (
    <div className="dd-detail">
      <div className="dd-kv">
        <span className="k">State</span>
        <span className={`v dd-status${overall.bad ? " bad" : ""}`}>
          <span className="dd-dot" style={{ background: overall.color }} aria-hidden="true" />
          {overall.bad ? <b>{overall.word}</b> : overall.word}
          {data.type ? <span className="dd-faint"> · {data.type}</span> : null}
        </span>
        <span className="k">Query</span>
        <span className="v dd-code">{data.query || "—"}</span>
        {thresholds ? (
          <>
            <span className="k">Thresholds</span>
            <span className="v dd-mono">{thresholds}</span>
          </>
        ) : null}
        {data.message ? (
          <>
            <span className="k">Message</span>
            <span className="v dd-msg">{data.message}</span>
          </>
        ) : null}
        <span className="k">Groups</span>
        <span className="v">
          {groups.length === 0 ? (
            <span className="dd-faint">{allGroups.length ? "All groups OK" : "No group state available"}</span>
          ) : (
            <span className="dd-groups">
              {groups.slice(0, MAX_GROUPS).map((g) => {
                const look = statusLook(g.status);
                return (
                  <span className="dd-group" key={g.key} title={g.key}>
                    <span className="dd-dot" style={{ background: look.color }} aria-hidden="true" />
                    <span className="dd-muted" style={{ width: 56, flex: "none" }}>
                      {look.word}
                    </span>
                    <span className="n">{g.key}</span>
                    {g.last_triggered_ts ? <span className="dd-faint">{timeLabel(g.last_triggered_ts)}</span> : null}
                  </span>
                );
              })}
              {groups.length > MAX_GROUPS ? (
                <span className="dd-faint">and {groups.length - MAX_GROUPS} more not OK</span>
              ) : null}
            </span>
          )}
        </span>
      </div>
      <div className="dd-actions">
        <Button size="small" onClick={onOpen} aria-label={`Select monitor ${name}`}>
          Select
        </Button>
      </div>
    </div>
  );
}
