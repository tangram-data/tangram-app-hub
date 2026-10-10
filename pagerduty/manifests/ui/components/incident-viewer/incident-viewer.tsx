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
import { call, definiteFailure, errText, openExternal, relative, Ref, safeUrl, STATUS_WORD, tangram, timeLabel } from "../../shared/pd";

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
type WriteKind = "acknowledged" | "resolved" | "note";
type Timeline = Section<LogEntry> & { more: boolean; offset: number; loadingMore: boolean };

const EMPTY = { items: [], error: "" };
const EMPTY_TIMELINE: Timeline = { items: [], error: "", more: false, offset: 0, loadingMore: false };
const LOG_PAGE = 50;

// "acknowledge_log_entry" → "acknowledge"
function entryKind(type?: string): string {
  return (type ?? "").replace(/_log_entry(_reference)?$/, "").replace(/_/g, " ");
}

export default function IncidentViewer() {
  const [incidentId, setIncidentId] = useState("");
  const [incident, setIncident] = useState<Incident | null>(null);
  const [logs, setLogs] = useState<Timeline>(EMPTY_TIMELINE);
  const [notes, setNotes] = useState<Section<Note>>(EMPTY);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  // Pending writes by canonical incident id: the lock follows the incident, not the input notification.
  const [pending, setPending] = useState<Record<string, WriteKind>>({});
  const [writeError, setWriteError] = useState("");
  // A note whose write outcome is unknown and couldn't be checked: no resubmission until a reload settles it.
  const unverified = useRef<{ id: string; content: string; since: number } | null>(null);
  const [noteCheck, setNoteCheck] = useState("");
  const [noteText, setNoteText] = useState("");
  const seq = useRef(0);
  // Bumped on every new input: write callbacks from an earlier input are ignored. The input may be an incident
  // NUMBER; reads and writes use the canonical id the API returned.
  const generation = useRef(0);
  const canonicalId = useRef("");
  const inputId = useRef<string | null>(null);
  const statusRef = useRef("");
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
      call<{ log_entries?: LogEntry[]; more?: boolean }>("Incident", "ListLogEntries", {
        parameters: { id, is_overview: true, limit: LOG_PAGE, offset: 0 },
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
      canonicalId.current = inc.value.incident.id;
      setLogs(
        lg.status === "fulfilled"
          ? {
              items: [...(lg.value?.log_entries ?? [])].sort(byTimeDesc),
              error: "",
              more: Boolean(lg.value?.more),
              offset: (lg.value?.log_entries ?? []).length,
              loadingMore: false,
            }
          : { ...EMPTY_TIMELINE, error: errText(lg.reason) },
      );
      setNotes(
        nt.status === "fulfilled" ? { items: nt.value?.notes ?? [], error: "" } : { items: [], error: errText(nt.reason) },
      );
      const u = unverified.current;
      if (u && u.id === inc.value.incident.id && nt.status === "fulfilled") {
        unverified.current = null;
        setNoteCheck("");
        if (hasNote(nt.value?.notes ?? [], u.content, u.since)) setNoteText((t) => (t.trim() === u.content ? "" : t));
      }
      setState("ready");
    });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const id = String(inputs?.incidentId ?? "").trim();
      // re-sent inputs for the same incident keep the draft, errors and pending writes
      if (id === inputId.current) return;
      inputId.current = id;
      generation.current += 1;
      canonicalId.current = "";
      setIncidentId(id);
      setWriteError("");
      setNoteText("");
      setNoteCheck("");
      load(id);
    };
    // getInputs() is a promise in the sandbox shell; onInput fires once initialised and on every change.
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
    tangram.provideState?.(() => ({ incidentId: canonicalId.current, status: statusRef.current }));
  }, [load]);

  function setStatus(status: "acknowledged" | "resolved") {
    if (!incident || pending[incident.id]) return;
    const id = incident.id;
    setPending((p) => ({ ...p, [id]: status }));
    setWriteError("");
    call<{ incident?: Incident }>("Incident", "Update", {
      parameters: { id },
      requestBody: { incident: { type: "incident_reference", status } },
    })
      .then((r) => {
        tangram.emit("updated", { incidentId: id, status: r?.incident?.status ?? status });
        if (canonicalId.current !== id) return;
        // Show the new state before the controls unlock, so a stale Acknowledge can't reopen a resolved incident.
        setIncident((prev) => (prev && prev.id === id ? { ...prev, ...(r?.incident ?? {}), status: r?.incident?.status ?? status } : prev));
        load(id, true);
      })
      .catch((e: unknown) => {
        if (canonicalId.current === id) setWriteError(errText(e));
      })
      .finally(() => done(id));
  }

  function done(id: string) {
    setPending((p) => {
      const { [id]: _, ...rest } = p;
      return rest;
    });
  }

  function addNote() {
    const content = noteText.trim();
    if (!incident || !content || pending[incident.id] || unverified.current?.id === incident.id) return;
    const id = incident.id;
    const statusAtWrite = incident.status ?? "";
    const since = Date.now();
    setPending((p) => ({ ...p, [id]: "note" }));
    setWriteError("");
    const saved = () => {
      tangram.emit("updated", { incidentId: id, status: statusAtWrite });
      if (canonicalId.current !== id) return;
      setNoteText((t) => (t.trim() === content ? "" : t));
      load(id, true);
    };
    const shown = (msg: string) => {
      if (canonicalId.current === id) setWriteError(msg);
    };
    call("Incident", "AddNote", { parameters: { id }, requestBody: { note: { content } } })
      .then(saved)
      .catch((e: unknown) => {
        if (definiteFailure(e)) return shown(errText(e));
        // The note may have landed (notes can't be deleted): look before offering a retry.
        return call<{ notes?: Note[] }>("Incident", "ListNotes", { parameters: { id } })
          .then((r) => {
            if (hasNote(r?.notes ?? [], content, since)) saved();
            else shown(`${errText(e)} — the note isn't on the incident; you can retry.`);
          })
          .catch(() => {
            unverified.current = { id, content, since };
            if (canonicalId.current === id) {
              setNoteCheck("Couldn't confirm whether the note was saved. Refresh to check before adding it again.");
            }
          });
      })
      .finally(() => done(id));
  }

  function loadOlder() {
    const id = canonicalId.current;
    if (!id || logs.loadingMore || !logs.more) return;
    const gen = generation.current;
    const mine = seq.current;
    setLogs((l) => ({ ...l, loadingMore: true }));
    call<{ log_entries?: LogEntry[]; more?: boolean }>("Incident", "ListLogEntries", {
      parameters: { id, is_overview: true, limit: LOG_PAGE, offset: logs.offset },
    })
      .then((r) => {
        if (gen !== generation.current || mine !== seq.current) return;
        const page = r?.log_entries ?? [];
        setLogs((l) => ({
          items: [...l.items, ...page.filter((e) => !l.items.some((x) => x.id === e.id))].sort(byTimeDesc),
          error: "",
          more: Boolean(r?.more),
          offset: l.offset + page.length,
          loadingMore: false,
        }));
      })
      .catch((e: unknown) => {
        if (gen !== generation.current || mine !== seq.current) return;
        setLogs((l) => ({ ...l, loadingMore: false, error: errText(e) }));
      });
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
  const writing: WriteKind | "" = pending[incident.id] ?? "";
  const busy = writing !== "";
  const noteBlocked = unverified.current?.id === incident.id;

  return (
    <div className="pd-root">
      <div className="pd-brandbar" />
      <div className="pd-pad">
        <div className="pd-head">
          <div className="main">
            <div className="pd-num">
              #{incident.incident_number ?? incident.id}
              {safeUrl(incident.html_url) ? (
                <>
                  {" · "}
                  <a
                    href={safeUrl(incident.html_url)}
                    rel="noopener noreferrer"
                    onClick={(e) => openExternal(e, incident.html_url)}
                  >
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
          {noteCheck && noteBlocked ? <div className="pd-faint" role="status">{noteCheck}</div> : null}
          <div className="pd-addnote">
            <Input.TextArea
              aria-label="New note"
              autoSize={{ minRows: 1, maxRows: 6 }}
              placeholder="Add a note — findings, mitigation, next steps"
              value={noteText}
              disabled={busy}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <Button
              type="primary"
              disabled={busy || noteBlocked || !noteText.trim()}
              loading={writing === "note"}
              onClick={addNote}
            >
              Add note
            </Button>
          </div>
        </section>

        <section className="pd-section" aria-label="Timeline">
          <h2 className="pd-h">Timeline</h2>
          <div className="pd-card">
            {logs.error && logs.items.length === 0 ? (
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
          {logs.items.length > 0 && logs.error ? <div className="pd-faint">Couldn't load older entries: {logs.error}</div> : null}
          {logs.more ? (
            <div style={{ marginTop: 8 }}>
              <Button size="small" loading={logs.loadingMore} onClick={loadOlder}>
                Load older
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function byTimeDesc(a: { created_at?: string }, b: { created_at?: string }): number {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

// A note with this text written since the attempt started (a minute of clock slack).
function hasNote(notes: Note[], content: string, since: number): boolean {
  return notes.some(
    (n) => (n.content ?? "").trim() === content && (!n.created_at || Date.parse(n.created_at) >= since - 60_000),
  );
}
