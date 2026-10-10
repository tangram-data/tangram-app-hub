// Who is on call right now, grouped by escalation policy and level, with a
// strip of open (triggered / acknowledged) incidents. Read-only: clicking an
// incident emits `open` so the host or agent can show it.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/pagerduty.css";
import "../../shared/tangram-buttons.css";
import { avatarColor, call, errText, initials, Ref, relative, safeUrl, STATUS_WORD, tangram, timeLabel } from "../../shared/pd";

type OnCall = {
  escalation_policy?: Ref;
  escalation_level?: number;
  schedule?: Ref | null;
  user?: Ref;
  start?: string | null;
  end?: string | null;
};
type Incident = { id: string; incident_number?: number; title?: string; status?: string; created_at?: string; service?: Ref };
type Person = { user: Ref; schedule?: string; end?: string | null };
type Policy = { id: string; name: string; levels: { level: number; people: Person[] }[] };

const PAGE = 100;
const INCIDENTS = 10;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function zone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// On-call entries → policies → levels → distinct people (earliest shift end wins).
function group(entries: OnCall[]): Policy[] {
  const byPolicy = new Map<string, Policy>();
  for (const e of entries) {
    const pid = e.escalation_policy?.id ?? "";
    const policy = byPolicy.get(pid) ?? { id: pid, name: e.escalation_policy?.summary ?? "Escalation policy", levels: [] };
    byPolicy.set(pid, policy);
    const lvl = e.escalation_level ?? 1;
    let level = policy.levels.find((l) => l.level === lvl);
    if (!level) {
      level = { level: lvl, people: [] };
      policy.levels.push(level);
    }
    if (e.user && !level.people.some((p) => p.user.id === e.user?.id)) {
      level.people.push({ user: e.user, schedule: e.schedule?.summary, end: e.end });
    }
  }
  const out = [...byPolicy.values()];
  out.forEach((p) => p.levels.sort((a, b) => a.level - b.level));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function untilLabel(end?: string | null): string {
  if (!end) return "always on call";
  const d = dayjs(end);
  return `until ${d.isSame(dayjs(), "day") ? d.format("HH:mm") : d.format("ddd MMM D HH:mm")}`;
}

export default function OncallBoard() {
  const [filters, setFilters] = useState<{ policies: string[]; schedules: string[] }>({ policies: [], schedules: [] });
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [capped, setCapped] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [moreIncidents, setMoreIncidents] = useState(false);
  const [incidentError, setIncidentError] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback((policyIds: string[], scheduleIds: string[], quiet = false) => {
    const mine = ++seq.current;
    if (!quiet) setState("loading");
    setError("");
    const tz = zone();
    const onCallParams: Record<string, unknown> = { earliest: true, time_zone: tz, limit: PAGE };
    if (policyIds.length) onCallParams["escalation_policy_ids[]"] = policyIds;
    if (scheduleIds.length) onCallParams["schedule_ids[]"] = scheduleIds;
    Promise.allSettled([
      call<{ oncalls?: OnCall[]; more?: boolean }>("OnCall", "List", { parameters: onCallParams }),
      call<{ incidents?: Incident[]; more?: boolean }>("Incident", "List", {
        parameters: {
          "statuses[]": ["triggered", "acknowledged"],
          // open incidents of any age, not just PagerDuty's default 30 days
          date_range: "all",
          sort_by: "created_at:desc",
          limit: INCIDENTS,
        },
      }),
    ]).then(([oc, inc]) => {
      if (mine !== seq.current) return;
      if (oc.status === "rejected") {
        setPolicies([]);
        setError(errText(oc.reason));
        setState("error");
        return;
      }
      setPolicies(group(oc.value?.oncalls ?? []));
      setCapped(Boolean(oc.value?.more));
      if (inc.status === "fulfilled") {
        setIncidents(inc.value?.incidents ?? []);
        setMoreIncidents(Boolean(inc.value?.more));
        setIncidentError("");
      } else {
        setIncidents([]);
        setMoreIncidents(false);
        setIncidentError(errText(inc.reason));
      }
      setState("ready");
    });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const f = { policies: strings(inputs?.escalationPolicyIds), schedules: strings(inputs?.scheduleIds) };
      setFilters(f);
      load(f.policies, f.schedules);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  const people = policies.reduce((n, p) => n + p.levels.reduce((m, l) => m + l.people.length, 0), 0);
  const scope =
    filters.policies.length || filters.schedules.length
      ? `${filters.policies.length + filters.schedules.length} selected`
      : "all escalation policies";

  return (
    <div className="pd-root">
      <div className="pd-brandbar" />
      <div className="pd-bar">
        <span className="sum" title={`On call now · ${scope} · times in ${zone()}`}>
          {state === "ready"
            ? `${people} on call across ${policies.length} ${policies.length === 1 ? "policy" : "policies"} · ${scope}`
            : "On call now"}
        </span>
        <Tooltip title="Refresh">
          <Button
            size="small"
            aria-label="Refresh"
            icon={<ReloadOutlined aria-hidden="true" />}
            disabled={state === "loading"}
            onClick={() => load(filters.policies, filters.schedules, true)}
          />
        </Tooltip>
      </div>

      {state === "loading" ? (
        <div className="pd-pad">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : state === "error" ? (
        <div className="pd-pad">
          <div className="pd-error">
            <b>Couldn't load who is on call</b>
            {error ? <div>{error}</div> : null}
          </div>
        </div>
      ) : (
        <>
          {incidents.length || incidentError ? (
            <section className="pd-strip" aria-label="Open incidents">
              <h2 className="pd-h">
                {moreIncidents ? `Open incidents · ${INCIDENTS} newest shown` : "Open incidents"}
              </h2>
              <div className="pd-card">
                {incidentError ? (
                  <div className="pd-empty">Couldn't load incidents: {incidentError}</div>
                ) : (
                  <table className="pd-table">
                    <colgroup>
                      <col style={{ width: 112 }} />
                      <col style={{ width: 128 }} />
                      <col />
                      <col style={{ width: "26%" }} />
                    </colgroup>
                    <tbody>
                      {incidents.map((i) => (
                        <tr
                          key={i.id}
                          className="click"
                          tabIndex={0}
                          title={i.title}
                          onClick={() => tangram.emit("open", { incidentId: i.id })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") tangram.emit("open", { incidentId: i.id });
                          }}
                        >
                          <td className="pd-time" title={relative(i.created_at)}>
                            {timeLabel(i.created_at)}
                          </td>
                          <td>
                            <span className={`pd-status ${i.status ?? ""}`}>
                              <span className={`pd-dot ${i.status ?? ""}`} aria-hidden="true" />
                              {i.status === "triggered" ? <b>{STATUS_WORD.triggered}</b> : STATUS_WORD[i.status ?? ""] ?? i.status}
                            </span>
                          </td>
                          <td>
                            <span className="pd-num">#{i.incident_number}</span> {i.title}
                          </td>
                          <td className="pd-muted">{i.service?.summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          ) : null}

          {policies.length === 0 ? (
            <div className="pd-empty" style={{ padding: "24px 20px" }}>
              Nobody is on call for {scope}.
            </div>
          ) : (
            policies.map((p) => (
              <section className="pd-policy" key={p.id || p.name} aria-label={p.name}>
                <div className="name">
                  {p.name}
                  <span className="pd-faint">
                    {p.levels.length} {p.levels.length === 1 ? "level" : "levels"}
                  </span>
                </div>
                <div className="pd-card" style={{ padding: "0 12px" }}>
                  {p.levels.map((l) => (
                    <div className="pd-level" key={l.level}>
                      <div className="lv">Level {l.level}</div>
                      <div>
                        {l.people.map((person) => {
                          const name = person.user.summary ?? "Unknown user";
                          return (
                            <div className="pd-person" key={person.user.id ?? name}>
                              <span className="pd-avatar" style={{ background: avatarColor(name) }} aria-hidden="true">
                                {initials(name)}
                              </span>
                              <span className="nm" title={name}>
                                {safeUrl(person.user.html_url) ? (
                                  <a href={safeUrl(person.user.html_url)} target="_blank" rel="noopener noreferrer">
                                    {name}
                                  </a>
                                ) : (
                                  name
                                )}
                              </span>
                              {person.schedule ? <span className="pd-faint">{person.schedule}</span> : null}
                              <span
                                className="until"
                                title={person.end ? dayjs(person.end).format("MMM D, YYYY HH:mm") : ""}
                              >
                                {untilLabel(person.end)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
          {capped ? (
            <div className="pd-faint" style={{ padding: "0 20px 16px" }}>
              Showing the first {PAGE} on-call entries — pass escalationPolicyIds or scheduleIds to narrow.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
