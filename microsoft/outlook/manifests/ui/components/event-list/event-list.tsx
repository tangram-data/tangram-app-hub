// Agenda view over the connector's Event.List / Calendar.List actions. An
// agent scopes it via render inputs (calendar, time window, search text); the
// user can switch calendars, search, and reload. Rows expand in place — the
// calendarView response already carries the event fields — and emit a
// `select` output for wiring to the event-composer.
//
// Graph datetime quirk: start/end dateTime strings carry NO UTC offset (e.g.
// 2026-07-10T14:00:00) — the sibling timeZone field names the zone. UTC times
// (what calendarView returns without Prefer: outlook.timezone) are parsed as
// UTC and shown in the viewer's local time; other zones render as wall clock.
import {
  EnvironmentOutlined,
  LinkOutlined,
  ReloadOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Button, Input, Select, Spin } from "antd";
import dayjs from "dayjs";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/microsoft.css";
import "../../shared/tangram-buttons.css";
import { onNewInputs } from "../../shared/sandbox-inputs";

const tangram = (window as any).tangram;

type EventTime = { dateTime?: string; timeZone?: string };
type Attendee = {
  emailAddress?: { address?: string; name?: string };
  type?: string;
  status?: { response?: string };
};
type CalEvent = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: EventTime;
  end?: EventTime;
  isAllDay?: boolean;
  location?: { displayName?: string };
  attendees?: Attendee[];
  onlineMeeting?: { joinUrl?: string };
  webLink?: string;
  seriesMasterId?: string;
};
type Calendar = { id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean };

// Search criteria as applied from inputs or user edits; a change reloads.
// calendarId "" means "the account's default calendar once the list arrives"
// — Graph has no "primary" alias, calendarView needs a real id.
type Criteria = {
  calendarId: string;
  q: string;
  startDateTime: string;
  endDateTime: string;
  top: number;
};

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

// Wall-clock pieces read straight off Graph's offset-less dateTime string.
function wallDate(t?: EventTime): string {
  return (t?.dateTime ?? "").slice(0, 10);
}
function isUtc(t?: EventTime): boolean {
  return !t?.timeZone || /^(utc|etc\/utc|gmt)$/i.test(t.timeZone);
}
// A UTC dateTime as a real instant (Z appended when missing); null otherwise.
function utcInstant(t?: EventTime): ReturnType<typeof dayjs> | null {
  const raw = (t?.dateTime ?? "").replace(/(\.\d{3})\d+/, "$1");
  if (!raw || !isUtc(t)) return null;
  const d = dayjs(/(Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`);
  return d.isValid() ? d : null;
}
function wallTime(t?: EventTime): string {
  const local = utcInstant(t);
  if (local) return local.format("HH:mm");
  return (t?.dateTime ?? "").match(/T(\d{2}:\d{2})/)?.[1] ?? "";
}
// Day the event is listed under: local date for UTC times, else wall date.
function listDate(ev: CalEvent): string {
  const local = ev.isAllDay ? null : utcInstant(ev.start);
  return local ? local.format("YYYY-MM-DD") : wallDate(ev.start);
}
function timeLabel(ev: CalEvent): string {
  if (ev.isAllDay) return "All day";
  const s = wallTime(ev.start);
  const e = wallTime(ev.end);
  return e ? `${s} – ${e}` : s;
}

// Attendee response dot: accepted green, declined red, tentative amber.
const RESPONSE_COLORS: Record<string, string> = {
  accepted: "#107c10",
  organizer: "#107c10",
  declined: "#c4314b",
  tentativelyAccepted: "#d67f00",
};
const RESPONSE_LABELS: Record<string, string> = {
  accepted: "Accepted",
  organizer: "Organizer",
  declined: "Declined",
  tentativelyAccepted: "Tentative",
};

// Deterministic soft persona tint (background, initials color) per name.
const PERSONA_TINTS: [string, string][] = [
  ["#e9d7f4", "#5c2e91"], ["#d6e8fa", "#0f548c"], ["#dff6dd", "#0e700e"], ["#fde7e9", "#a4262c"],
  ["#fff4ce", "#835b00"], ["#fed9cc", "#8a3707"], ["#cdedf4", "#00666d"], ["#f7e3f5", "#8b1d7f"],
];
function personaTint(key: string): { background: string; color: string } {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const [background, color] = PERSONA_TINTS[h % PERSONA_TINTS.length];
  return { background, color };
}
function initials(name: string): string {
  const words = name.split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return ((words[0][0] ?? "") + last).toUpperCase();
}

export default function EventList() {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [calendarsFailed, setCalendarsFailed] = useState(false);
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [search, setSearch] = useState("");
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [expanded, setExpanded] = useState("");

  useEffect(() => {
    // Token renewal replays `init` with the same inputs — dedup on a canonical
    // key so a renewal can't reset the user's calendar/search state.
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
      const q = String(inputs?.q ?? "");
      setSearch(q);
      // calendarView requires both window bounds — default to today + 30 days.
      const startDateTime =
        String(inputs?.startDateTime ?? "") || dayjs().startOf("day").toISOString();
      const endDateTime =
        String(inputs?.endDateTime ?? "") || dayjs(startDateTime).add(30, "day").toISOString();
      setCriteria({
        calendarId: String(inputs?.calendarId ?? ""),
        q,
        startDateTime,
        endDateTime,
        top: Number(inputs?.top) > 0 ? Math.floor(Number(inputs?.top)) : 50,
      });
    };
    onNewInputs(apply);
    tangram
      .performAction({ resourceType: "Calendar", action: "List" }, { parameters: { "$top": 100 } })
      .then((r: { value?: Calendar[] }) => setCalendars(r?.value ?? []))
      .catch(() => setCalendarsFailed(true)); // fatal only when no calendarId input
  }, []);

  const defaultCalendarId = calendars.find((c) => c.isDefaultCalendar)?.id ?? calendars[0]?.id ?? "";

  // Guards stale responses after rapid criteria changes.
  const loadSeq = useRef(0);
  function load(c: Criteria, calendarId: string) {
    const seq = ++loadSeq.current;
    setStatus({ kind: "loading" });
    tangram
      .performAction({ resourceType: "Event", action: "List" }, {
        parameters: {
          calendarId,
          startDateTime: c.startDateTime,
          endDateTime: c.endDateTime,
          "$orderby": "start/dateTime",
          "$top": c.top,
          // OData single quotes escape by doubling.
          "$filter": c.q ? `contains(subject,'${c.q.replace(/'/g, "''")}')` : undefined,
        },
      })
      .then((r: { value?: CalEvent[]; "@odata.nextLink"?: string }) => {
        if (seq !== loadSeq.current) return;
        setEvents(r?.value ?? []);
        // @odata.nextLink is a full opaque URL we can't replay through the
        // binding — "Load more" instead reloads with a doubled page size.
        setHasMore(Boolean(r?.["@odata.nextLink"]));
        setStatus({ kind: "idle" });
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }

  useEffect(() => {
    if (!criteria) return;
    setExpanded("");
    setEvents([]);
    setHasMore(false);
    const calendarId = criteria.calendarId || defaultCalendarId;
    if (!calendarId) return; // waiting for the calendar list (or it failed)
    load(criteria, calendarId);
  }, [criteria, defaultCalendarId]);

  function select(ev: CalEvent) {
    setExpanded((cur) => (cur === ev.id ? "" : ev.id));
    // Graph's all-day end is the EXCLUSIVE next midnight; emit the inclusive
    // last day so the composer (whose all-day end field is inclusive)
    // round-trips cleanly.
    const end = ev.isAllDay
      ? wallDate(ev.end)
        ? dayjs(wallDate(ev.end)).subtract(1, "day").format("YYYY-MM-DD")
        : ""
      : (ev.end?.dateTime ?? "");
    tangram.emit("select", {
      calendarId: criteria?.calendarId || defaultCalendarId,
      eventId: ev.id,
      subject: ev.subject ?? "",
      start: ev.isAllDay ? wallDate(ev.start) : (ev.start?.dateTime ?? ""),
      end,
      // Graph returns calendarView times in UTC wall clock (no Prefer:
      // outlook.timezone is sent). Emit the zone so an editor round-trips
      // the same instant instead of re-labeling the wall clock as local.
      timeZone: ev.isAllDay ? "" : (ev.start?.timeZone ?? "UTC"),
    });
  }

  const loading = status.kind === "loading";
  const waitingForCalendars = Boolean(criteria) && !criteria?.calendarId && !defaultCalendarId;
  const byDay = new Map<string, CalEvent[]>();
  events.forEach((ev) => {
    const key = listDate(ev) || "unknown";
    byDay.set(key, [...(byDay.get(key) ?? []), ev]);
  });

  return (
    <div className="m-root" style={{ paddingBottom: 12 }}>
      <div className="m-bar wrap" style={{ padding: "14px 20px 4px" }}>
        <Select
          style={{ flex: "1 1 160px", minWidth: 0 }}
          value={(criteria?.calendarId || defaultCalendarId) || undefined}
          placeholder="Calendar"
          disabled={loading}
          options={calendars.map((c) => ({
            value: c.id,
            label: c.isDefaultCalendar ? `${c.name ?? c.id} (default)` : (c.name ?? c.id),
          }))}
          onChange={(id) => criteria && setCriteria({ ...criteria, calendarId: id })}
        />
        <Input.Search
          style={{ flex: "2 1 180px", minWidth: 0 }}
          placeholder="Search subjects"
          value={search}
          disabled={loading}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(q) => criteria && setCriteria({ ...criteria, q })}
        />
        <Button
          type="text"
          aria-label="Reload"
          icon={<ReloadOutlined aria-hidden="true" />}
          disabled={loading || !criteria}
          onClick={() =>
            criteria && (criteria.calendarId || defaultCalendarId) &&
            load(criteria, criteria.calendarId || defaultCalendarId)
          }
        />
      </div>
      <div className="m-faint" style={{ padding: "0 20px 4px", fontSize: 11 }}>
        UTC times shown in your local time; others in the event's own time zone
      </div>
      {status.kind === "error" ? (
        <div className="m-error" role="alert">
          {status.message}
        </div>
      ) : null}
      {calendarsFailed && waitingForCalendars ? (
        <div className="m-error" role="alert">
          Could not load the calendar list; pass a calendarId input.
        </div>
      ) : null}
      {(loading || (waitingForCalendars && !calendarsFailed)) && events.length === 0 ? (
        <Spin style={{ display: "block", margin: "24px auto" }} />
      ) : null}
      {!loading && !waitingForCalendars && events.length === 0 && status.kind !== "error" ? (
        <div className="m-empty">No events in this window</div>
      ) : null}
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <div key={day}>
          <div className="m-daylabel">
            {dayjs(day).isValid() ? dayjs(day).format("dddd, MMM D") : day}
          </div>
          {dayEvents.map((ev) => (
            <div key={ev.id}>
              <div
                className={`m-evrow${expanded === ev.id ? " sel" : ""}`}
                role="button"
                tabIndex={0}
                aria-expanded={expanded === ev.id}
                onClick={() => select(ev)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select(ev);
                  }
                }}
              >
                <span className="m-evbar" />
                <span className="t">{timeLabel(ev)}</span>
                <div className="ti">
                  <b>{ev.subject || "(no subject)"}</b>
                  <div className="m-evmeta">
                    {!ev.isAllDay && ev.start?.timeZone && !isUtc(ev.start) ? (
                      <span>{ev.start.timeZone}</span>
                    ) : null}
                    {ev.seriesMasterId ? <span>Recurring</span> : null}
                    {ev.location?.displayName ? (
                      <span>
                        <EnvironmentOutlined aria-hidden="true" /> {ev.location.displayName}
                      </span>
                    ) : null}
                    {ev.attendees?.length ? (
                      <span>
                        <TeamOutlined aria-hidden="true" /> {ev.attendees.length}
                      </span>
                    ) : null}
                    {ev.onlineMeeting?.joinUrl ? (
                      <span style={{ color: "#0f6cbd" }}>
                        <VideoCameraOutlined aria-hidden="true" /> Teams
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              {expanded === ev.id ? (
                <div className="m-evdetail" onClick={(e) => e.stopPropagation()}>
                  {ev.bodyPreview ? (
                    <div className="m-pre" style={{ fontSize: 13, maxHeight: 200, overflow: "auto", marginBottom: 6 }}>
                      {ev.bodyPreview}
                    </div>
                  ) : null}
                  {ev.attendees?.length ? (
                    <div className="m-chips">
                      {ev.attendees.map((a, i) => {
                        const label = a.emailAddress?.name || a.emailAddress?.address || "";
                        const response = a.status?.response ?? "";
                        return (
                          <span
                            key={`${a.emailAddress?.address}-${i}`}
                            className="m-chip"
                            title={RESPONSE_LABELS[response] ?? "No response"}
                          >
                            <span className="m-persona sm" style={personaTint(a.emailAddress?.address || label)} aria-hidden="true">
                              {initials(label)}
                            </span>
                            {label}
                            {RESPONSE_COLORS[response] ? (
                              <span className="m-dot" style={{ background: RESPONSE_COLORS[response] }} aria-hidden="true" />
                            ) : null}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="m-bar" style={{ gap: 16 }}>
                    {ev.webLink ? (
                      <a className="m-link" href={ev.webLink} target="_blank" rel="noreferrer">
                        <LinkOutlined aria-hidden="true" /> Open in Outlook
                      </a>
                    ) : null}
                    {ev.onlineMeeting?.joinUrl ? (
                      <a className="m-link" href={ev.onlineMeeting.joinUrl} target="_blank" rel="noreferrer">
                        <VideoCameraOutlined aria-hidden="true" /> Join Teams meeting
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {hasMore ? (
        <div style={{ padding: "8px 20px" }}>
          <Button
            size="small"
            loading={loading}
            onClick={() => criteria && setCriteria({ ...criteria, top: criteria.top * 2 })}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
