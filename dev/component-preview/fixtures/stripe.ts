// Stripe (API 2024-06-20) preview fixtures: one test-mode customer with mixed payments, invoices and
// subscriptions, plus a small in-module invoice store so the composer clicks through draft → line → finalize → send.
import { Args, missing, UpstreamError } from "../mock-tangram";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const CUSTOMER = "cus_PvTest0001";

export const previews = [
  { component: "customer-viewer", title: "Customer with mixed activity", inputs: { customerId: CUSTOMER }, height: 760 },
  { component: "invoice-composer", title: "New draft form", inputs: { customerId: CUSTOMER }, height: 560 },
  { component: "invoice-composer", title: "Resume a draft with lines", inputs: { invoiceId: "in_DraftTest01" }, height: 640 },
  { component: "invoice-composer", title: "Finalized emailed invoice (Send)", inputs: { invoiceId: "in_OpenTest01" }, height: 560 },
  { component: "customer-viewer", title: "Unknown customer (error)", inputs: { customerId: "cus_DoesNotExist" }, height: 320 },
];

const customer = {
  id: CUSTOMER,
  object: "customer",
  name: "Northwind Analytics",
  email: "billing@northwind.example",
  description: "Annual plan, invoiced quarterly",
  created: NOW - 420 * DAY,
  balance: -2500,
  currency: "usd",
  delinquent: false,
  livemode: false,
  metadata: { crm_id: "acct-1042", region: "emea" },
};

const pi = (n: number, amount: number, status: string, ago: number, description: string | null) => ({
  id: `pi_Test${String(n).padStart(4, "0")}`,
  object: "payment_intent",
  amount,
  currency: "usd",
  customer: CUSTOMER,
  status,
  created: NOW - ago,
  description,
  livemode: false,
});

const payments = [
  pi(1, 129900, "succeeded", 2 * 3600, "Invoice INV-0012"),
  pi(2, 4900, "requires_payment_method", 3 * DAY, "Seat add-on"),
  pi(3, 129900, "succeeded", 92 * DAY, "Invoice INV-0011"),
  pi(4, 2500, "canceled", 120 * DAY, null),
  pi(5, 15000, "processing", 30 * 60, "Usage overage"),
];

type Line = { id: string; object: "line_item"; description: string; amount: number; currency: string; quantity: number };
type Inv = {
  id: string;
  object: "invoice";
  number: string | null;
  customer: string;
  customer_name: string;
  customer_email: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  currency: string;
  collection_method: "charge_automatically" | "send_invoice";
  days_until_due: number | null;
  due_date: number | null;
  auto_advance: boolean;
  total: number;
  amount_due: number;
  description: string | null;
  created: number;
  livemode: boolean;
  hosted_invoice_url: string | null;
  lines: { object: "list"; data: Line[]; has_more: boolean };
};

let seq = 100;
const nextId = (prefix: string) => `${prefix}_Preview${++seq}`;

function invoice(id: string, status: Inv["status"], method: Inv["collection_method"], lines: Line[], extra: Partial<Inv> = {}): Inv {
  const total = lines.reduce((n, l) => n + l.amount, 0);
  return {
    id,
    object: "invoice",
    number: status === "draft" ? null : `INV-${id.slice(-4).toUpperCase()}`,
    customer: CUSTOMER,
    customer_name: customer.name,
    customer_email: customer.email,
    status,
    currency: "usd",
    collection_method: method,
    days_until_due: method === "send_invoice" ? 30 : null,
    due_date: method === "send_invoice" && status !== "draft" ? NOW + 30 * DAY : null,
    auto_advance: false,
    total,
    amount_due: status === "paid" ? 0 : total,
    description: null,
    created: NOW - DAY,
    livemode: false,
    hosted_invoice_url: status === "draft" ? null : `https://invoice.stripe.com/i/acct_TestPreview/test_${id}`,
    lines: { object: "list", data: lines, has_more: false },
    ...extra,
  };
}

const line = (description: string, amount: number, quantity = 1): Line => ({
  id: nextId("il"),
  object: "line_item",
  description,
  amount: amount * quantity,
  currency: "usd",
  quantity,
});

// The invoice store the composer reads and writes; the viewer's list reads the same.
const invoices = new Map<string, Inv>();
for (const inv of [
  invoice("in_DraftTest01", "draft", "send_invoice", [line("Onboarding workshop", 180000), line("Extra seats", 4900, 3)]),
  invoice("in_OpenTest01", "open", "send_invoice", [line("Q4 platform subscription", 129900)]),
  invoice("in_PaidTest01", "paid", "charge_automatically", [line("Q3 platform subscription", 129900)], { created: NOW - 92 * DAY }),
  invoice("in_DueTest01", "open", "send_invoice", [line("Consulting, September", 64000)], {
    created: NOW - 45 * DAY,
    due_date: NOW - 15 * DAY,
  }),
  invoice("in_VoidTest01", "void", "send_invoice", [line("Duplicate of INV-0011", 129900)], { created: NOW - 95 * DAY }),
])
  invoices.set(inv.id, inv);

const subscriptions = [
  {
    id: "sub_TestActive1",
    object: "subscription",
    customer: CUSTOMER,
    status: "active",
    current_period_end: NOW + 61 * DAY,
    cancel_at_period_end: false,
    items: { object: "list", data: [{ id: "si_T1", price: { id: "price_TestPlatform", nickname: "Platform — annual", unit_amount: 519600, currency: "usd" } }] },
  },
  {
    id: "sub_TestPastDue",
    object: "subscription",
    customer: CUSTOMER,
    status: "past_due",
    current_period_end: NOW + 4 * DAY,
    cancel_at_period_end: true,
    items: {
      object: "list",
      data: [
        { id: "si_T2", price: { id: "price_TestSeats", nickname: "Seat add-on", unit_amount: 4900, currency: "usd" } },
        { id: "si_T3", price: { id: "price_TestStorage", nickname: null, unit_amount: 1000, currency: "usd" } },
      ],
    },
  },
  {
    id: "sub_TestCanceled",
    object: "subscription",
    customer: CUSTOMER,
    status: "canceled",
    current_period_end: NOW - 200 * DAY,
    cancel_at_period_end: false,
    items: { object: "list", data: [{ id: "si_T4", price: { id: "price_TestLegacy", nickname: "Legacy starter", unit_amount: 2900, currency: "usd" } }] },
  },
];

const list = <T,>(data: T[], url: string) => ({ object: "list", data, has_more: false, url });

const notFound = (kind: string, id: string) =>
  new UpstreamError(404, {
    error: { code: "resource_missing", message: `No such ${kind}: '${id}'`, param: "id", type: "invalid_request_error" },
  });

function getInvoice(id: string): Inv {
  const inv = invoices.get(id);
  if (!inv) throw notFound("invoice", id);
  return inv;
}

function recompute(inv: Inv) {
  inv.total = inv.lines.data.reduce((n, l) => n + l.amount, 0);
  inv.amount_due = inv.status === "paid" ? 0 : inv.total;
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const p = (args.parameters ?? {}) as Record<string, any>;
  const body = (args.requestBody ?? {}) as Record<string, any>;
  const key = `${resourceType}.${action}`;
  switch (key) {
    case "Customer.Get":
      if (p.id !== CUSTOMER) throw notFound("customer", String(p.id));
      return customer;
    case "PaymentIntent.List":
      return list(payments.filter((x) => x.customer === p.customer), "/v1/payment_intents");
    case "Invoice.List":
      return list(
        [...invoices.values()].filter((x) => x.customer === p.customer).sort((a, b) => b.created - a.created),
        "/v1/invoices",
      );
    case "Subscription.List":
      return list(subscriptions.filter((x) => x.customer === p.customer), "/v1/subscriptions");
    case "Invoice.Get":
      return getInvoice(String(p.id));
    case "Invoice.Create": {
      if (body.customer !== CUSTOMER) throw notFound("customer", String(body.customer));
      const inv = invoice(nextId("in"), "draft", body.collection_method ?? "charge_automatically", [], {
        description: body.description ?? null,
        days_until_due: body.days_until_due ?? null,
        created: NOW,
      });
      invoices.set(inv.id, inv);
      return inv;
    }
    case "InvoiceItem.Create": {
      const inv = getInvoice(String(body.invoice));
      if (inv.status !== "draft")
        throw new UpstreamError(400, { error: { message: "Invoice is not a draft.", type: "invalid_request_error" } });
      const fromPrice = typeof body.price === "string";
      const amount = fromPrice ? 2500 : Number(body.amount);
      const qty = fromPrice ? Number(body.quantity ?? 1) : 1;
      const l = line(fromPrice ? `Catalog price ${body.price}` : String(body.description), amount, qty);
      inv.lines.data.push(l);
      recompute(inv);
      return { id: nextId("ii"), object: "invoiceitem", invoice: inv.id, customer: inv.customer, amount: l.amount, currency: "usd", livemode: false };
    }
    case "Invoice.Finalize": {
      const inv = getInvoice(String(p.id));
      inv.status = "open";
      inv.number = `INV-${inv.id.slice(-4).toUpperCase()}`;
      inv.auto_advance = Boolean(body.auto_advance);
      inv.due_date = inv.collection_method === "send_invoice" ? NOW + (inv.days_until_due ?? 30) * DAY : null;
      inv.hosted_invoice_url = `https://invoice.stripe.com/i/acct_TestPreview/test_${inv.id}`;
      return inv;
    }
    case "Invoice.Send":
      return getInvoice(String(p.id));
    case "Invoice.Delete": {
      const inv = getInvoice(String(p.id));
      invoices.delete(inv.id);
      return { id: inv.id, object: "invoice", deleted: true };
    }
    default:
      return missing(resourceType, action);
  }
}
