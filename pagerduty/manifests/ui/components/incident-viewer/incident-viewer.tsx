// One PagerDuty incident: header facts, the overview timeline, responder notes,
// and the responder's own state changes (Acknowledge / Resolve) and notes.
// Every write goes through the connector's confirmation-gated actions — the
// host asks the user before it runs — then the view reloads.
import { CheckOutlined, ExportOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Input, Skeleton, Tooltip } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/pagerduty.css";
import "../../shared/tangram-buttons.css";
import { call, errText, relative, Ref, STATUS_WORD, tangram, timeLabel } from "../../shared/pd";

type Incident = {
  id: string;
  incident_number?: number;
  title?: string;
  status?: string;
  urgency?: string;
  created_at?: string;
  html_url?: string;
  service?: Ref;
  escalation_policy?: Ref;
  priority?: Ref | null;
  assignments?: { assignee?: Ref }[];
};
type LogEntry = { id: string; type?: string; created_at?: string; summary?: string; agent?: Ref | null };
type Note = { id: string; content?: string; created_at?: string; user?: Ref | null };
type Section<T> = { items: T[]; error: string };

const EMPTY = { items: [], error: "" };

// "acknowledge_log_entry" → "acknowledge"
function entryKind(type?: string): string {
  return (type ?? "").replace(/_log_entry(_reference)?$/, "").replace(/_/g, " ");
}

export default function IncidentViewer() {
  const [incidentId, setIncidentId] = useState("");
  const [incident, setIncident] = useState<Incident | null>(null);
  const [logs, setLogs] = useState<Section<LogEntry>>(EMPTY);
  const [notes, setNotes] = useState<Section<Note>>(EMPTY);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [writing, setWriting] = useState<"" | "acknowledged" | "resolved" | "note">("");
  const [writeError, setWriteError] = useState("");
  const [noteText, setNoteText] = useState("");
  const seq = useRef(0);
  // provideState and write callbacks read the latest values, not a stale render's.
  const incidentIdRef = useRef("");
  const statusRef = useRef("");
  incidentIdRef.current = incidentId;
  statusRef.current = incident?.status ?? "";

  const load = useCallback((id: string, quiet = false) => {
    const mine = ++seq.current;
    if (!id) {
      setState("error");
      setError("No incident id given.");
      return;
    }
    if (!quiet) setState("loading");
    setError("");
    const params = { parameters: { id } };
    Promise.allSettled([
      call<{ incident?: Incident }>("Incident", "Get", params),
      call<{ log_entries?: LogEntry[] }>("Incident", "ListLogEntries", {
        parameters: { id, is_overview: true, limit: 50 },
      }),
      call<{ notes?: Note[] }>("Incident", "ListNotes", params),
    ]).then(([inc, lg, nt]) => {
      if (mine !== seq.current) return;
      if (inc.status === "rejected" || !inc.value?.incident) {
        setIncident(null);
        setError(inc.status === "rejected" ? errText(inc.reason) : "Incident not found.");
        setState("error");
        return;
      }
      setIncident(inc.value.incident);
      setLogs(
        lg.status === "fulfilled"
          ? { items: [...(lg.value?.log_entries ?? [])].sort(byTimeDesc), error: "" }
          : { items: [], error: errText(lg.reason) },
      );
      setNotes(
        nt.status === "fulfilled" ? { items: nt.value?.notes ?? [], error: "" } : { items: [], error: errText(nt.reason) },
      );
      setState("ready");
    });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const id = String(inputs?.incidentId ?? "").trim();
      setIncidentId(id);
      setWriteError("");
      setNoteText("");
      load(id);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
    tangram.provideState?.(() => ({ incidentId: incidentIdRef.current, status: statusRef.current }));
  }, [load]);

  function setStatus(status: "acknowledged" | "resolved") {
    if (!incident || writing) return;
    const id = incident.id;
    setWriting(status);
    setWriteError("");
    call("Incident", "Update", {
      parameters: { id },
      requestBody: { incident: { type: "incident_reference", status } },
    })
      .then(() => {
        tangram.emit("updated", { incidentId: id, status });
        if (incidentIdRef.current === id) load(id, true);
      })
      .catch((e: unknown) => {
        if (incidentIdRef.current === id) setWriteError(errText(e));
      })
      .finally(() => setWriting(""));
  }

  function addNote() {
    const content = noteText.trim();
    if (!incident || !content || writing) return;
    const id = incident.id;
    setWriting("note");
    setWriteError("");
    call("Incident", "AddNote", { parameters: { id }, requestBody: { note: { content } } })
      .then(() => {
        if (incidentIdRef.current !== id) return;
        setNoteText("");
        load(id, true);
      })
      .catch((e: unknown) => {
        if (incidentIdRef.current === id) setWriteError(errText(e));
      })
      .finally(() => setWriting(""));
  }

  if (state === "loading") {
    return (
      <div className="pd-root">
        <div className="pd-brandbar" />
        <div className="pd-pad">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      </div>
    );
  }
  if (state === "error" || !incident) {
    return (
      <div className="pd-root">
        <div className="pd-brandbar" />
        <div className="pd-pad">
          <div className="pd-error">
            <b>Couldn't load the incident</b>
            {error ? <div>{error}</div> : null}
          </div>
          {incidentId ? (
            <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} onClick={() => load(incidentId)}>
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const status = incident.status ?? "";
  const assignees = (incident.assignments ?? []).map((a) => a.assignee?.summary).filter(Boolean) as string[];
  const busy = writing !== "";

  return (
    <div className="pd-root">
      <div className="pd-brandbar" />
      <div className="pd-pad">
        <div className="pd-head">
          <div className="main">
            <div className="pd-num">
              #{incident.incident_number ?? incident.id}
              {incident.html_url ? (
                <>
                  {" · "}
                  <a href={incident.html_url} target="_blank" rel="noopener noreferrer">
                    Open in PagerDuty <ExportOutlined aria-hidden="true" />
                  </a>
                </>
              ) : null}
            </div>
            <h1 className="pd-title">{incident.title ?? "Untitled incident"}</h1>
            <div className="pd-facts">
              <span className={`pd-status ${status}`}>
                <span className={`pd-dot ${status}`} aria-hidden="true" />
                {status === "triggered" ? <b>{STATUS_WORD[status]}</b> : STATUS_WORD[status] ?? status}
              </span>
              {incident.urgency ? <span className={`pd-urg ${incident.urgency}`}>{incident.urgency} urgency</span> : null}
              {incident.priority?.summary ? <span>Priority <b>{incident.priority.summary}</b></span> : null}
              {incident.service?.summary ? <span>Service <b>{incident.service.summary}</b></span> : null}
              <span title={incident.created_at ? dayjs(incident.created_at).format("MMM D, YYYY HH:mm:ss") : ""}>
                Opened <b>{relative(incident.created_at)}</b>
              </span>
              {assignees.length ? (
                <span title={assignees.join(", ")}>
                  Assigned <b>{assignees.slice(0, 3).join(", ")}{assignees.length > 3 ? ` +${assignees.length - 3}` : ""}</b>
                </span>
              ) : null}
            </div>
          </div>
          <div className="pd-actions">
            <Tooltip title="Refresh">
              <Button
                aria-label="Refresh"
                icon={<ReloadOutlined aria-hidden="true" />}
                disabled={busy}
                onClick={() => load(incident.id, true)}
              />
            </Tooltip>
            {status === "triggered" ? (
              <>
                <Button disabled={busy} loading={writing === "resolved"} onClick={() => setStatus("resolved")}>
                  Resolve
                </Button>
                <Button type="primary" disabled={busy} loading={writing === "acknowledged"} onClick={() => setStatus("acknowledged")}>
                  Acknowledge
                </Button>
              </>
            ) : status === "acknowledged" ? (
              <Button
                type="primary"
                icon={<CheckOutlined aria-hidden="true" />}
                disabled={busy}
                loading={writing === "resolved"}
                onClick={() => setStatus("resolved")}
              >
                Resolve
              </Button>
            ) : null}
          </div>
        </div>
        {writeError ? (
          <div className="pd-error" role="alert">
            <b>Not saved</b>
            <div>{writeError}</div>
          </div>
        ) : null}

        <section className="pd-section" aria-label="Notes">
          <h2 className="pd-h">Notes · {notes.items.length}</h2>
          <div className="pd-card">
            {notes.error ? (
              <div className="pd-empty">Couldn't load notes: {notes.error}</div>
            ) : notes.items.length === 0 ? (
              <div className="pd-empty">No notes yet</div>
            ) : (
              notes.items.map((n) => (
                <div className="pd-note" key={n.id}>
                  <div className="who">
                    {n.user?.summary ?? "Someone"} · <span title={relative(n.created_at)}>{timeLabel(n.created_at)}</span>
                  </div>
                  <div className="txt">{n.content}</div>
                </div>
              ))
            )}
          </div>
          <div className="pd-addnote">
            <Input.TextArea
              aria-label="New note"
              autoSize={{ minRows: 1, maxRows: 6 }}
              placeholder="Add a note — findings, mitigation, next steps"
              value={noteText}
              disabled={busy}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <Button type="primary" disabled={busy || !noteText.trim()} loading={writing === "note"} onClick={addNote}>
              Add note
            </Button>
          </div>
        </section>

        <section className="pd-section" aria-label="Timeline">
          <h2 className="pd-h">Timeline</h2>
          <div className="pd-card">
            {logs.error ? (
              <div className="pd-empty">Couldn't load the timeline: {logs.error}</div>
            ) : logs.items.length === 0 ? (
              <div className="pd-empty">No timeline entries</div>
            ) : (
              <table className="pd-table">
                <colgroup>
                  <col style={{ width: 118 }} />
                  <col style={{ width: 110 }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.items.map((l) => (
                    <tr key={l.id}>
                      <td className="pd-time" title={relative(l.created_at)}>
                        {timeLabel(l.created_at)}
                      </td>
                      <td className="pd-muted" title={entryKind(l.type)}>
                        {entryKind(l.type)}
                      </td>
                      <td title={l.summary ?? ""}>{l.summary ?? l.agent?.summary ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function byTimeDesc(a: { created_at?: string }, b: { created_at?: string }): number {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}
