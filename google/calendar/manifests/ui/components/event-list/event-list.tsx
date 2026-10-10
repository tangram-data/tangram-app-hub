// Agenda view over the connector's Event.List / Calendar.List actions. An
// agent scopes it via render inputs (calendar, time window, search text); the
// user can switch calendars, search, and page. Rows expand in place — the
// list response already carries full event resources — and emit a `select`
// output for wiring to the event-composer.
import {
  EnvironmentOutlined,
  ExportOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Button, Select, Spin } from "antd";
import dayjs, { Dayjs } from "dayjs";
import React, { useEffect, useRef, useState } from "react";
import "../../shared/google.css";
import "../../shared/tangram-buttons.css";
import { onNewInputs } from "../../shared/sandbox-inputs";

const tangram = (window as any).tangram;

type EventTime = { date?: string; dateTime?: string; timeZone?: string };
type Attendee = { email?: string; displayName?: string; responseStatus?: string };
type CalEvent = {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: Attendee[];
  recurringEventId?: string;
  hangoutLink?: string;
  colorId?: string;
};
type Calendar = { id: string; summary?: string; primary?: boolean };

// Search criteria as applied from inputs or user edits; a change reloads page 1.
type Criteria = {
  calendarId: string;
  q: string;
  timeMin: string;
  timeMax: string;
  maxResults: number;
};

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

function startOf(ev: CalEvent): Dayjs {
  return dayjs(ev.start?.dateTime ?? ev.start?.date ?? 0);
}

function timeLabel(ev: CalEvent): string {
  if (ev.start?.date) return "All day";
  const s = dayjs(ev.start?.dateTime);
  const e = ev.end?.dateTime ? dayjs(ev.end.dateTime) : null;
  return e ? `${s.format("HH:mm")} – ${e.format("HH:mm")}` : s.format("HH:mm");
}

const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
})();

function offsetMinutes(dateTime: string): number | null {
  const m = dateTime.match(/(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) return null;
  if (m[1] === "Z") return 0;
  const digits = m[1].replace(":", "");
  return (digits[0] === "-" ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3)));
}

// Google's dateTime strings carry the event-zone offset, so the wall-clock
// time in the event's own timezone can be read straight off the string.
function wallClock(t?: EventTime): string {
  return (t?.dateTime ?? "").match(/T(\d{2}:\d{2})/)?.[1] ?? "";
}

// "14:00 – 15:00 Europe/Paris" when the event's timezone differs from the
// viewer's (times in the row are viewer-local); empty otherwise. `listTz` is
// the calendar's timezone from the list response, the fallback when the
// event doesn't carry its own.
function eventTzLabel(ev: CalEvent, listTz: string): string {
  const dt = ev.start?.dateTime;
  if (!dt) return "";
  const off = offsetMinutes(dt);
  if (off === null || off === dayjs(dt).utcOffset()) return "";
  const name = ev.start?.timeZone || listTz || `UTC${dt.match(/(Z|[+-]\d{2}:?\d{2})$/)?.[1] ?? ""}`;
  const end = wallClock(ev.end);
  return `${wallClock(ev.start)}${end ? ` – ${end}` : ""} ${name}`;
}

const RESPONSE_COLORS: Record<string, string> = {
  accepted: "#188038",
  declined: "#d93025",
  tentative: "#e37400",
  needsAction: "#9aa0a6",
};

// Google Calendar's event colorId palette.
const EVENT_COLORS: Record<string, string> = {
  "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73", "5": "#f6bf26", "6": "#f4511e",
  "7": "#039be5", "8": "#616161", "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
};

export default function EventList() {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [search, setSearch] = useState("");
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [listTz, setListTz] = useState("");
  const [nextToken, setNextToken] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [expanded, setExpanded] = useState("");

  useEffect(() => {
    // Token renewal replays `init` with the same inputs — dedup on a canonical
    // key so a renewal can't reset the user's calendar/search/paging state.
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
      setCriteria({
        calendarId: String(inputs?.calendarId ?? "") || "primary",
        q,
        timeMin: String(inputs?.timeMin ?? "") || dayjs().startOf("day").toISOString(),
        timeMax: String(inputs?.timeMax ?? ""),
        maxResults: Number(inputs?.maxResults) > 0 ? Math.floor(Number(inputs?.maxResults)) : 50,
      });
    };
    onNewInputs(apply);
    tangram
      .performAction({ resourceType: "Calendar", action: "List" }, { parameters: { maxResults: 250 } })
      .then((r: { items?: Calendar[] }) => setCalendars(r?.items ?? []))
      .catch(() => setCalendars([])); // picker is optional sugar; the list still works
  }, []);

  // Guards stale page-1 responses after rapid criteria changes, and blocks
  // Load-more double-fires while a page is in flight.
  const loadSeq = useRef(0);
  function load(c: Criteria, pageToken: string) {
    const seq = ++loadSeq.current;
    setStatus({ kind: "loading" });
    tangram
      .performAction({ resourceType: "Event", action: "List" }, {
        parameters: {
          calendarId: c.calendarId,
          q: c.q || undefined,
          timeMin: c.timeMin || undefined,
          timeMax: c.timeMax || undefined,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: c.maxResults,
          pageToken: pageToken || undefined,
        },
      })
      .then((r: { items?: CalEvent[]; nextPageToken?: string; timeZone?: string }) => {
        if (seq !== loadSeq.current) return;
        const items = (r?.items ?? []).filter((e) => e.status !== "cancelled");
        setEvents((prev) => (pageToken ? [...prev, ...items] : items));
        setListTz(r?.timeZone ?? "");
        setNextToken(r?.nextPageToken ?? "");
        setStatus({ kind: "idle" });
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }

  useEffect(() => {
    if (!criteria) return;
    // Drop the previous query's results and page token up front so a failed
    // reload can't leave "Load more" pointing at a stale cursor.
    setExpanded("");
    setEvents([]);
    setNextToken("");
    load(criteria, "");
  }, [criteria]);

  function select(ev: CalEvent) {
    setExpanded((cur) => (cur === ev.id ? "" : ev.id));
    // Google's all-day end.date is exclusive; emit the inclusive last day so
    // the composer (whose all-day end field is inclusive) round-trips cleanly.
    const end = ev.end?.dateTime
      ? ev.end.dateTime
      : ev.end?.date
        ? dayjs(ev.end.date).subtract(1, "day").format("YYYY-MM-DD")
        : "";
    tangram.emit("select", {
      calendarId: criteria?.calendarId ?? "primary",
      eventId: ev.id,
      summary: ev.summary ?? "",
      start: ev.start?.dateTime ?? ev.start?.date ?? "",
      end,
    });
  }

  const loading = status.kind === "loading";
  const byDay = new Map<string, CalEvent[]>();
  events.forEach((ev) => {
    const key = startOf(ev).format("YYYY-MM-DD");
    byDay.set(key, [...(byDay.get(key) ?? []), ev]);
  });
  const today = dayjs().format("YYYY-MM-DD");

  return (
    <div className="g-root">
      <div className="g-toolbar">
        <Select
          variant="borderless"
          style={{ minWidth: 150, maxWidth: 220 }}
          value={criteria?.calendarId ?? "primary"}
          disabled={loading}
          options={(calendars.length ? calendars : [{ id: "primary", summary: "Primary" }]).map(
            (c) => ({ value: c.id, label: c.primary ? `${c.summary ?? c.id} (primary)` : (c.summary ?? c.id) }),
          )}
          onChange={(id) => criteria && setCriteria({ ...criteria, calendarId: id })}
        />
        <form
          className="g-search sm"
          style={{ flex: 1, minWidth: 160 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (criteria) setCriteria({ ...criteria, q: search });
          }}
        >
          <SearchOutlined aria-hidden="true" />
          <input
            aria-label="Search events"
            placeholder="Search events"
            value={search}
            disabled={loading}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <Button
          type="text"
          shape="circle"
          aria-label="Refresh"
          icon={<ReloadOutlined aria-hidden="true" />}
          disabled={loading || !criteria}
          onClick={() => criteria && load(criteria, "")}
        />
      </div>
      {LOCAL_TZ ? (
        <div className="g-faint" style={{ padding: "0 16px 4px" }}>
          Times shown in {LOCAL_TZ}
        </div>
      ) : null}
      {status.kind === "error" ? <div className="g-error">{status.message}</div> : null}
      {(loading || !criteria) && events.length === 0 ? <Spin style={{ display: "block", margin: "24px auto" }} /> : null}
      {!loading && criteria && events.length === 0 && status.kind !== "error" ? (
        <div className="g-empty">No events in this window</div>
      ) : null}
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <div key={day} className="g-day">
          <div className={`g-daylabel${day === today ? " today" : ""}`} title={dayjs(day).format("dddd, MMM D, YYYY")}>
            <div className="dow">{dayjs(day).format("ddd").toUpperCase()}</div>
            <div className="dn">{dayjs(day).format("D")}</div>
            {dayjs(day).year() !== dayjs().year() || dayjs(day).month() !== dayjs().month() ? (
              <div className="g-faint">{dayjs(day).format("MMM")}</div>
            ) : null}
          </div>
          <div style={{ minWidth: 0 }}>
            {dayEvents.map((ev) => {
              const tz = eventTzLabel(ev, listTz);
              return (
                <React.Fragment key={ev.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded === ev.id}
                    className={`g-ev${expanded === ev.id ? " sel" : ""}`}
                    onClick={() => select(ev)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        select(ev);
                      }
                    }}
                  >
                    <span className="g-dot" style={{ background: EVENT_COLORS[ev.colorId ?? ""] ?? "#039be5" }} />
                    <span className="t">{timeLabel(ev)}</span>
                    <span className="ti">
                      {ev.summary || "(no title)"}
                      {ev.location ? <span className="loc"> · {ev.location}</span> : null}
                      {tz ? <span className="loc"> · {tz}</span> : null}
                      {ev.recurringEventId ? (
                        <span className="loc">
                          {" "}
                          <SyncOutlined aria-label="Recurring" />
                        </span>
                      ) : null}
                      {ev.attendees?.length ? (
                        <span className="loc">
                          {" "}
                          · <TeamOutlined aria-hidden="true" /> {ev.attendees.length}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {expanded === ev.id ? (
                    <div className="g-evdetail">
                      <div className="full">
                        <b>{ev.summary || "(no title)"}</b>
                        <div>
                          {timeLabel(ev)}
                          {tz ? ` · ${tz}` : ""}
                          {ev.recurringEventId ? " · Recurring" : ""}
                        </div>
                        {ev.location ? (
                          <div>
                            <EnvironmentOutlined aria-hidden="true" /> {ev.location}
                          </div>
                        ) : null}
                      </div>
                      {ev.description ? <div className="desc">{ev.description}</div> : null}
                      {ev.attendees?.length ? (
                        <div style={{ marginBottom: 6 }}>
                          {ev.attendees.map((a, i) => (
                            <span key={`${a.email}-${i}`} className="g-person" title={a.responseStatus ?? ""}>
                              <span
                                className="g-dot"
                                style={{ width: 8, height: 8, background: RESPONSE_COLORS[a.responseStatus ?? ""] ?? "#9aa0a6" }}
                              />
                              {a.displayName || a.email}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="g-bar" style={{ flexWrap: "wrap" }}>
                        {ev.hangoutLink ? (
                          <Button size="small" icon={<VideoCameraOutlined aria-hidden="true" />} href={ev.hangoutLink} target="_blank" rel="noreferrer">
                            Join Meet
                          </Button>
                        ) : null}
                        {ev.htmlLink ? (
                          <Button size="small" icon={<ExportOutlined aria-hidden="true" />} href={ev.htmlLink} target="_blank" rel="noreferrer">
                            Open in Google Calendar
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      ))}
      {nextToken ? (
        <div className="g-toolbar">
          <Button size="small" loading={loading} onClick={() => criteria && load(criteria, nextToken)}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
