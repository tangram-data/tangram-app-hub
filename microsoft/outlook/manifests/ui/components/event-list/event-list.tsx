// Agenda view over the connector's Event.List / Calendar.List actions. An
// agent scopes it via render inputs (calendar, time window, search text); the
// user can switch calendars, search, and reload. Rows expand in place — the
// calendarView response already carries the event fields — and emit a
// `select` output for wiring to the event-composer.
//
// Graph datetime quirk: start/end dateTime strings carry NO UTC offset (e.g.
// 2026-07-10T14:00:00) — the sibling timeZone field names the zone. Times are
// rendered as wall-clock strings read straight off the dateTime; parsing them
// through dayjs would misread them as viewer-local instants.
import {
  EnvironmentOutlined,
  LinkOutlined,
  ReloadOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Select, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import React, { useEffect, useRef, useState } from "react";

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
function wallTime(t?: EventTime): string {
  return (t?.dateTime ?? "").match(/T(\d{2}:\d{2})/)?.[1] ?? "";
}
function timeLabel(ev: CalEvent): string {
  if (ev.isAllDay) return "All day";
  const s = wallTime(ev.start);
  const e = wallTime(ev.end);
  return e ? `${s} – ${e}` : s;
}

const RESPONSE_COLORS: Record<string, string> = {
  accepted: "green",
  organizer: "green",
  declined: "red",
  tentativelyAccepted: "orange",
};

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
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
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
    const key = wallDate(ev.start) || "unknown";
    byDay.set(key, [...(byDay.get(key) ?? []), ev]);
  });

  return (
    <div
      style={{
        padding: 16,
        maxWidth: 720,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <Space.Compact style={{ display: "flex", marginBottom: 12 }}>
        <Select
          style={{ minWidth: 180 }}
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
          placeholder="Search subjects"
          value={search}
          disabled={loading}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(q) => criteria && setCriteria({ ...criteria, q })}
        />
        <Button
          icon={<ReloadOutlined />}
          disabled={loading || !criteria}
          onClick={() =>
            criteria && (criteria.calendarId || defaultCalendarId) &&
            load(criteria, criteria.calendarId || defaultCalendarId)
          }
        />
      </Space.Compact>
      <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 8 }}>
        Times shown in each event's own time zone
      </Typography.Text>
      {status.kind === "error" ? (
        <Alert type="error" showIcon message={status.message} style={{ marginBottom: 12 }} />
      ) : null}
      {calendarsFailed && waitingForCalendars ? (
        <Alert
          type="error"
          showIcon
          message="Could not load the calendar list; pass a calendarId input."
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {(loading || (waitingForCalendars && !calendarsFailed)) && events.length === 0 ? (
        <Spin style={{ display: "block", margin: "24px auto" }} />
      ) : null}
      {!loading && !waitingForCalendars && events.length === 0 && status.kind !== "error" ? (
        <Empty description="No events in this window" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : null}
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <div key={day} style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "8px 0 4px" }}>
            {dayjs(day).isValid() ? dayjs(day).format("dddd, MMM D") : day}
          </Typography.Text>
          {dayEvents.map((ev) => (
            <div
              key={ev.id}
              onClick={() => select(ev)}
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                cursor: "pointer",
                background: expanded === ev.id ? "rgba(22,119,255,0.06)" : undefined,
                border: "1px solid #f0f0f0",
                marginBottom: 4,
              }}
            >
              <Space size={8} style={{ width: "100%" }}>
                <Tag style={{ minWidth: 90, textAlign: "center" }}>{timeLabel(ev)}</Tag>
                <Typography.Text strong>{ev.subject || "(no subject)"}</Typography.Text>
                {!ev.isAllDay && ev.start?.timeZone ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {ev.start.timeZone}
                  </Typography.Text>
                ) : null}
                {ev.seriesMasterId ? <Tag color="blue">recurring</Tag> : null}
                {ev.location?.displayName ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <EnvironmentOutlined /> {ev.location.displayName}
                  </Typography.Text>
                ) : null}
                {ev.attendees?.length ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <TeamOutlined /> {ev.attendees.length}
                  </Typography.Text>
                ) : null}
                {ev.onlineMeeting?.joinUrl ? <VideoCameraOutlined /> : null}
              </Space>
              {expanded === ev.id ? (
                <div style={{ marginTop: 8, marginLeft: 4 }} onClick={(e) => e.stopPropagation()}>
                  {ev.bodyPreview ? (
                    <div
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: 13,
                        lineHeight: 1.5,
                        marginBottom: 6,
                        maxHeight: 200,
                        overflow: "auto",
                      }}
                    >
                      {ev.bodyPreview}
                    </div>
                  ) : null}
                  {ev.attendees?.length ? (
                    <Space size={4} wrap style={{ marginBottom: 6 }}>
                      {ev.attendees.map((a, i) => (
                        <Tag
                          key={`${a.emailAddress?.address}-${i}`}
                          color={RESPONSE_COLORS[a.status?.response ?? ""] ?? "default"}
                        >
                          {a.emailAddress?.name || a.emailAddress?.address}
                        </Tag>
                      ))}
                    </Space>
                  ) : null}
                  <Space size={12}>
                    {ev.webLink ? (
                      <Typography.Link href={ev.webLink} target="_blank" rel="noreferrer">
                        <LinkOutlined /> Open in Outlook
                      </Typography.Link>
                    ) : null}
                    {ev.onlineMeeting?.joinUrl ? (
                      <Typography.Link href={ev.onlineMeeting.joinUrl} target="_blank" rel="noreferrer">
                        <VideoCameraOutlined /> Join Teams meeting
                      </Typography.Link>
                    ) : null}
                  </Space>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {hasMore ? (
        <Button
          size="small"
          loading={loading}
          onClick={() => criteria && setCriteria({ ...criteria, top: criteria.top * 2 })}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
