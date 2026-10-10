// Create-or-edit form over the connector's Event.Create / Event.Update
// actions. An agent prefills the fields via render inputs; the user edits
// before saving. Create is confirmation-gated by the host. When `eventId` is
// set the form patches that event instead of creating a new one. All-day end
// dates are inclusive in the form and converted to Google's exclusive
// `end.date` on save.
import {
  AlignLeftOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  EnvironmentOutlined,
  ExportOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, DatePicker, Select } from "antd";
import dayjs, { Dayjs } from "dayjs";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/google.css";
import "../../shared/tangram-buttons.css";
import { onNewInputs } from "../../shared/sandbox-inputs";

const tangram = (window as any).tangram;

const SEND_UPDATES = ["none", "all", "externalOnly"];

type SavedEvent = {
  id: string;
  htmlLink: string;
  meetLink: string;
  meetPending: boolean;
  meetFailed: boolean;
  summary: string;
  when: string;
  location: string;
  attendees: string[];
  updated: boolean;
};

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved"; event: SavedEvent }
  | { kind: "error"; message: string };

function parseDay(v: unknown): Dayjs | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = dayjs(s);
  return d.isValid() ? d : null;
}

function parseAttendees(s: string): { email: string }[] {
  return s
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.includes("@"))
    .map((email) => ({ email }));
}

function requestId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `tangram-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type ConferenceData = {
  entryPoints?: { entryPointType?: string; uri?: string }[];
  createRequest?: { status?: { statusCode?: string } };
};

// The Meet link surfaces as hangoutLink, or under conferenceData entryPoints;
// a createRequest can also come back still pending.
function meetLinkOf(ev: { hangoutLink?: string; conferenceData?: ConferenceData }): string {
  return (
    ev?.hangoutLink ??
    ev?.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ??
    ""
  );
}

export default function EventComposer() {
  const [calendarId, setCalendarId] = useState("primary");
  const [eventId, setEventId] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [start, setStart] = useState<Dayjs | null>(null);
  const [end, setEnd] = useState<Dayjs | null>(null);
  const [allDay, setAllDay] = useState(false);
  const [attendees, setAttendees] = useState("");
  const [sendUpdates, setSendUpdates] = useState("none");
  const [meet, setMeet] = useState(false);
  // PATCH distinguishes an omitted field (preserve the current value) from an
  // explicit empty value (clear it). Track which optional fields came from the
  // render inputs or were edited by the user so an event-list handoff, which
  // omits these details, cannot accidentally clear them.
  const explicitPatchFieldsRef = useRef(new Set<string>());
  // Meet link this instance already attached to the target event; once set,
  // saves stop sending createRequest (re-sending would replace the conference).
  const [meetLink, setMeetLink] = useState("");
  // Google ignores a createRequest that reuses a previous requestId — keep it
  // stable only while the outcome is unknown (network error), and regenerate
  // after any completed response so the next save is a real new request.
  const meetRequestIdRef = useRef(requestId());
  // Bumped when new inputs arrive; a save that started under an older generation
  // must not write its event id into the new form.
  const inputGenRef = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    // Token renewal replays `init` with the same inputs — dedup on a canonical
    // key so a renewal can't wipe the user's in-progress edits. A real input
    // change (agent re-render, e.g. a refined draft) applies the new fields.
    const canonical = (v: unknown): string =>
      Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : v !== null && typeof v === "object"
          ? `{${Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
              .join(",")}}`
          : (JSON.stringify(v) ?? "null");
    let lastApplied = "";
    const apply = (inputs: Record<string, unknown>) => {
      const key = canonical(inputs ?? {});
      if (key === lastApplied) return;
      lastApplied = key;
      inputGenRef.current += 1;
      explicitPatchFieldsRef.current = new Set(
        ["description", "location", "attendees"].filter((field) =>
          Object.prototype.hasOwnProperty.call(inputs ?? {}, field),
        ),
      );
      const startStr = String(inputs?.start ?? "").trim();
      setCalendarId(String(inputs?.calendarId ?? "") || "primary");
      setEventId(String(inputs?.eventId ?? ""));
      setSummary(String(inputs?.summary ?? ""));
      setDescription(String(inputs?.description ?? ""));
      setLocation(String(inputs?.location ?? ""));
      setStart(parseDay(startStr));
      setEnd(parseDay(inputs?.end));
      // A bare date input means all-day even when the flag isn't set.
      setAllDay(Boolean(inputs?.allDay) || /^\d{4}-\d{2}-\d{2}$/.test(startStr));
      setAttendees(String(inputs?.attendees ?? ""));
      const su = String(inputs?.sendUpdates ?? "");
      setSendUpdates(SEND_UPDATES.includes(su) ? su : "none");
      setMeet(Boolean(inputs?.meet));
      // New inputs may mean a new target event — start a fresh Meet request.
      setMeetLink("");
      meetRequestIdRef.current = requestId();
      setStatus({ kind: "idle" });
    };
    onNewInputs(apply);
  }, []);

  // Expose the draft to the agent (tangram_get_component_state) so "adjust my
  // event" can read the user's edits and refine them by re-rendering.
  const draftRef = useRef<Record<string, unknown>>({});
  draftRef.current = {
    calendarId,
    eventId,
    summary,
    description,
    location,
    start: start ? (allDay ? start.format("YYYY-MM-DD") : start.format()) : "",
    end: end ? (allDay ? end.format("YYYY-MM-DD") : end.format()) : "",
    allDay,
    attendees,
    sendUpdates,
    meet,
  };
  useEffect(() => {
    tangram.provideState?.(() => ({ ...draftRef.current }));
  }, []);

  const editing = eventId.trim() !== "";
  const disabled = status.kind === "busy";

  function save() {
    const gen = inputGenRef.current;
    if (!summary.trim()) {
      setStatus({ kind: "error", message: "Title is required." });
      return;
    }
    if (!start) {
      setStatus({ kind: "error", message: "Start time is required." });
      return;
    }
    if (!allDay && end && !end.isAfter(start)) {
      setStatus({ kind: "error", message: "End must be after start." });
      return;
    }
    const attendeeList = parseAttendees(attendees);
    const body: Record<string, unknown> = { summary: summary.trim() };
    if (description.trim() || (editing && explicitPatchFieldsRef.current.has("description")))
      body.description = description;
    if (location.trim() || (editing && explicitPatchFieldsRef.current.has("location")))
      body.location = location;
    if (attendeeList.length || (editing && explicitPatchFieldsRef.current.has("attendees")))
      body.attendees = attendeeList;
    if (allDay) {
      // Google's all-day end.date is exclusive; the form's end date is inclusive.
      const lastDay = end && end.isAfter(start, "day") ? end : start;
      body.start = { date: start.format("YYYY-MM-DD") };
      body.end = { date: lastDay.add(1, "day").format("YYYY-MM-DD") };
    } else {
      body.start = { dateTime: start.format() };
      body.end = { dateTime: (end ?? start.add(1, "hour")).format() };
    }
    setStatus({ kind: "busy" });
    const parameters: Record<string, unknown> = editing
      ? { calendarId, eventId, sendUpdates }
      : { calendarId, sendUpdates };
    if (meet && !(editing && meetLink)) {
      // A Meet link must be requested explicitly; the API ignores
      // conferenceData unless conferenceDataVersion=1. Once this instance has
      // attached a link to the event being edited, stop re-requesting.
      parameters.conferenceDataVersion = 1;
      body.conferenceData = {
        createRequest: {
          requestId: meetRequestIdRef.current,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }
    tangram
      .performAction(
        { resourceType: "Event", action: editing ? "Update" : "Create" },
        { parameters, requestBody: body },
      )
      .then((ev: { id?: string; htmlLink?: string; conferenceData?: ConferenceData }) => {
        const link = meetLinkOf(ev ?? {});
        const requestStatus = ev?.conferenceData?.createRequest?.status?.statusCode ?? "";
        // Inputs replaced the form mid-save: report the saved event, leave the new form alone.
        if (gen !== inputGenRef.current) {
          tangram.emit("saved", { id: ev?.id ?? "", htmlLink: ev?.htmlLink ?? "", calendarId, meetLink: link });
          return;
        }
        if (link) setMeetLink(link);
        // The outcome is known now, so a stale id has no retry left to guard;
        // a fresh one lets the next save (retry-after-failure or
        // create-another) issue a request Google won't ignore as a duplicate.
        meetRequestIdRef.current = requestId();
        // Later saves update the created event instead of duplicating it.
        if (!editing && ev?.id) setEventId(ev.id);
        setStatus({
          kind: "saved",
          event: {
            id: ev?.id ?? "",
            htmlLink: ev?.htmlLink ?? "",
            meetLink: link,
            meetPending: !link && requestStatus === "pending",
            meetFailed: !link && requestStatus === "failure",
            summary: summary.trim(),
            when: allDay
              ? `${start.format("ddd, MMM D")} (all day)`
              : `${start.format("ddd, MMM D HH:mm")} – ${(end ?? start.add(1, "hour")).format("HH:mm")}`,
            location,
            attendees: attendeeList.map((a) => a.email),
            updated: editing,
          },
        });
        tangram.emit("saved", {
          id: ev?.id ?? "",
          htmlLink: ev?.htmlLink ?? "",
          calendarId,
          meetLink: link,
        });
      })
      .catch((e: unknown) => {
        if (gen !== inputGenRef.current) return;
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }

  if (status.kind === "saved") {
    const ev = status.event;
    return (
      <div className="g-root g-pad">
        <div className="g-ok">{ev.updated ? "Event updated" : "Event created"}</div>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span className="g-dot" style={{ width: 14, height: 14, borderRadius: 4, background: "#039be5", marginTop: 7 }} />
          <div style={{ minWidth: 0 }}>
            <h2 className="g-title">{ev.summary}</h2>
            <div>{ev.when}</div>
            {ev.location ? (
              <div className="g-muted">
                <EnvironmentOutlined aria-hidden="true" /> {ev.location}
              </div>
            ) : null}
            {ev.attendees.length ? (
              <div className="g-muted">
                <TeamOutlined aria-hidden="true" /> With {ev.attendees.join(", ")}
              </div>
            ) : null}
            {ev.meetLink ? (
              <div style={{ marginTop: 4 }}>
                <VideoCameraOutlined aria-hidden="true" />{" "}
                <a href={ev.meetLink} target="_blank" rel="noreferrer">
                  {ev.meetLink}
                </a>
              </div>
            ) : ev.meetPending ? (
              <div className="g-muted" style={{ marginTop: 4 }}>
                <VideoCameraOutlined aria-hidden="true" /> Meet link is being generated — open the event to see it.
              </div>
            ) : null}
          </div>
        </div>
        {ev.meetFailed ? (
          <div className="g-warn" style={{ marginTop: 12 }}>
            The event was saved but the Meet link could not be created.
          </div>
        ) : null}
        <div className="g-bar" style={{ marginTop: 16 }}>
          <Button type="text" onClick={() => setStatus({ kind: "idle" })}>
            Back to form
          </Button>
          <span className="sp" />
          {ev.htmlLink ? (
            <Button icon={<ExportOutlined aria-hidden="true" />} href={ev.htmlLink} target="_blank" rel="noreferrer">
              Open in Google Calendar
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="g-root g-pad" style={{ paddingTop: 12 }}>
      {editing ? <div className="g-info">Editing event {eventId}</div> : null}
      <input
        className="g-titleinput"
        aria-label="Title"
        placeholder="Add title"
        value={summary}
        disabled={disabled}
        onChange={(e) => setSummary(e.target.value)}
      />
      <div className="g-field" style={{ flexWrap: "wrap" }}>
        <span className="ic" aria-hidden="true">
          <ClockCircleOutlined />
        </span>
        <DatePicker
          aria-label={allDay ? "Start date" : "Start"}
          placeholder={allDay ? "Start date" : "Start"}
          value={start}
          disabled={disabled}
          showTime={allDay ? undefined : { format: "HH:mm", minuteStep: 5 }}
          style={{ width: allDay ? 140 : 180 }}
          onChange={setStart}
        />
        <span className="g-muted">–</span>
        <DatePicker
          aria-label={allDay ? "End date (inclusive)" : "End"}
          placeholder={allDay ? "End date (inclusive)" : "End"}
          value={end}
          disabled={disabled}
          showTime={allDay ? undefined : { format: "HH:mm", minuteStep: 5 }}
          style={{ width: allDay ? 160 : 180 }}
          onChange={setEnd}
        />
        <Checkbox checked={allDay} disabled={disabled} onChange={(e) => setAllDay(e.target.checked)}>
          All day
        </Checkbox>
      </div>
      <div className="g-field">
        <span className="ic" aria-hidden="true">
          <VideoCameraOutlined />
        </span>
        {editing && meetLink ? (
          <a href={meetLink} target="_blank" rel="noreferrer">
            Meet link attached
          </a>
        ) : (
          <Checkbox checked={meet} disabled={disabled} onChange={(e) => setMeet(e.target.checked)}>
            Add Google Meet video conferencing
          </Checkbox>
        )}
      </div>
      <div className="g-field">
        <span className="ic" aria-hidden="true">
          <TeamOutlined />
        </span>
        <input
          aria-label="Attendees"
          value={attendees}
          disabled={disabled}
          placeholder="Add guests — alice@example.com, bob@example.com"
          onChange={(e) => {
            explicitPatchFieldsRef.current.add("attendees");
            setAttendees(e.target.value);
          }}
        />
      </div>
      <div className="g-field">
        <span className="ic" aria-hidden="true">
          <EnvironmentOutlined />
        </span>
        <input
          aria-label="Location"
          value={location}
          disabled={disabled}
          placeholder="Add location"
          onChange={(e) => {
            explicitPatchFieldsRef.current.add("location");
            setLocation(e.target.value);
          }}
        />
      </div>
      <div className="g-field">
        <span className="ic" aria-hidden="true">
          <AlignLeftOutlined />
        </span>
        <textarea
          aria-label="Description"
          value={description}
          disabled={disabled}
          rows={3}
          placeholder="Add description"
          onChange={(e) => {
            explicitPatchFieldsRef.current.add("description");
            setDescription(e.target.value);
          }}
        />
      </div>
      <div className="g-bar" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <span className="g-faint">
          <CalendarOutlined aria-hidden="true" /> {calendarId}
        </span>
        <span className="sp" />
        <Select
          value={sendUpdates}
          disabled={disabled}
          style={{ minWidth: 180 }}
          onChange={setSendUpdates}
          options={[
            { value: "none", label: "Don't email attendees" },
            { value: "all", label: "Email all attendees" },
            { value: "externalOnly", label: "Email external only" },
          ]}
        />
        <Button type="primary" onClick={save} disabled={disabled} loading={status.kind === "busy"}>
          {editing ? "Save changes" : "Create event"}
        </Button>
      </div>
      {status.kind === "error" ? <div className="g-error inline">{status.message}</div> : null}
    </div>
  );
}
