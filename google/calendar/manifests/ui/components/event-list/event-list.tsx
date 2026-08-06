// Agenda view over the connector's Event.List / Calendar.List actions. An
// agent scopes it via render inputs (calendar, time window, search text); the
// user can switch calendars, search, and page. Rows expand in place — the
// list response already carries full event resources — and emit a `select`
// output for wiring to the event-composer.
import {
  EnvironmentOutlined,
  LinkOutlined,
  ReloadOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Select, Space, Spin, Tag, Typography } from "antd";
import dayjs, { Dayjs } from "dayjs";
import React, { useEffect, useRef, useState } from "react";

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
  accepted: "green",
  declined: "red",
  tentative: "orange",
  needsAction: "default",
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
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
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
          value={criteria?.calendarId ?? "primary"}
          disabled={loading}
          options={(calendars.length ? calendars : [{ id: "primary", summary: "Primary" }]).map(
            (c) => ({ value: c.id, label: c.primary ? `${c.summary ?? c.id} (primary)` : (c.summary ?? c.id) }),
          )}
          onChange={(id) => criteria && setCriteria({ ...criteria, calendarId: id })}
        />
        <Input.Search
          placeholder="Search events"
          value={search}
          disabled={loading}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(q) => criteria && setCriteria({ ...criteria, q })}
        />
        <Button
          icon={<ReloadOutlined />}
          disabled={loading || !criteria}
          onClick={() => criteria && load(criteria, "")}
        />
      </Space.Compact>
      {LOCAL_TZ ? (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 8 }}>
          Times shown in {LOCAL_TZ}
        </Typography.Text>
      ) : null}
      {status.kind === "error" ? (
        <Alert type="error" showIcon message={status.message} style={{ marginBottom: 12 }} />
      ) : null}
      {loading && events.length === 0 ? (
        <Spin style={{ display: "block", margin: "24px auto" }} />
      ) : null}
      {!loading && events.length === 0 && status.kind !== "error" ? (
        <Empty description="No events in this window" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : null}
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <div key={day} style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "8px 0 4px" }}>
            {dayjs(day).format("dddd, MMM D")}
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
                <Typography.Text strong>{ev.summary || "(no title)"}</Typography.Text>
                {eventTzLabel(ev, listTz) ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {eventTzLabel(ev, listTz)}
                  </Typography.Text>
                ) : null}
                {ev.recurringEventId ? <Tag color="blue">recurring</Tag> : null}
                {ev.location ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <EnvironmentOutlined /> {ev.location}
                  </Typography.Text>
                ) : null}
                {ev.attendees?.length ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <TeamOutlined /> {ev.attendees.length}
                  </Typography.Text>
                ) : null}
              </Space>
              {expanded === ev.id ? (
                <div style={{ marginTop: 8, marginLeft: 4 }} onClick={(e) => e.stopPropagation()}>
                  {ev.description ? (
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
                      {ev.description}
                    </div>
                  ) : null}
                  {ev.attendees?.length ? (
                    <Space size={4} wrap style={{ marginBottom: 6 }}>
                      {ev.attendees.map((a, i) => (
                        <Tag key={`${a.email}-${i}`} color={RESPONSE_COLORS[a.responseStatus ?? ""] ?? "default"}>
                          {a.displayName || a.email}
                        </Tag>
                      ))}
                    </Space>
                  ) : null}
                  <Space size={12}>
                    {ev.htmlLink ? (
                      <Typography.Link href={ev.htmlLink} target="_blank" rel="noreferrer">
                        <LinkOutlined /> Open in Google Calendar
                      </Typography.Link>
                    ) : null}
                    {ev.hangoutLink ? (
                      <Typography.Link href={ev.hangoutLink} target="_blank" rel="noreferrer">
                        Meet link
                      </Typography.Link>
                    ) : null}
                  </Space>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {nextToken ? (
        <Button size="small" loading={loading} onClick={() => criteria && load(criteria, nextToken)}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
