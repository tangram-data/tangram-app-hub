// Create-or-edit form over the connector's Event.Create / Event.Update
// actions. An agent prefills the fields via render inputs; the user edits
// before saving. Create is confirmation-gated at the action level. When
// `eventId` is set the form patches that event instead of creating one.
// All-day end dates are inclusive in the form and converted to Graph's
// exclusive next-midnight end (+ isAllDay=true) on save. Times are sent as
// Graph {dateTime, timeZone} pairs — offset-less wall clock in the viewer's
// IANA zone.
import { VideoCameraOutlined } from "@ant-design/icons";
import { Alert, Button, DatePicker, Input, Space, Switch, Typography } from "antd";
import dayjs, { Dayjs } from "dayjs";
import React, { useEffect, useRef, useState } from "react";

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
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
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

  const label = (text: string) => (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "10px 0 4px" }}>
      {text}
    </Typography.Text>
  );

  const rootStyle = {
    padding: 16,
    maxWidth: 720,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  };

  if (status.kind === "saved") {
    const ev = status.event;
    return (
      <div style={rootStyle}>
        <Alert
          type="success"
          showIcon
          message={ev.updated ? "Event updated" : "Event created"}
          style={{ marginBottom: 12 }}
        />
        <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
          {ev.subject}
        </Typography.Title>
        <Typography.Text style={{ display: "block" }}>{ev.when}</Typography.Text>
        {ev.location ? (
          <Typography.Text type="secondary" style={{ display: "block" }}>
            {ev.location}
          </Typography.Text>
        ) : null}
        {ev.attendees.length ? (
          <Typography.Text type="secondary" style={{ display: "block" }}>
            With {ev.attendees.join(", ")}
          </Typography.Text>
        ) : null}
        {ev.joinUrl ? (
          <Typography.Text style={{ display: "block", marginTop: 4 }}>
            <VideoCameraOutlined />{" "}
            <Typography.Link href={ev.joinUrl} target="_blank" rel="noreferrer">
              {ev.joinUrl}
            </Typography.Link>
          </Typography.Text>
        ) : ev.teamsMissing ? (
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 4 }}>
            <VideoCameraOutlined /> Teams meeting was requested but no join link came back — open
            the event in Outlook to check.
          </Typography.Text>
        ) : null}
        <Space style={{ marginTop: 12 }}>
          {ev.webLink ? (
            <Typography.Link href={ev.webLink} target="_blank" rel="noreferrer">
              Open in Outlook
            </Typography.Link>
          ) : null}
          <Button size="small" onClick={() => setStatus({ kind: "idle" })}>
            Back to form
          </Button>
        </Space>
      </div>
    );
  }

  return (
    <div style={rootStyle}>
      {editing ? (
        <Alert type="info" showIcon message={`Editing event ${eventId}`} style={{ marginBottom: 4 }} />
      ) : null}
      {label("Title")}
      <Input value={subject} disabled={disabled} onChange={(e) => setSubject(e.target.value)} />
      <Space size={16} style={{ marginTop: 10 }} align="center">
        <Space size={6}>
          <Switch size="small" checked={allDay} disabled={disabled} onChange={setAllDay} />
          <Typography.Text style={{ fontSize: 13 }}>All day</Typography.Text>
        </Space>
        {!editing ? (
          <Space size={6}>
            <Switch size="small" checked={teams} disabled={disabled} onChange={setTeams} />
            <Typography.Text style={{ fontSize: 13 }}>
              <VideoCameraOutlined /> Teams meeting
            </Typography.Text>
          </Space>
        ) : null}
      </Space>
      {label(allDay ? "Start date" : `Start (${timeZone || LOCAL_TZ})`)}
      <DatePicker
        value={start}
        disabled={disabled}
        showTime={allDay ? undefined : { format: "HH:mm", minuteStep: 5 }}
        style={{ width: 220 }}
        onChange={setStart}
      />
      {label(allDay ? "End date (inclusive)" : `End (${timeZone || LOCAL_TZ})`)}
      <DatePicker
        value={end}
        disabled={disabled}
        showTime={allDay ? undefined : { format: "HH:mm", minuteStep: 5 }}
        style={{ width: 220 }}
        onChange={setEnd}
      />
      {label("Attendees")}
      <Input
        value={attendees}
        disabled={disabled}
        placeholder="alice@contoso.com, bob@contoso.com"
        onChange={(e) => setAttendees(e.target.value)}
      />
      {label("Location")}
      <Input value={location} disabled={disabled} onChange={(e) => setLocation(e.target.value)} />
      {label("Description")}
      <Input.TextArea
        value={bodyText}
        disabled={disabled}
        autoSize={{ minRows: 3, maxRows: 12 }}
        onChange={(e) => setBodyText(e.target.value)}
      />
      <Space style={{ marginTop: 14 }}>
        <Button type="primary" onClick={save} disabled={disabled} loading={status.kind === "busy"}>
          {editing ? "Save changes" : "Create event"}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {editing ? `event ${eventId}` : calendarId ? `on calendar ${calendarId}` : "no calendar selected"}
        </Typography.Text>
      </Space>
      {status.kind === "error" ? (
        <Alert type="error" showIcon message={status.message} style={{ marginTop: 12 }} />
      ) : null}
    </div>
  );
}
