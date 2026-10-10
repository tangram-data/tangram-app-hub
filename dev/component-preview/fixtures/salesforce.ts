// Salesforce preview fixtures: describe/record/list-objects shapes as the REST API (v62.0) returns them.
// Names, emails and ids are invented.
import { Args, UpstreamError, missing } from "../mock-tangram";

export const previews = [
  { component: "record-viewer", title: "Opportunity — currency, dates, picklists, lookups", inputs: { sobject: "Opportunity", id: "006Hs00001AbCdEIAV" } },
  { component: "record-viewer", title: "Contact — polymorphic OwnerId, address, geolocation", inputs: { sobject: "Contact", id: "003Hs00002XyZaBIAV" } },
  { component: "record-editor", title: "Edit an Account", inputs: { sobject: "Account", id: "001Hs00003QwErTIAV" }, height: 720 },
  {
    component: "record-editor",
    title: "New Lead with prefill",
    inputs: { sobject: "Lead", fields: { LastName: "Okafor", Company: "Northwind Analytics", LeadSource: "Web", Id: "ignored" } },
    height: 720,
  },
  { component: "record-viewer", title: "Error — record not visible", inputs: { sobject: "Case", id: "500Hs00000NoPeIAV" }, height: 320 },
];

type F = Record<string, unknown>;

// One describe field with Salesforce's defaults for the flags the components read.
function fld(name: string, label: string, type: string, extra: F = {}): F {
  return {
    name, label, type, nillable: true, createable: true, updateable: true, defaultedOnCreate: false, nameField: false,
    calculated: false, autoNumber: false, compoundFieldName: null, referenceTo: [], picklistValues: [], length: 255,
    inlineHelpText: null, defaultValue: null, ...extra,
  };
}
const ro = { createable: false, updateable: false };
const pick = (...values: string[]) => values.map((v, i) => ({ value: v, label: v, active: true, defaultValue: i === 0 }));
const system = (): F[] => [
  fld("Id", "Record ID", "id", { ...ro, nillable: false }),
  fld("IsDeleted", "Deleted", "boolean", ro),
  fld("CreatedDate", "Created Date", "datetime", ro),
  fld("CreatedById", "Created By ID", "reference", { ...ro, referenceTo: ["User"] }),
  fld("LastModifiedDate", "Last Modified Date", "datetime", ro),
  fld("SystemModstamp", "System Modstamp", "datetime", ro),
  fld("OwnerId", "Owner ID", "reference", { referenceTo: ["Group", "User"], nillable: false, defaultedOnCreate: true }),
];
const address = (prefix: string, label: string): F[] => [
  fld(`${prefix}Address`, label, "address", ro),
  ...["Street", "City", "State", "PostalCode", "Country"].map((p) =>
    fld(`${prefix}${p}`, `${label.replace(" Address", "")} ${p.replace("PostalCode", "Zip/Postal Code")}`, p === "Street" ? "textarea" : "string", {
      compoundFieldName: `${prefix}Address`,
    }),
  ),
];

const DESCRIBES: Record<string, { label: string; keyPrefix: string; fields: F[] }> = {
  Opportunity: {
    label: "Opportunity", keyPrefix: "006",
    fields: [
      ...system(),
      fld("Name", "Opportunity Name", "string", { nameField: true, nillable: false, length: 120 }),
      fld("AccountId", "Account ID", "reference", { referenceTo: ["Account"] }),
      fld("StageName", "Stage", "picklist", { nillable: false, picklistValues: pick("Prospecting", "Qualification", "Proposal/Price Quote", "Negotiation/Review", "Closed Won", "Closed Lost") }),
      fld("Amount", "Amount", "currency"),
      fld("Probability", "Probability (%)", "percent"),
      fld("CloseDate", "Close Date", "date", { nillable: false }),
      fld("Type", "Opportunity Type", "picklist", { picklistValues: pick("New Customer", "Existing Customer - Upgrade", "Existing Customer - Renewal") }),
      fld("LeadSource", "Lead Source", "picklist", { picklistValues: pick("Web", "Phone Inquiry", "Partner Referral", "Trade Show") }),
      fld("NextStep", "Next Step", "string"),
      fld("Description", "Description", "textarea", { length: 32000 }),
      fld("IsPrivate", "Private", "boolean", { defaultValue: false }),
      fld("Website__c", "Deal Room", "url"),
    ],
  },
  Contact: {
    label: "Contact", keyPrefix: "003",
    fields: [
      ...system(),
      fld("Name", "Full Name", "string", { ...ro, nameField: true }),
      fld("FirstName", "First Name", "string", { compoundFieldName: "Name" }),
      fld("LastName", "Last Name", "string", { compoundFieldName: "Name", nillable: false }),
      fld("AccountId", "Account ID", "reference", { referenceTo: ["Account"] }),
      fld("Title", "Title", "string"),
      fld("Email", "Email", "email"),
      fld("Phone", "Business Phone", "phone"),
      fld("Birthdate", "Birthdate", "date"),
      fld("HasOptedOutOfEmail", "Email Opt Out", "boolean", { defaultValue: false }),
      ...address("Mailing", "Mailing Address"),
      fld("Office_Location__c", "Office Location", "location", ro),
      fld("Office_Location__Latitude__s", "Office Location (Latitude)", "double", { compoundFieldName: "Office_Location__c" }),
      fld("Office_Location__Longitude__s", "Office Location (Longitude)", "double", { compoundFieldName: "Office_Location__c" }),
      fld("Blog__c", "Blog", "url"),
    ],
  },
  Account: {
    label: "Account", keyPrefix: "001",
    fields: [
      ...system(),
      fld("Name", "Account Name", "string", { nameField: true, nillable: false }),
      fld("AccountNumber", "Account Number", "string"),
      fld("Type", "Account Type", "picklist", { picklistValues: pick("Prospect", "Customer - Direct", "Customer - Channel", "Partner") }),
      fld("Industry", "Industry", "picklist", { picklistValues: pick("Agriculture", "Energy", "Healthcare", "Manufacturing", "Technology") }),
      fld("AnnualRevenue", "Annual Revenue", "currency"),
      fld("NumberOfEmployees", "Employees", "int"),
      fld("Rating", "Account Rating", "picklist", { picklistValues: pick("Hot", "Warm", "Cold") }),
      fld("Phone", "Account Phone", "phone"),
      fld("Website", "Website", "url"),
      fld("ParentId", "Parent Account ID", "reference", { referenceTo: ["Account"] }),
      fld("Description", "Account Description", "textarea", { length: 32000 }),
      ...address("Billing", "Billing Address"),
      fld("Active__c", "Active", "boolean", { defaultValue: true }),
      fld("SLA_Expires__c", "SLA Expiration", "datetime"),
    ],
  },
  Lead: {
    label: "Lead", keyPrefix: "00Q",
    fields: [
      ...system(),
      fld("Name", "Full Name", "string", { ...ro, nameField: true }),
      fld("FirstName", "First Name", "string", { compoundFieldName: "Name" }),
      fld("LastName", "Last Name", "string", { compoundFieldName: "Name", nillable: false }),
      fld("Company", "Company", "string", { nillable: false }),
      fld("Title", "Title", "string"),
      fld("Email", "Email", "email"),
      fld("Phone", "Phone", "phone"),
      fld("Status", "Lead Status", "picklist", { nillable: false, defaultedOnCreate: true, picklistValues: pick("Open - Not Contacted", "Working - Contacted", "Closed - Converted", "Closed - Not Converted") }),
      fld("LeadSource", "Lead Source", "picklist", { picklistValues: pick("Web", "Phone Inquiry", "Partner Referral", "Trade Show") }),
      fld("Industry", "Industry", "picklist", { picklistValues: pick("Energy", "Healthcare", "Technology") }),
      fld("Rating", "Rating", "picklist", { picklistValues: pick("Hot", "Warm", "Cold") }),
      fld("AnnualRevenue", "Annual Revenue", "currency"),
      fld("Interests__c", "Product Interests", "multipicklist", { picklistValues: pick("Analytics", "Integrations", "Support") }),
      fld("DoNotCall", "Do Not Call", "boolean", { defaultValue: false }),
      fld("Priority_Lead__c", "Priority Lead", "boolean", { defaultedOnCreate: true }), // formula default: unknown here
      fld("Description", "Description", "textarea", { length: 32000 }),
      ...address("", "Address"),
    ],
  },
  Case: { label: "Case", keyPrefix: "500", fields: [...system(), fld("CaseNumber", "Case Number", "string", { ...ro, nameField: true, autoNumber: true })] },
};

const audit = (created: string, modified: string): F => ({
  CreatedDate: created, CreatedById: "005Hs000001UsRaIAG", LastModifiedDate: modified, SystemModstamp: modified, IsDeleted: false,
});
const attrs = (type: string, id: string) => ({ type, url: `/services/data/v62.0/sobjects/${type}/${id}` });

const RECORDS: Record<string, F> = {
  "006Hs00001AbCdEIAV": {
    attributes: attrs("Opportunity", "006Hs00001AbCdEIAV"), Id: "006Hs00001AbCdEIAV", ...audit("2026-08-04T15:12:44.000+0000", "2026-10-08T09:41:03.000+0000"),
    OwnerId: "005Hs000001UsRaIAG", Name: "Northwind — Analytics Platform Renewal", AccountId: "001Hs00003QwErTIAV", StageName: "Negotiation/Review",
    Amount: 184500, Probability: 80, CloseDate: "2026-11-14", Type: "Existing Customer - Renewal", LeadSource: "Partner Referral",
    NextStep: "Legal redlines back by Oct 17", Description: "Three-year renewal with a 15% seat expansion.\nProcurement wants net-60 terms.",
    IsPrivate: false, Website__c: "https://dealroom.example.com/northwind", CurrencyIsoCode: "USD",
  },
  "003Hs00002XyZaBIAV": {
    attributes: attrs("Contact", "003Hs00002XyZaBIAV"), Id: "003Hs00002XyZaBIAV", ...audit("2025-03-19T10:02:00.000+0000", "2026-09-30T18:20:11.000+0000"),
    OwnerId: "00GHs000000QuEuEAK", Name: "Priya Raman", FirstName: "Priya", LastName: "Raman", AccountId: "001Hs00003QwErTIAV",
    Title: "VP, Data Platform", Email: "priya.raman@northwind.example", Phone: "+1 (415) 555-0142", Birthdate: null, HasOptedOutOfEmail: false,
    MailingAddress: { street: "500 Market St, Floor 12", city: "San Francisco", state: "CA", postalCode: "94105", country: "USA", latitude: null, longitude: null },
    MailingStreet: "500 Market St, Floor 12", MailingCity: "San Francisco", MailingState: "CA", MailingPostalCode: "94105", MailingCountry: "USA",
    Office_Location__c: { latitude: 37.789673, longitude: -122.401052 }, Office_Location__Latitude__s: 37.789673, Office_Location__Longitude__s: -122.401052,
    Blog__c: "http://blog.example.org/priya",
  },
  "001Hs00003QwErTIAV": {
    attributes: attrs("Account", "001Hs00003QwErTIAV"), Id: "001Hs00003QwErTIAV", ...audit("2023-01-10T08:00:00.000+0000", "2026-10-02T12:30:00.000+0000"),
    OwnerId: "005Hs000001UsRaIAG", Name: "Northwind Analytics", AccountNumber: "CD-20481", Type: "Customer - Direct", Industry: "Technology",
    AnnualRevenue: 48000000, NumberOfEmployees: 420, Rating: "Hot", Phone: "+1 (415) 555-0100", Website: "www.northwind.example", ParentId: null,
    Description: "Strategic account; executive sponsor is the CFO.",
    BillingAddress: { street: "500 Market St", city: "San Francisco", state: "CA", postalCode: "94105", country: "USA" },
    BillingStreet: "500 Market St", BillingCity: "San Francisco", BillingState: "CA", BillingPostalCode: "94105", BillingCountry: "USA",
    Active__c: true, SLA_Expires__c: "2027-01-31T23:59:00.000+0000",
  },
};

const OBJECTS = [
  { name: "Account", label: "Account", keyPrefix: "001", custom: false, queryable: true },
  { name: "Contact", label: "Contact", keyPrefix: "003", custom: false, queryable: true },
  { name: "Opportunity", label: "Opportunity", keyPrefix: "006", custom: false, queryable: true },
  { name: "Lead", label: "Lead", keyPrefix: "00Q", custom: false, queryable: true },
  { name: "Case", label: "Case", keyPrefix: "500", custom: false, queryable: true },
  { name: "User", label: "User", keyPrefix: "005", custom: false, queryable: true },
  { name: "Group", label: "Group", keyPrefix: "00G", custom: false, queryable: true },
  { name: "Invoice__c", label: "Invoice", keyPrefix: "a0B", custom: true, queryable: true },
];

let created = 0;

export function handle(resourceType: string, action: string, args: Args): unknown {
  const p = (args.parameters ?? {}) as Record<string, string>;
  if (resourceType !== "Record") return missing(resourceType, action);
  switch (action) {
    case "Describe": {
      const d = DESCRIBES[p.sobject];
      if (!d) throw new UpstreamError(404, [{ errorCode: "NOT_FOUND", message: `The requested resource does not exist` }]);
      return { name: p.sobject, label: d.label, keyPrefix: d.keyPrefix, createable: true, updateable: true, fields: d.fields };
    }
    case "Get": {
      const rec = RECORDS[p.id];
      if (!rec) throw new UpstreamError(404, [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }]);
      return rec;
    }
    case "ListObjects":
      return { encoding: "UTF-8", maxBatchSize: 200, sobjects: OBJECTS };
    case "Create": {
      const d = DESCRIBES[p.sobject];
      const id = `${d?.keyPrefix ?? "a0B"}Hs0000${String(++created).padStart(4, "0")}PrVwIAV`.slice(0, 18);
      const body = (args.requestBody ?? {}) as F;
      RECORDS[id] = { attributes: attrs(p.sobject, id), Id: id, ...audit(new Date().toISOString(), new Date().toISOString()), ...(p.sobject === "Lead" ? { Status: "Open - Not Contacted" } : {}), ...body };
      return { id, success: true, errors: [] };
    }
    case "Update": {
      const rec = RECORDS[p.id];
      if (!rec) throw new UpstreamError(404, [{ errorCode: "ENTITY_IS_DELETED", message: "entity is deleted" }]);
      Object.assign(rec, args.requestBody ?? {}, { LastModifiedDate: new Date().toISOString() });
      return null; // 204 No Content
    }
    default:
      return missing(resourceType, action);
  }
}
