// PagerDuty REST v2-shaped fixtures for the incident-viewer and oncall-board previews. All names are fictional.
import { Args, missing, UpstreamError } from "../mock-tangram";

export const previews = [
  {
    component: "incident-viewer",
    title: "Incident — triggered, high urgency (opened by number), timeline paging + notes",
    inputs: { incidentId: "1042" },
    height: 760,
  },
  {
    component: "incident-viewer",
    title: "Incident — resolved",
    inputs: { incidentId: "Q2RESOLVED07" },
    height: 620,
  },
  {
    component: "oncall-board",
    title: "On-call board — two escalation policies, open incidents",
    inputs: {},
    height: 640,
  },
  {
    component: "incident-viewer",
    title: "Incident — not found (error state)",
    inputs: { incidentId: "PNOSUCH" },
    height: 260,
  },
];

const BASE = "https://acme-demo.pagerduty.com";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

const user = (id: string, summary: string) => ({
  id,
  type: "user_reference",
  summary,
  self: `https://api.pagerduty.com/users/${id}`,
  html_url: `${BASE}/users/${id}`,
});
const USERS = {
  maya: user("PUSR001", "Maya Lindqvist"),
  ravi: user("PUSR002", "Ravi Okafor"),
  jun: user("PUSR003", "Jun Tanaka"),
  elena: user("PUSR004", "Elena Duarte"),
  sam: user("PUSR005", "Sam Whitford"),
  noor: user("PUSR006", "Noor Haddad"),
};
const service = (id: string, summary: string) => ({
  id,
  type: "service_reference",
  summary,
  self: `https://api.pagerduty.com/services/${id}`,
  html_url: `${BASE}/service-directory/${id}`,
});
const policy = (id: string, summary: string) => ({
  id,
  type: "escalation_policy_reference",
  summary,
  self: `https://api.pagerduty.com/escalation_policies/${id}`,
  html_url: `${BASE}/escalation_policies/${id}`,
});
const CHECKOUT = service("PSVC01", "Checkout API");
const SEARCH = service("PSVC02", "Search Indexer");
const PAYMENTS_EP = policy("PEP001", "Payments Primary");
const PLATFORM_EP = policy("PEP002", "Platform On-Call");

const incident = (
  id: string,
  number: number,
  title: string,
  status: string,
  urgency: string,
  createdMin: number,
  svc: ReturnType<typeof service>,
  ep: ReturnType<typeof policy>,
  assignees: (typeof USERS)[keyof typeof USERS][],
) => ({
  id,
  type: "incident",
  incident_number: number,
  title,
  description: title,
  status,
  urgency,
  created_at: ago(createdMin),
  updated_at: ago(Math.max(1, createdMin - 5)),
  html_url: `${BASE}/incidents/${id}`,
  self: `https://api.pagerduty.com/incidents/${id}`,
  service: svc,
  escalation_policy: ep,
  priority: urgency === "high" ? { id: "PPRI1", type: "priority", summary: "P1" } : null,
  assignments: assignees.map((a) => ({ at: ago(createdMin), assignee: a })),
  incident_key: `${id.toLowerCase()}-key`,
});

const INCIDENTS = [
  incident("Q1TRIGGERED42", 1042, "Checkout API p99 latency above 2s in eu-west-1", "triggered", "high", 38, CHECKOUT, PAYMENTS_EP, [
    USERS.maya,
  ]),
  incident("Q3ACKED11", 1039, "Search indexer lag > 15 min on shard 4", "acknowledged", "low", 190, SEARCH, PLATFORM_EP, [
    USERS.jun,
  ]),
  incident("Q4TRIG55", 1043, "Payment webhook delivery failures (5xx from provider)", "triggered", "high", 6, CHECKOUT, PAYMENTS_EP, [
    USERS.maya,
    USERS.ravi,
  ]),
  incident("Q2RESOLVED07", 1031, "Disk usage 92% on db-replica-2", "resolved", "low", 60 * 26, SEARCH, PLATFORM_EP, [USERS.jun]),
];

function findIncident(idOrNumber: string) {
  return INCIDENTS.find((i) => i.id === idOrNumber || String(i.incident_number) === idOrNumber);
}

// Overview timeline; the triggered incident has more than one page (limit 50) so "Load older" shows.
function logEntries(id: string) {
  const inc = INCIDENTS.find((i) => i.id === id)!;
  const entry = (n: number, type: string, min: number, summary: string, agent = USERS.maya) => ({
    id: `${id}-LOG${String(n).padStart(3, "0")}`,
    type,
    summary,
    created_at: ago(min),
    agent: type.startsWith("trigger") ? { id: "PINTEG1", type: "events_api_v2_inbound_integration_reference", summary: "Datadog" } : agent,
    channel: { type: type.startsWith("trigger") ? "api" : "web_trigger" },
    incident: { id, type: "incident_reference", summary: inc.title },
  });
  if (id === "Q2RESOLVED07") {
    return [
      entry(1, "trigger_log_entry", 60 * 26, "Triggered through the API."),
      entry(2, "notify_log_entry", 60 * 26 - 1, "Notified Jun Tanaka by push notification.", USERS.jun),
      entry(3, "acknowledge_log_entry", 60 * 26 - 4, "Acknowledged by Jun Tanaka.", USERS.jun),
      entry(4, "annotate_log_entry", 60 * 25, "Note added by Jun Tanaka.", USERS.jun),
      entry(5, "resolve_log_entry", 60 * 24, "Resolved by Jun Tanaka.", USERS.jun),
    ];
  }
  const out = [
    entry(1, "trigger_log_entry", inc ? 38 : 0, "Triggered through the API."),
    entry(2, "assign_log_entry", 38, "Assigned to Maya Lindqvist.", USERS.maya),
  ];
  // Repeated notification attempts across channels make the timeline long (58 entries).
  for (let n = 3; n <= 56; n++) {
    const ch = ["push notification", "SMS", "phone call", "email"][n % 4];
    out.push(entry(n, "notify_log_entry", 37 - n * 0.5, `Notified Maya Lindqvist by ${ch}.`));
  }
  out.push(entry(57, "escalate_log_entry", 9, "Escalated to level 2: Ravi Okafor.", USERS.ravi));
  out.push(entry(58, "annotate_log_entry", 4, "Note added by Ravi Okafor.", USERS.ravi));
  return out.reverse(); // newest first, like PagerDuty's overview
}

function notes(id: string) {
  if (id === "Q1TRIGGERED42") {
    return [
      {
        id: "PNOTE01",
        user: USERS.maya,
        channel: { summary: "The PagerDuty website or APIs" },
        content: "Latency spike lines up with the 14:05 deploy of checkout-svc v2.31. Rolling back on one AZ first.",
        created_at: ago(20),
      },
      {
        id: "PNOTE02",
        user: USERS.ravi,
        channel: { summary: "The PagerDuty website or APIs" },
        content: "Rollback on eu-west-1a done — p99 back to 640ms there. Proceeding with 1b/1c.",
        created_at: ago(4),
      },
    ];
  }
  if (id === "Q2RESOLVED07") {
    return [
      {
        id: "PNOTE09",
        user: USERS.jun,
        channel: { summary: "The PagerDuty website or APIs" },
        content: "Rotated old WAL segments; usage down to 61%. Follow-up ticket filed for retention settings.",
        created_at: ago(60 * 25),
      },
    ];
  }
  return [];
}

function oncalls() {
  const oc = (ep: ReturnType<typeof policy>, level: number, u: (typeof USERS)[keyof typeof USERS], schedule: string | null, endMin: number | null) => ({
    escalation_policy: ep,
    escalation_level: level,
    schedule: schedule ? { id: `PSCH-${schedule.replace(/\W/g, "")}`, type: "schedule_reference", summary: schedule } : null,
    user: u,
    start: schedule ? ago(60 * 10) : null,
    end: endMin === null ? null : ahead(endMin),
  });
  return [
    oc(PAYMENTS_EP, 1, USERS.maya, "Payments Primary Rotation", 60 * 5 + 20),
    oc(PAYMENTS_EP, 2, USERS.ravi, "Payments Secondary Rotation", 60 * 29),
    oc(PAYMENTS_EP, 3, USERS.elena, null, null),
    oc(PLATFORM_EP, 1, USERS.jun, "Platform Weekly", 60 * 24 * 3),
    oc(PLATFORM_EP, 1, USERS.noor, "Platform Follow-the-sun", 60 * 2),
    oc(PLATFORM_EP, 2, USERS.sam, "Platform Managers", 60 * 24 * 6),
  ];
}

function param(args: Args, name: string): unknown {
  return args.parameters?.[name];
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const key = `${resourceType}.${action}`;
  const id = String(param(args, "id") ?? "");
  switch (key) {
    case "Incident.Get": {
      const inc = findIncident(id);
      if (!inc) throw new UpstreamError(404, { error: { message: "Incident Not Found", code: 2100 } });
      return { incident: inc };
    }
    case "Incident.ListLogEntries": {
      if (!INCIDENTS.some((i) => i.id === id)) throw new UpstreamError(404, { error: { message: "Not Found", code: 2100 } });
      const all = logEntries(id);
      const limit = Number(param(args, "limit") ?? 25);
      const offset = Number(param(args, "offset") ?? 0);
      return {
        log_entries: all.slice(offset, offset + limit),
        limit,
        offset,
        more: offset + limit < all.length,
        total: null,
      };
    }
    case "Incident.ListNotes":
      return { notes: notes(id) };
    case "Incident.Update": {
      const inc = findIncident(id);
      if (!inc) throw new UpstreamError(404, { error: { message: "Incident Not Found", code: 2100 } });
      const body = args.requestBody as { incident?: { status?: string } } | undefined;
      return { incident: { ...inc, status: body?.incident?.status ?? inc.status, updated_at: new Date().toISOString() } };
    }
    case "Incident.AddNote": {
      const body = args.requestBody as { note?: { content?: string } } | undefined;
      return {
        note: {
          id: "PNOTE99",
          user: USERS.maya,
          channel: { summary: "The PagerDuty website or APIs" },
          content: body?.note?.content ?? "",
          created_at: new Date().toISOString(),
        },
      };
    }
    case "Incident.List": {
      const statuses = (param(args, "statuses[]") as string[] | undefined) ?? [];
      const list = INCIDENTS.filter((i) => !statuses.length || statuses.includes(i.status)).sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
      const limit = Number(param(args, "limit") ?? 25);
      return { incidents: list.slice(0, limit), limit, offset: 0, more: list.length > limit, total: null };
    }
    case "OnCall.List":
      return { oncalls: oncalls(), limit: Number(param(args, "limit") ?? 25), offset: 0, more: false, total: null };
    default:
      return missing(resourceType, action);
  }
}
