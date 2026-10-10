// Create-or-edit form over the connector's Event.Create / Event.Update
// actions. An agent prefills the fields via render inputs; the user edits
// before saving. Create is confirmation-gated at the action level. When
// `eventId` is set the form patches that event instead of creating one.
// All-day end dates are inclusive in the form and converted to Graph's
// exclusive next-midnight end (+ isAllDay=true) on save. Times are sent as
// Graph {dateTime, timeZone} pairs — offset-less wall clock in the viewer's
// IANA zone.
import { CheckCircleFilled, VideoCameraOutlined } from "@ant-design/icons";
import { Button, DatePicker, Input, Switch } from "antd";
import dayjs, { Dayjs } from "dayjs";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/microsoft.css";
import "../../shared/tangram-buttons.css";
import { onNewInputs } from "../../shared/sandbox-inputs";

const tangram = (window as any).tangram;

const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

type SavedEvent = {
  id: string;
  webLink: string;
  joinUrl: string;
  teamsMissing: boolean;
  subject: string;
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

// Graph attendee shape: emailAddress wrapper + required/optional type.
function parseAttendees(s: string): { emailAddress: { address: string }; type: string }[] {
  return s
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.includes("@"))
    .map((address) => ({ emailAddress: { address }, type: "required" }));
}

export default function EventComposer() {
  const [calendarId, setCalendarId] = useState("");
  const [eventId, setEventId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [location, setLocation] = useState("");
  const [start, setStart] = useState<Dayjs | null>(null);
  const [end, setEnd] = useState<Dayjs | null>(null);
  const [allDay, setAllDay] = useState(false);
  const [attendees, setAttendees] = useState("");
  const [teams, setTeams] = useState(false);
  // Zone the start/end wall clocks are in. event-list's select emits UTC
  // (calendarView returns UTC wall clocks); relabeling them as viewer-local
  // would shift the instant on every edit.
  const [timeZone, setTimeZone] = useState("");
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
      const startStr = String(inputs?.start ?? "").trim();
      setCalendarId(String(inputs?.calendarId ?? ""));
      setEventId(String(inputs?.eventId ?? ""));
      setSubject(String(inputs?.subject ?? ""));
      setBodyText(String(inputs?.body ?? ""));
      setLocation(String(inputs?.location ?? ""));
      setStart(parseDay(startStr));
      setEnd(parseDay(inputs?.end));
      // A bare date input means all-day even when the flag isn't set.
      setAllDay(Boolean(inputs?.allDay) || /^\d{4}-\d{2}-\d{2}$/.test(startStr));
      setAttendees(String(inputs?.attendees ?? ""));
      setTeams(Boolean(inputs?.teams));
      setTimeZone(String(inputs?.timeZone ?? "").trim());
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
    subject,
    body: bodyText,
    location,
    start: start ? (allDay ? start.format("YYYY-MM-DD") : start.format("YYYY-MM-DDTHH:mm:ss")) : "",
    end: end ? (allDay ? end.format("YYYY-MM-DD") : end.format("YYYY-MM-DDTHH:mm:ss")) : "",
    allDay,
    attendees,
    teams,
    timeZone,
  };
  useEffect(() => {
    tangram.provideState?.(() => ({ ...draftRef.current }));
  }, []);

  const editing = eventId.trim() !== "";
  const disabled = status.kind === "busy";

  function save() {
    if (!subject.trim()) {
      setStatus({ kind: "error", message: "Title is required." });
      return;
    }
    if (!start) {
      setStatus({ kind: "error", message: "Start time is required." });
      return;
    }
    if (!editing && !calendarId.trim()) {
      // Graph has no "primary" alias — create needs a real calendar id.
      setStatus({
        kind: "error",
        message: "No calendar selected — pass a calendarId input (from event-list or Calendar.List).",
      });
      return;
    }
    if (!allDay && end && !end.isAfter(start)) {
      setStatus({ kind: "error", message: "End must be after start." });
      return;
    }
    const attendeeList = parseAttendees(attendees);
    const body: Record<string, unknown> = { subject: subject.trim() };
    if (bodyText.trim()) body.body = { contentType: "text", content: bodyText };
    if (location.trim()) body.location = { displayName: location };
    if (attendeeList.length) body.attendees = attendeeList;
    const tz = timeZone || LOCAL_TZ;
    if (allDay) {
      // Graph's all-day end is the exclusive next midnight; the form's end
      // date is inclusive.
      const lastDay = end && end.isAfter(start, "day") ? end : start;
      body.isAllDay = true;
      body.start = { dateTime: `${start.format("YYYY-MM-DD")}T00:00:00`, timeZone: tz };
      body.end = {
        dateTime: `${lastDay.add(1, "day").format("YYYY-MM-DD")}T00:00:00`,
        timeZone: tz,
      };
    } else {
      body.start = { dateTime: start.format("YYYY-MM-DDTHH:mm:ss"), timeZone: tz };
      body.end = {
        dateTime: (end ?? start.add(1, "hour")).format("YYYY-MM-DDTHH:mm:ss"),
        timeZone: tz,
      };
    }
    // PATCH must state isAllDay explicitly — unchecking "All day" on an
    // all-day event would otherwise send timed start/end while isAllDay
    // stays true upstream, which Graph rejects.
    if (editing) body.isAllDay = allDay;
    // Teams meetings are create-only: Graph attaches onlineMeeting.joinUrl at
    // create, but flipping isOnlineMeeting on an existing event via PATCH is
    // unreliable — accepted gap, so edit mode never sends the meeting fields.
    if (!editing && teams) {
      body.isOnlineMeeting = true;
      body.onlineMeetingProvider = "teamsForBusiness";
    }
    setStatus({ kind: "busy" });
    tangram
      .performAction({ resourceType: "Event", action: editing ? "Update" : "Create" }, {
        parameters: editing ? { eventId } : { calendarId },
        requestBody: body,
      })
      .then((ev: { id?: string; webLink?: string; onlineMeeting?: { joinUrl?: string } }) => {
        const joinUrl = ev?.onlineMeeting?.joinUrl ?? "";
        setStatus({
          kind: "saved",
          event: {
            id: ev?.id ?? "",
            webLink: ev?.webLink ?? "",
            joinUrl,
            teamsMissing: !editing && teams && !joinUrl,
            subject: subject.trim(),
            when: allDay
              ? `${start.format("ddd, MMM D")} (all day)`
              : `${start.format("ddd, MMM D HH:mm")} – ${(end ?? start.add(1, "hour")).format("HH:mm")}`,
            location,
            attendees: attendeeList.map((a) => a.emailAddress.address),
            updated: editing,
          },
        });
        tangram.emit("saved", { id: ev?.id ?? "", webLink: ev?.webLink ?? "", joinUrl });
      })
      .catch((e: unknown) =>
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }

  if (status.kind === "saved") {
    const ev = status.event;
    return (
      <div className="m-root m-pad">
        <div className="m-ok" role="status">
          <CheckCircleFilled aria-hidden="true" /> {ev.updated ? "Event updated" : "Event created"}
        </div>
        <div className="m-evrow wrap" style={{ padding: "0 0 4px", cursor: "default", gridTemplateColumns: "4px 1fr" }}>
          <span className="m-evbar" />
          <div className="ti">
            <b>{ev.subject}</b>
            <div className="m-muted" style={{ fontSize: 13 }}>{ev.when}</div>
          </div>
        </div>
        <dl className="m-meta">
          {ev.location ? (
            <>
              <dt>Location</dt>
              <dd>{ev.location}</dd>
            </>
          ) : null}
          {ev.attendees.length ? (
            <>
              <dt>With</dt>
              <dd>{ev.attendees.join(", ")}</dd>
            </>
          ) : null}
          {ev.joinUrl ? (
            <>
              <dt>Teams</dt>
              <dd>
                <a className="m-link" href={ev.joinUrl} target="_blank" rel="noreferrer">
                  {ev.joinUrl}
                </a>
              </dd>
            </>
          ) : null}
        </dl>
        {!ev.joinUrl && ev.teamsMissing ? (
          <div className="m-note warn">
            <VideoCameraOutlined aria-hidden="true" /> Teams meeting was requested but no join link came
            back — open the event in Outlook to check.
          </div>
        ) : null}
        <div className="m-bar foot">
          {ev.webLink ? (
            <a className="m-link" href={ev.webLink} target="_blank" rel="noreferrer">
              Open in Outlook
            </a>
          ) : null}
          <span className="sp" />
          <Button onClick={() => setStatus({ kind: "idle" })}>Back to form</Button>
        </div>
      </div>
    );
  }

  const tzLabel = timeZone || LOCAL_TZ;
  return (
    <div className="m-root">
      <div className="m-form wide" style={{ maxWidth: 720 }}>
        {editing ? <div className="m-note">Editing event {eventId}</div> : null}
        <div className="m-field">
          <Input
            aria-label="Title"
            variant="borderless"
            placeholder="Add a title"
            value={subject}
            disabled={disabled}
            style={{ fontSize: 16, fontWeight: 600 }}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="m-toggles">
          <label>
            <Switch size="small" checked={allDay} disabled={disabled} onChange={setAllDay} />
            All day
          </label>
          {!editing ? (
            <label>
              <Switch size="small" checked={teams} disabled={disabled} onChange={setTeams} />
              <VideoCameraOutlined aria-hidden="true" style={{ color: "#0f6cbd" }} /> Teams meeting
            </label>
          ) : null}
        </div>
        <div className="m-field">
          <label>{allDay ? "Start date" : "Start"}</label>
          <DatePicker
            aria-label={allDay ? "Start date" : `Start (${tzLabel})`}
            variant="borderless"
            value={start}
            disabled={disabled}
            showTime={allDay ? undefined : { format: "HH:mm", minuteStep: 5 }}
            style={{ flex: "0 1 220px" }}
            onChange={setStart}
          />
          {!allDay ? <span className="m-faint">{tzLabel}</span> : null}
        </div>
        <div className="m-field">
          <label>{allDay ? "End date" : "End"}</label>
          <DatePicker
            aria-label={allDay ? "End date (inclusive)" : `End (${tzLabel})`}
            variant="borderless"
            value={end}
            disabled={disabled}
            showTime={allDay ? undefined : { format: "HH:mm", minuteStep: 5 }}
            style={{ flex: "0 1 220px" }}
            onChange={setEnd}
          />
          <span className="m-faint">{allDay ? "inclusive" : tzLabel}</span>
        </div>
        <div className="m-field">
          <label htmlFor="ec-attendees">Attendees</label>
          <Input
            id="ec-attendees"
            variant="borderless"
            value={attendees}
            disabled={disabled}
            placeholder="alice@contoso.com, bob@contoso.com"
            onChange={(e) => setAttendees(e.target.value)}
          />
        </div>
        <div className="m-field">
          <label htmlFor="ec-location">Location</label>
          <Input
            id="ec-location"
            variant="borderless"
            value={location}
            disabled={disabled}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
        <div className="m-field body">
          <Input.TextArea
            aria-label="Description"
            variant="borderless"
            placeholder="Add a description"
            value={bodyText}
            disabled={disabled}
            autoSize={{ minRows: 3, maxRows: 12 }}
            onChange={(e) => setBodyText(e.target.value)}
          />
        </div>
        {status.kind === "error" ? (
          <div className="m-error inline" role="alert">
            {status.message}
          </div>
        ) : null}
        <div className="m-bar foot">
          <span className="m-faint" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {editing ? `event ${eventId}` : calendarId ? `on calendar ${calendarId}` : "no calendar selected"}
          </span>
          <span className="sp" />
          <Button type="primary" onClick={save} disabled={disabled} loading={status.kind === "busy"}>
            {editing ? "Save changes" : "Create event"}
          </Button>
        </div>
      </div>
    </div>
  );
}
