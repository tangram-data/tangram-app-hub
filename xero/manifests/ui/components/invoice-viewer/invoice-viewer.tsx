// A Xero invoice or bill by id, laid out like Xero's own view: header with
// status, the key facts, line items, totals, and payments. Read-only; the
// contact emits `open` for the host/agent and "Open in Xero" deep-links.
import { ExportOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/tangram-buttons.css";
import "../../shared/xero.css";
import { STATUS, dateLabel, errorText, money, xeroDate } from "../../shared/xero-format";

const tangram = (window as any).tangram;

type LineItem = {
  LineItemID?: string;
  Description?: string;
  Quantity?: number;
  UnitAmount?: number;
  AccountCode?: string;
  TaxType?: string;
  TaxAmount?: number;
  LineAmount?: number;
};
type Payment = { PaymentID?: string; Date?: string; Amount?: number; Reference?: string };
type Invoice = {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type?: "ACCREC" | "ACCPAY" | string;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string };
  Date?: string;
  DateString?: string;
  DueDate?: string;
  DueDateString?: string;
  Reference?: string;
  LineAmountTypes?: string;
  LineItems?: LineItem[];
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  AmountPaid?: number;
  AmountDue?: number;
  AmountCredited?: number;
  CurrencyCode?: string;
  Payments?: Payment[];
};

function xeroUrl(inv: Invoice): string {
  const area = inv.Type === "ACCPAY" ? "AccountsPayable" : "AccountsReceivable";
  return `https://go.xero.com/${area}/View.aspx?InvoiceID=${encodeURIComponent(inv.InvoiceID)}`;
}

function StatusWord({ inv }: { inv: Invoice }) {
  const due = xeroDate(inv.DueDateString, inv.DueDate);
  const overdue = inv.Status === "AUTHORISED" && (inv.AmountDue ?? 0) > 0 && !!due && due.isBefore(dayjs(), "day");
  const s = overdue
    ? { color: "#d92d20", label: "Overdue", bad: true }
    : (STATUS[inv.Status ?? ""] ?? { color: "#9ca3af", label: inv.Status ?? "Unknown" });
  return (
    <span className={`x-status${s.bad ? " bad" : ""}`}>
      <span className="dot" style={{ background: s.color }} aria-hidden="true" />
      {s.bad ? <b>{s.label}</b> : s.label}
    </span>
  );
}

export default function InvoiceViewer() {
  const [invoiceId, setInvoiceId] = useState("");
  const [inv, setInv] = useState<Invoice | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback((id: string) => {
    const mine = ++seq.current;
    if (!id) {
      setInv(null);
      setState("error");
      setError("No invoice id was given.");
      return;
    }
    setState("loading");
    setError("");
    tangram
      .performAction({ resourceType: "Invoice", action: "Get" }, { parameters: { InvoiceID: id } })
      .then((r: { Invoices?: Invoice[] }) => {
        if (mine !== seq.current) return;
        const found = r?.Invoices?.[0] ?? null;
        setInv(found);
        if (found) setState("ready");
        else {
          setState("error");
          setError("Xero returned no invoice for this id.");
        }
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setInv(null);
        setError(errorText(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const id = String(inputs?.invoiceId ?? "").trim();
      setInvoiceId(id);
      load(id);
    };
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  if (state === "loading" || state === "idle")
    return (
      <div className="x-root">
        <div className="x-accent" />
        <div className="x-pad">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      </div>
    );

  if (state === "error" || !inv)
    return (
      <div className="x-root">
        <div className="x-accent" />
        <div className="x-error">
          <b>Couldn't load the invoice</b>
          {error ? <div>{error}</div> : null}
          {invoiceId ? (
            <div style={{ marginTop: 8 }}>
              <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} onClick={() => load(invoiceId)}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );

  const cur = inv.CurrencyCode;
  const isBill = inv.Type === "ACCPAY";
  const lines = inv.LineItems ?? [];
  const payments = inv.Payments ?? [];
  const date = xeroDate(inv.DateString, inv.Date);
  const due = xeroDate(inv.DueDateString, inv.DueDate);
  const taxNote =
    inv.LineAmountTypes === "Inclusive" ? "Amounts are tax inclusive" : inv.LineAmountTypes === "NoTax" ? "No tax" : "Amounts are tax exclusive";

  return (
    <div className="x-root">
      <div className="x-accent" />
      <div className="x-pad">
        <div className="x-head">
          <div style={{ minWidth: 0 }}>
            <div className="x-kind">{isBill ? "Bill" : "Invoice"}</div>
            <h1 className="x-title">{inv.InvoiceNumber || (isBill ? "Bill" : "Invoice")}</h1>
          </div>
          <span className="sp" />
          <StatusWord inv={inv} />
          <Tooltip title="Reload">
            <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} aria-label="Reload" onClick={() => load(inv.InvoiceID)} />
          </Tooltip>
          {/* the sandbox frame blocks popups: the host opens the link */}
          <Button size="small" icon={<ExportOutlined aria-hidden="true" />} onClick={() => tangram.openUrl(xeroUrl(inv))}>
            Open in Xero
          </Button>
        </div>

        <div className="x-facts">
          <div className="x-fact">
            <div className="k">{isBill ? "From" : "To"}</div>
            <div className="v">
              {inv.Contact?.ContactID ? (
                <button
                  type="button"
                  className="x-linkbtn"
                  title={inv.Contact.Name}
                  onClick={() => tangram.emit("open", { contactId: inv.Contact?.ContactID, name: inv.Contact?.Name ?? "" })}
                >
                  {inv.Contact.Name || "Contact"}
                </button>
              ) : (
                inv.Contact?.Name || "—"
              )}
            </div>
          </div>
          <div className="x-fact">
            <div className="k">Date</div>
            <div className="v" title={date ? date.format("D MMM YYYY") : ""}>{dateLabel(date)}</div>
          </div>
          <div className="x-fact">
            <div className="k">Due date</div>
            <div className="v" title={due ? due.format("D MMM YYYY") : ""}>{dateLabel(due)}</div>
          </div>
          <div className="x-fact">
            <div className="k">Reference</div>
            <div className="v" title={inv.Reference}>{inv.Reference || "—"}</div>
          </div>
          <div className="x-fact">
            <div className="k">Amount due</div>
            <div className="v">{money(inv.AmountDue, cur)}</div>
          </div>
        </div>

        {lines.length === 0 ? (
          <div className="x-card">
            <div className="x-empty">No line items</div>
          </div>
        ) : (
          <div className="x-card" style={{ overflowX: "auto" }}>
            {/* description keeps >= 180px beside the fixed columns (476px, or 280px once Account/Tax hide); narrower panels scroll */}
            <table className="x-table x-lines" style={{ minWidth: 656 }}>
              <colgroup>
                <col />
                <col style={{ width: 64 }} />
                <col style={{ width: 104 }} />
                <col className="x-hide-sm" style={{ width: 84 }} />
                <col className="x-hide-sm" style={{ width: 112 }} />
                <col style={{ width: 112 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="x-hide-sm">Account</th>
                  <th className="x-hide-sm">Tax rate</th>
                  <th className="num">Amount {cur ?? ""}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.LineItemID ?? i}>
                    <td title={l.Description}>{l.Description || "—"}</td>
                    <td className="num">{l.Quantity ?? "—"}</td>
                    <td className="num">{money(l.UnitAmount)}</td>
                    <td className="x-hide-sm muted" title={l.AccountCode}>{l.AccountCode || "—"}</td>
                    <td className="x-hide-sm muted" title={l.TaxType}>{l.TaxType || "—"}</td>
                    <td className="num">{money(l.LineAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="x-totals" aria-label="Totals">
          <div className="r">
            <span>Subtotal</span>
            <span>{money(inv.SubTotal)}</span>
          </div>
          <div className="r">
            <span>Total tax</span>
            <span>{money(inv.TotalTax)}</span>
          </div>
          <div className="r big">
            <span>Total {cur ?? ""}</span>
            <span>{money(inv.Total)}</span>
          </div>
          {inv.AmountCredited ? (
            <div className="r">
              <span>Less credits</span>
              <span>{money(inv.AmountCredited)}</span>
            </div>
          ) : null}
          <div className="r">
            <span>Less payments</span>
            <span>{money(inv.AmountPaid)}</span>
          </div>
          <div className="r due">
            <span>Amount due</span>
            <span>{money(inv.AmountDue)}</span>
          </div>
          <div className="r">
            <span className="x-faint">{taxNote}</span>
          </div>
        </div>

        <h2 className="x-h2">Payments</h2>
        {payments.length === 0 ? (
          <div className="x-faint">No payments recorded.</div>
        ) : (
          <div className="x-card">
            <table className="x-table">
              <colgroup>
                <col style={{ width: 120 }} />
                <col />
                <col style={{ width: 128 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th className="num">Amount {cur ?? ""}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p, i) => {
                  const d = xeroDate(undefined, p.Date);
                  return (
                    <tr key={p.PaymentID ?? i}>
                      <td className="muted">{dateLabel(d)}</td>
                      <td title={p.Reference}>{p.Reference || "—"}</td>
                      <td className="num">{money(p.Amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
