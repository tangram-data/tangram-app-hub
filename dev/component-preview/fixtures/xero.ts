// Xero preview fixtures: a fictional NZ company's invoices and reports, shaped like the Accounting API.
import { Args, UpstreamError, missing } from "../mock-tangram";

export const previews = [
  { component: "invoice-viewer", title: "Sales invoice — awaiting payment, part paid", inputs: { invoiceId: "inv-1001" } },
  { component: "invoice-viewer", title: "Supplier bill — overdue", inputs: { invoiceId: "bill-2044" } },
  { component: "invoice-viewer", title: "Error — invoice not found", inputs: { invoiceId: "missing" }, height: 360 },
  {
    component: "report-viewer",
    title: "Profit and loss — 2 months comparison",
    inputs: { report: "ProfitAndLoss", fromDate: "2026-09-01", toDate: "2026-09-30", periods: 2, timeframe: "MONTH" },
  },
  { component: "report-viewer", title: "Balance sheet", inputs: { report: "BalanceSheet", date: "2026-09-30" } },
];

const DAY = 86_400_000;
// Xero sends both forms: "/Date(ms+0000)/" and an ISO DateString.
function xd(iso: string) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return { ms: `/Date(${ms}+0000)/`, iso: `${iso}T00:00:00` };
}
function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

function line(id: string, Description: string, Quantity: number, UnitAmount: number, AccountCode: string, rate = 0.15) {
  const LineAmount = Math.round(Quantity * UnitAmount * 100) / 100;
  return { LineItemID: id, Description, Quantity, UnitAmount, AccountCode, TaxType: rate ? "OUTPUT2" : "NONE", TaxAmount: Math.round(LineAmount * rate * 100) / 100, LineAmount };
}

function invoice(o: {
  id: string; number: string; type: "ACCREC" | "ACCPAY"; status: string; contact: string; date: string; due: string;
  reference?: string; lines: ReturnType<typeof line>[]; paid?: { date: string; amount: number; ref: string }[];
}) {
  const sub = o.lines.reduce((n, l) => n + l.LineAmount, 0);
  const tax = o.lines.reduce((n, l) => n + l.TaxAmount, 0);
  const total = Math.round((sub + tax) * 100) / 100;
  const paid = (o.paid ?? []).reduce((n, p) => n + p.amount, 0);
  const d = xd(o.date), dd = xd(o.due);
  return {
    InvoiceID: o.id, InvoiceNumber: o.number, Type: o.type, Status: o.status,
    Contact: { ContactID: `contact-${o.contact.toLowerCase().replace(/\W+/g, "-")}`, Name: o.contact },
    Date: d.ms, DateString: d.iso, DueDate: dd.ms, DueDateString: dd.iso, Reference: o.reference ?? "",
    LineAmountTypes: "Exclusive", LineItems: o.lines,
    SubTotal: Math.round(sub * 100) / 100, TotalTax: Math.round(tax * 100) / 100, Total: total,
    AmountPaid: paid, AmountDue: Math.round((total - paid) * 100) / 100, AmountCredited: 0, CurrencyCode: "NZD",
    Payments: (o.paid ?? []).map((p, i) => ({ PaymentID: `${o.id}-pay-${i}`, Date: xd(p.date).ms, Amount: p.amount, Reference: p.ref })),
  };
}

const INVOICES: Record<string, ReturnType<typeof invoice>> = {
  "inv-1001": invoice({
    id: "inv-1001", number: "INV-1001", type: "ACCREC", status: "AUTHORISED", contact: "Harbourview Cafe Ltd",
    date: "2026-09-18", due: isoDaysFromToday(12), reference: "PO 7781 — spring menu",
    lines: [
      line("l1", "Espresso machine service (half day)", 4, 95, "200"),
      line("l2", "Replacement group gaskets", 6, 18.5, "200"),
      line("l3", "Barista training workshop", 1, 450, "260"),
    ],
    paid: [{ date: "2026-09-25", amount: 300, ref: "Deposit — bank transfer" }],
  }),
  "bill-2044": invoice({
    id: "bill-2044", number: "SUP-2044", type: "ACCPAY", status: "AUTHORISED", contact: "Southern Coffee Roasters",
    date: "2026-08-20", due: isoDaysFromToday(-9), reference: "Green beans Aug",
    lines: [line("b1", "Green beans, Colombia Huila (kg)", 120, 14.2, "310"), line("b2", "Freight Auckland → Wellington", 1, 85, "425")],
  }),
};

// Report rows: Section(Title, Rows[Row|SummaryRow]); n = number of value columns.
const cell = (Value: string) => ({ Value });
const row = (label: string, vals: number[]) => ({ RowType: "Row", Cells: [cell(label), ...vals.map((v) => cell(v.toFixed(2)))] });
const sumRow = (label: string, vals: number[]) => ({ RowType: "SummaryRow", Cells: [cell(label), ...vals.map((v) => cell(v.toFixed(2)))] });
const section = (Title: string, rows: unknown[]) => ({ RowType: "Section", Title, Rows: rows });
const totals = (rows: { Cells: { Value: string }[] }[], n: number) =>
  Array.from({ length: n }, (_, c) => rows.reduce((s, r) => s + Number(r.Cells[c + 1].Value), 0));

const monthLabel = (iso: string, back: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toLocaleDateString("en-NZ", { month: "short", year: "numeric", timeZone: "UTC" });
};
// Scale per comparison column so older periods differ a little.
const series = (base: number, n: number) => Array.from({ length: n }, (_, i) => Math.round(base * (1 - i * 0.07) * 100) / 100);

function profitAndLoss(p: Record<string, unknown>) {
  const periods = Number(p.periods) || 0;
  const n = periods + 1;
  const to = String(p.toDate ?? "2026-09-30");
  const tf = String(p.timeframe ?? "MONTH");
  const heads = Array.from({ length: n }, (_, i) =>
    tf === "MONTH" ? monthLabel(to, i) : i === 0 ? `This ${tf.toLowerCase()}` : `${i} ${tf.toLowerCase()}${i > 1 ? "s" : ""} back`,
  );
  const income = [row("Sales", series(48250, n)), row("Training income", series(3600, n)), row("Interest income", series(42.17, n))];
  const cogs = [row("Coffee beans", series(11840, n)), row("Freight", series(940, n))];
  const opex = [row("Rent", Array(n).fill(5200)), row("Wages and salaries", series(18900, n)), row("Power", series(612.4, n)), row("Bank fees", series(38.5, n))];
  const ti = totals(income, n), tc = totals(cogs, n), to2 = totals(opex, n);
  return {
    ReportName: "Profit and Loss",
    ReportTitles: ["Profit and Loss", "Kōwhai Coffee Co (Demo)", `For the period ${p.fromDate ?? "2026-09-01"} to ${to}`],
    Rows: [
      { RowType: "Header", Cells: [cell(""), ...heads.map(cell)] },
      section("Income", [...income, sumRow("Total Income", ti)]),
      section("Less Cost of Sales", [...cogs, sumRow("Total Cost of Sales", tc)]),
      section("", [sumRow("Gross Profit", ti.map((v, i) => v - tc[i]))]),
      section("Less Operating Expenses", [...opex, sumRow("Total Operating Expenses", to2)]),
      section("", [sumRow("Net Profit", ti.map((v, i) => v - tc[i] - to2[i]))]),
    ],
  };
}

function balanceSheet(p: Record<string, unknown>) {
  const n = (Number(p.periods) || 0) + 1;
  const at = String(p.date ?? "2026-09-30");
  const bank = [row("Business Cheque Account", series(38420.55, n)), row("Savings Account", series(15000, n))];
  const current = [row("Accounts Receivable", series(9384.5, n)), row("Inventory", series(6120, n))];
  const fixed = [row("Office Equipment", series(14800, n)), row("Less Accumulated Depreciation", series(-3920, n))];
  const liab = [row("Accounts Payable", series(2058.4, n)), row("GST", series(3110.25, n)), row("Wages Payable", series(4200, n))];
  const assets = totals([...bank, ...current, ...fixed], n), l = totals(liab, n);
  return {
    ReportName: "Balance Sheet",
    ReportTitles: ["Balance Sheet", "Kōwhai Coffee Co (Demo)", `As at ${at}`],
    Rows: [
      { RowType: "Header", Cells: [cell(""), ...Array.from({ length: n }, (_, i) => cell(monthLabel(at, i)))] },
      section("Assets", []),
      section("Bank", [...bank, sumRow("Total Bank", totals(bank, n))]),
      section("Current Assets", [...current, sumRow("Total Current Assets", totals(current, n))]),
      section("Fixed Assets", [...fixed, sumRow("Total Fixed Assets", totals(fixed, n))]),
      section("", [sumRow("Total Assets", assets)]),
      section("Liabilities", [...liab, sumRow("Total Liabilities", l)]),
      section("", [sumRow("Net Assets", assets.map((v, i) => v - l[i]))]),
      section("Equity", [row("Current Year Earnings", series(21480.3, n)), row("Retained Earnings", assets.map((v, i) => v - l[i] - series(21480.3, n)[i]))]),
    ],
  };
}

function trialBalance(p: Record<string, unknown>) {
  const tb = (code: string, name: string, dr: number, cr: number) => ({
    RowType: "Row", Cells: [cell(`${name} (${code})`), cell(dr ? dr.toFixed(2) : ""), cell(cr ? cr.toFixed(2) : ""), cell(dr ? dr.toFixed(2) : ""), cell(cr ? cr.toFixed(2) : "")],
  });
  return {
    ReportName: "Trial Balance",
    ReportTitles: ["Trial Balance", "Kōwhai Coffee Co (Demo)", `As at ${p.date ?? "2026-09-30"}`],
    Rows: [
      { RowType: "Header", Cells: ["Account", "Debit", "Credit", "YTD Debit", "YTD Credit"].map(cell) },
      section("Revenue", [tb("200", "Sales", 0, 48250), tb("260", "Other Revenue", 0, 3600)]),
      section("Expenses", [tb("310", "Cost of Goods Sold", 11840, 0), tb("469", "Rent", 5200, 0), tb("477", "Wages and Salaries", 18900, 0)]),
      section("Assets", [tb("090", "Business Cheque Account", 38420.55, 0), tb("610", "Accounts Receivable", 9384.5, 0)]),
      section("Liabilities", [tb("800", "Accounts Payable", 0, 2058.4), tb("820", "GST", 0, 3110.25)]),
      section("Equity", [tb("960", "Retained Earnings", 0, 26726.4)]),
      section("", [{ RowType: "SummaryRow", Cells: [cell("Total"), cell("83745.05"), cell("83745.05"), cell("83745.05"), cell("83745.05")] }]),
    ],
  };
}

export function handle(resourceType: string, action: string, args: Args): unknown {
  const p = (args.parameters ?? {}) as Record<string, unknown>;
  if (resourceType === "Invoice" && action === "Get") {
    const id = String(p.InvoiceID ?? "");
    const inv = INVOICES[id] ?? Object.values(INVOICES).find((i) => i.InvoiceNumber === id);
    if (!inv) throw new UpstreamError(404, { Type: "NotFound", Title: "Resource Not Found", Detail: `Invoice ${id} was not found` });
    return { Status: "OK", Invoices: [inv] };
  }
  if (resourceType === "Report") {
    if (action === "ProfitAndLoss") return { Status: "OK", Reports: [profitAndLoss(p)] };
    if (action === "BalanceSheet") return { Status: "OK", Reports: [balanceSheet(p)] };
    if (action === "TrialBalance") return { Status: "OK", Reports: [trialBalance(p)] };
  }
  return missing(resourceType, action);
}
