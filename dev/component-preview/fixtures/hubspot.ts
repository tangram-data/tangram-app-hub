// HubSpot CRM v3-shaped fixtures for the record-viewer and deal-board previews. Fictional data only.
import { Args, missing, UpstreamError } from "../mock-tangram";

export const previews = [
  { component: "record-viewer", title: "Contact with company + deals (deals paged: 7+)", inputs: { objectType: "contacts", id: "101" }, height: 720 },
  { component: "record-viewer", title: "Deal (stage + owner labels, EUR amount)", inputs: { objectType: "deals", id: "9003" }, height: 640 },
  { component: "deal-board", title: "Sales pipeline, 16 deals, USD + EUR", inputs: {}, height: 620 },
  { component: "deal-board", title: "Filtered to one owner", inputs: { ownerId: "o-2" }, height: 560 },
  { component: "record-viewer", title: "Error: record not found", inputs: { objectType: "companies", id: "404" }, height: 260 },
];

type Props = Record<string, string | null>;
type Rec = { id: string; properties: Props; assoc?: Partial<Record<string, string[]>>; more?: string[] };
const iso = (d: string) => `${d}T15:04:05.000Z`;

const OWNERS = [
  { id: "o-1", email: "avery.lin@example.com", firstName: "Avery", lastName: "Lin" },
  { id: "o-2", email: "jordan.moss@example.com", firstName: "Jordan", lastName: "Moss" },
  { id: "o-3", email: "sam.ortega@example.com", firstName: "Sam", lastName: "Ortega" },
];

const PIPELINES: Record<string, unknown[]> = {
  deals: [
    {
      id: "default",
      label: "Sales pipeline",
      displayOrder: 0,
      stages: [
        { id: "appointmentscheduled", label: "Appointment scheduled", displayOrder: 0, metadata: { isClosed: "false", probability: "0.2" } },
        { id: "qualifiedtobuy", label: "Qualified to buy", displayOrder: 1, metadata: { isClosed: "false", probability: "0.4" } },
        { id: "presentationscheduled", label: "Presentation scheduled", displayOrder: 2, metadata: { isClosed: "false", probability: "0.6" } },
        { id: "contractsent", label: "Contract sent", displayOrder: 3, metadata: { isClosed: "false", probability: "0.9" } },
        { id: "closedwon", label: "Closed won", displayOrder: 4, metadata: { isClosed: "true", probability: "1.0" } },
        { id: "closedlost", label: "Closed lost", displayOrder: 5, metadata: { isClosed: "true", probability: "0.0" } },
      ],
    },
    {
      id: "renewals",
      label: "Renewals",
      displayOrder: 1,
      stages: [
        { id: "r-open", label: "Renewal open", displayOrder: 0, metadata: { isClosed: "false", probability: "0.5" } },
        { id: "r-won", label: "Renewed", displayOrder: 1, metadata: { isClosed: "true", probability: "1.0" } },
      ],
    },
  ],
  tickets: [
    {
      id: "0",
      label: "Support pipeline",
      displayOrder: 0,
      stages: [
        { id: "1", label: "New", displayOrder: 0, metadata: { isClosed: "false" } },
        { id: "4", label: "Closed", displayOrder: 1, metadata: { isClosed: "true" } },
      ],
    },
  ],
};

const opt = (pairs: [string, string][]) => pairs.map(([value, label], i) => ({ value, label, displayOrder: i }));
const PROPERTIES: Record<string, Record<string, unknown>[]> = {
  contacts: [
    { name: "email", label: "Email", type: "string" },
    { name: "phone", label: "Phone number", type: "string" },
    { name: "jobtitle", label: "Job title", type: "string" },
    { name: "company", label: "Company name", type: "string" },
    { name: "lifecyclestage", label: "Lifecycle stage", type: "enumeration", options: opt([["lead", "Lead"], ["marketingqualifiedlead", "Marketing qualified lead"], ["opportunity", "Opportunity"], ["customer", "Customer"]]) },
    { name: "hs_lead_status", label: "Lead status", type: "enumeration", options: opt([["NEW", "New"], ["OPEN", "Open"], ["IN_PROGRESS", "In progress"], ["CONNECTED", "Connected"]]) },
    { name: "hubspot_owner_id", label: "Contact owner", type: "enumeration" },
    { name: "createdate", label: "Create date", type: "datetime" },
    { name: "lastmodifieddate", label: "Last modified date", type: "datetime" },
  ],
  companies: [
    { name: "domain", label: "Company domain name", type: "string" },
    { name: "industry", label: "Industry", type: "enumeration", options: opt([["COMPUTER_SOFTWARE", "Computer software"], ["LOGISTICS_AND_SUPPLY_CHAIN", "Logistics and supply chain"]]) },
    { name: "numberofemployees", label: "Number of employees", type: "number" },
    { name: "annualrevenue", label: "Annual revenue", type: "number" },
    { name: "hubspot_owner_id", label: "Company owner", type: "enumeration" },
    { name: "createdate", label: "Create date", type: "datetime" },
  ],
  deals: [
    { name: "amount", label: "Amount", type: "number" },
    { name: "dealstage", label: "Deal stage", type: "enumeration" },
    { name: "pipeline", label: "Pipeline", type: "enumeration" },
    { name: "closedate", label: "Close date", type: "datetime" },
    { name: "dealtype", label: "Deal type", type: "enumeration", options: opt([["newbusiness", "New business"], ["existingbusiness", "Existing business"]]) },
    { name: "hubspot_owner_id", label: "Deal owner", type: "enumeration" },
    { name: "createdate", label: "Create date", type: "datetime" },
    { name: "hs_lastmodifieddate", label: "Last modified date", type: "datetime" },
  ],
  tickets: [
    { name: "subject", label: "Ticket name", type: "string" },
    { name: "hs_ticket_priority", label: "Priority", type: "enumeration", options: opt([["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"]]) },
    { name: "hs_pipeline_stage", label: "Ticket status", type: "enumeration" },
    { name: "hubspot_owner_id", label: "Ticket owner", type: "enumeration" },
  ],
};

const deal = (id: string, dealname: string, amount: string | null, dealstage: string, closedate: string, owner: string, cur = "USD", pipeline = "default"): Rec => ({
  id,
  properties: {
    dealname, amount, dealstage, pipeline, closedate: iso(closedate), hubspot_owner_id: owner, deal_currency_code: cur,
    dealtype: "newbusiness", createdate: iso("2026-07-02"), hs_lastmodifieddate: iso("2026-10-08"),
  },
  assoc: { contacts: ["101"], companies: ["501"] },
});

const DEALS: Rec[] = [
  deal("9001", "Northwind — platform annual", "48000", "appointmentscheduled", "2026-11-14", "o-1"),
  deal("9002", "Northwind — onboarding services", "7500", "qualifiedtobuy", "2026-11-03", "o-1"),
  deal("9003", "Lumen Freight — EU expansion", "36250.5", "presentationscheduled", "2026-12-01", "o-2", "EUR"),
  deal("9004", "Harbor Labs pilot", "12000", "contractsent", "2026-10-21", "o-3"),
  deal("9005", "Bluefin Analytics", "64000", "closedwon", "2026-09-30", "o-2"),
  deal("9006", "Copperline Retail", "18900", "closedlost", "2026-09-12", "o-3"),
  deal("9007", "Orchid Health — 50 seats", "22500", "qualifiedtobuy", "2026-11-20", "o-2"),
  deal("9008", "Kestrel Mobility", "9800", "appointmentscheduled", "2026-12-15", "o-3", "EUR"),
  deal("9009", "Pinecrest Schools", null, "appointmentscheduled", "2027-01-10", "o-1"),
  deal("9010", "Lumen Freight — support add-on", "4200", "contractsent", "2026-10-28", "o-2", "EUR"),
  deal("9011", "Atlas Robotics", "91000", "presentationscheduled", "2026-12-05", "o-1"),
  deal("9012", "Granite Insurance", "30000", "closedwon", "2026-08-29", "o-1"),
  deal("9013", "Vela Studios", "15400", "qualifiedtobuy", "2026-11-08", "o-3"),
  deal("9014", "Meridian Foods", "27000", "contractsent", "2026-10-31", "o-2"),
  deal("9015", "Sparrow Clinics", "8800", "closedlost", "2026-09-18", "o-2", "EUR"),
  deal("9016", "Quarry Logistics", "41000", "closedwon", "2026-09-05", "o-3"),
  deal("9101", "Northwind renewal FY27", "52000", "r-open", "2027-02-01", "o-1", "USD", "renewals"),
];

const RECORDS: Record<string, Rec[]> = {
  contacts: [
    {
      id: "101",
      properties: {
        firstname: "Riley", lastname: "Chen", email: "riley.chen@northwind.example", phone: "+1 555 0142", jobtitle: "VP Operations",
        company: "Northwind Traders", lifecyclestage: "opportunity", hs_lead_status: "IN_PROGRESS", hubspot_owner_id: "o-1",
        createdate: iso("2026-03-11"), lastmodifieddate: iso("2026-10-09"),
      },
      assoc: { companies: ["501"], deals: ["9001", "9002", "9009", "9011", "9012", "9101", "9013"], tickets: ["7001"] },
      more: ["deals"], // HubSpot returned a further association page for deals
    },
    { id: "102", properties: { firstname: "Morgan", lastname: "Diaz", email: "morgan.diaz@northwind.example", jobtitle: "Head of Finance" } },
  ],
  companies: [
    {
      id: "501",
      properties: {
        name: "Northwind Traders", domain: "northwind.example", industry: "LOGISTICS_AND_SUPPLY_CHAIN", city: "Portland", country: "United States",
        numberofemployees: "420", annualrevenue: "58000000", hubspot_owner_id: "o-1", createdate: iso("2025-11-02"),
      },
      assoc: { contacts: ["101", "102"], deals: ["9001", "9002"] },
    },
    { id: "502", properties: { name: "Lumen Freight GmbH", domain: "lumen-freight.example", city: "Hamburg", country: "Germany" } },
  ],
  deals: DEALS.map((d) => (d.id === "9003" ? { ...d, assoc: { contacts: ["102"], companies: ["502"] } } : d)),
  tickets: [
    { id: "7001", properties: { subject: "Invoice address change", hs_pipeline: "0", hs_pipeline_stage: "1", hs_ticket_priority: "MEDIUM", hubspot_owner_id: "o-3" } },
  ],
};

const TYPE_OF: Record<string, string> = { Contact: "contacts", Company: "companies", Deal: "deals", Ticket: "tickets" };
const ASSOC_TYPE: Record<string, string> = { contacts: "contact", companies: "company", deals: "deal", tickets: "ticket" };

function getRecord(type: string, p: Record<string, unknown>) {
  const id = String(p.id ?? "");
  const rec = RECORDS[type].find((r) => r.id === id);
  if (!rec) throw new UpstreamError(404, { status: "error", message: "resource not found", category: "OBJECT_NOT_FOUND" });
  const wanted = String(p.properties ?? "").split(",").filter(Boolean);
  const properties: Props = { hs_object_id: id };
  (wanted.length ? wanted : Object.keys(rec.properties)).forEach((k) => {
    if (k in rec.properties) properties[k] = rec.properties[k];
  });
  const associations: Record<string, unknown> = {};
  String(p.associations ?? "").split(",").filter(Boolean).forEach((t) => {
    const ids = rec.assoc?.[t] ?? [];
    if (!ids.length) return;
    associations[t] = {
      results: ids.map((aid) => ({ id: aid, type: `${ASSOC_TYPE[type]}_to_${ASSOC_TYPE[t]}` })),
      ...(rec.more?.includes(t) ? { paging: { next: { after: "MTA=", link: "?after=MTA=" } } } : {}),
    };
  });
  return { id, properties, createdAt: iso("2026-03-11"), updatedAt: iso("2026-10-09"), archived: false, associations };
}

type Filter = { propertyName: string; operator: string; value?: string };
function findDeals(body: { filterGroups?: { filters?: Filter[] }[]; properties?: string[]; limit?: number; after?: string }) {
  const groups = body.filterGroups ?? [];
  const matches = DEALS.filter(
    (d) =>
      groups.length === 0 ||
      groups.some((g) => (g.filters ?? []).every((f) => f.operator !== "EQ" || d.properties[f.propertyName] === f.value)),
  );
  const start = Number(body.after ?? 0);
  const limit = Math.min(body.limit ?? 10, 200);
  const page = matches.slice(start, start + limit);
  const props = body.properties ?? ["dealname", "amount", "dealstage"];
  return {
    total: matches.length,
    results: page.map((d) => ({
      id: d.id,
      properties: Object.fromEntries(props.map((k) => [k, d.properties[k] ?? null])),
      createdAt: iso("2026-07-02"),
      updatedAt: iso("2026-10-08"),
      archived: false,
    })),
    ...(start + limit < matches.length ? { paging: { next: { after: String(start + limit) } } } : {}),
  };
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const p = args.parameters ?? {};
  if (TYPE_OF[resourceType] && action === "Get") return getRecord(TYPE_OF[resourceType], p);
  if (resourceType === "Deal" && action === "Find") return findDeals((args.requestBody ?? {}) as Parameters<typeof findDeals>[0]);
  if (resourceType === "Property" && action === "List") return { results: PROPERTIES[String(p.objectType)] ?? [] };
  if (resourceType === "Pipeline" && action === "List") return { results: PIPELINES[String(p.objectType)] ?? [] };
  if (resourceType === "Owner" && action === "List")
    return { results: OWNERS.map((o) => ({ ...o, userId: 1, archived: false, createdAt: iso("2025-01-01") })) };
  return missing(resourceType, action);
}
