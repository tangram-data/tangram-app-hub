// The incident viewer's writes and their reconciliation, kept per incident id
// (the input may change while a write is in flight):
//   - status updates: the returned incident wins over any snapshot fetched before it landed; an uncertain failure
//     (timeout, 5xx, no answer) re-reads the incident and keeps the status buttons locked until that read succeeds;
//   - notes: a definite failure offers a retry; an uncertain one stays uncertain until the note shows up, or the
//     user explicitly chooses to add it again (notes can't be deleted, so a silent retry could duplicate it).
import { useRef, useState } from "react";
import { call, definiteFailure, errText, Ref, tangram } from "../../shared/pd";

export type Incident = {
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
export type Note = { id: string; content?: string; created_at?: string; user?: Ref | null };
export type WriteKind = "acknowledged" | "resolved" | "note";
// "checking": re-reading after an uncertain update; "failed": that read failed too (Refresh retries it).
export type StatusCheck = "checking" | "failed";
// "unchecked": the notes couldn't be read; "not-visible": read, and the note isn't there (yet).
export type NoteDoubt = { content: string; since: number; state: "unchecked" | "not-visible" };

type Hooks = {
  // canonical id of the incident on screen ("" while a new input loads)
  shownId: () => string;
  reload: (id: string) => void;
  showIncident: (id: string, patch: Partial<Incident>) => void;
  clearDraft: (content: string) => void;
};

// A note with this text written since the attempt started (a minute of clock slack).
export function hasNote(notes: Note[], content: string, since: number): boolean {
  return notes.some(
    (n) => (n.content ?? "").trim() === content && (!n.created_at || Date.parse(n.created_at) >= since - 60_000),
  );
}

function without<T>(m: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _, ...rest } = m;
  return rest;
}

export function useIncidentWrites(h: Hooks) {
  const [pending, setPending] = useState<Record<string, WriteKind>>({});
  const [statusCheck, setStatusCheck] = useState<Record<string, StatusCheck>>({});
  const [noteDoubt, setNoteDoubt] = useState<Record<string, NoteDoubt>>({});
  const [writeError, setWriteError] = useState("");
  const doubtRef = useRef(noteDoubt);
  doubtRef.current = noteDoubt;
  const checkRef = useRef(statusCheck);
  checkRef.current = statusCheck;
  const written = useRef(new Map<string, { incident: Partial<Incident>; at: number }>());

  const done = (id: string) => setPending((p) => without(p, id));
  const showError = (id: string, msg: string) => {
    if (h.shownId() === id) setWriteError(msg);
  };

  // Record a fresh status for an incident: shown now if on screen, preferred by any older in-flight load.
  function settleStatus(id: string, patch: Partial<Incident>) {
    written.current.set(id, { incident: patch, at: Date.now() });
    if (h.shownId() !== id) return;
    h.showIncident(id, patch);
    h.reload(id);
  }

  function setStatus(incident: Incident, status: "acknowledged" | "resolved") {
    const id = incident.id;
    if (pending[id] || statusCheck[id]) return;
    setPending((p) => ({ ...p, [id]: status }));
    setWriteError("");
    call<{ incident?: Incident }>("Incident", "Update", {
      parameters: { id },
      requestBody: { incident: { type: "incident_reference", status } },
    })
      .then((r) => {
        const result = { ...(r?.incident ?? {}), status: r?.incident?.status ?? status };
        tangram.emit("updated", { incidentId: id, status: result.status });
        settleStatus(id, result);
      })
      .catch((e: unknown) => {
        if (definiteFailure(e)) return showError(id, errText(e));
        // The update may have landed: lock the status buttons until a read says what the status is.
        setStatusCheck((c) => ({ ...c, [id]: "checking" }));
        return call<{ incident?: Incident }>("Incident", "Get", { parameters: { id } })
          .then((r) => {
            const now = r?.incident;
            if (!now) throw new Error("Incident not found.");
            setStatusCheck((c) => without(c, id));
            if (now.status === status) tangram.emit("updated", { incidentId: id, status });
            else showError(id, `${errText(e)} — the status didn't change; you can retry.`);
            settleStatus(id, now);
          })
          .catch(() => setStatusCheck((c) => ({ ...c, [id]: "failed" })));
      })
      .finally(() => done(id));
  }

  function addNote(incident: Incident, content: string, anyway = false) {
    const id = incident.id;
    if (!content || pending[id] || (doubtRef.current[id] && !anyway)) return;
    const statusAtWrite = incident.status ?? "";
    const since = Date.now();
    if (anyway) setNoteDoubt((d) => without(d, id));
    setPending((p) => ({ ...p, [id]: "note" }));
    setWriteError("");
    const saved = () => {
      setNoteDoubt((d) => without(d, id));
      tangram.emit("updated", { incidentId: id, status: statusAtWrite });
      if (h.shownId() !== id) return;
      h.clearDraft(content);
      h.reload(id);
    };
    call("Incident", "AddNote", { parameters: { id }, requestBody: { note: { content } } })
      .then(saved)
      .catch((e: unknown) => {
        if (definiteFailure(e)) return showError(id, errText(e));
        // It may have landed, or still land: stay uncertain until it shows up or the user adds it again.
        return call<{ notes?: Note[] }>("Incident", "ListNotes", { parameters: { id } })
          .then((r) => {
            if (hasNote(r?.notes ?? [], content, since)) saved();
            else setNoteDoubt((d) => ({ ...d, [id]: { content, since, state: "not-visible" } }));
          })
          .catch(() => setNoteDoubt((d) => ({ ...d, [id]: { content, since, state: "unchecked" } })));
      })
      .finally(() => done(id));
  }

  /**
   * Called with every fresh load of an incident: returns the incident to show (a newer write result wins) and
   * whether to refetch; settles a failed status check and uncertain notes that have now appeared.
   */
  function onLoaded(incident: Incident, notes: Note[] | null, startedAt: number): { show: Incident; refetch: boolean } {
    const id = incident.id;
    const w = written.current.get(id);
    const newer = w !== undefined && w.at >= startedAt;
    if (w && !newer) written.current.delete(id);
    if (checkRef.current[id] === "failed") setStatusCheck((c) => without(c, id));
    const doubt = doubtRef.current[id];
    if (doubt && notes) {
      if (hasNote(notes, doubt.content, doubt.since)) {
        setNoteDoubt((d) => without(d, id));
        h.clearDraft(doubt.content);
      } else if (doubt.state === "unchecked") {
        setNoteDoubt((d) => ({ ...d, [id]: { ...doubt, state: "not-visible" } }));
      }
    }
    return { show: newer ? { ...incident, ...w.incident } : incident, refetch: newer };
  }

  return { pending, statusCheck, noteDoubt, writeError, setWriteError, setStatus, addNote, onLoaded };
}
