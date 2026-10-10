// Draft → lines → finalize → send, through the connector's write actions (each one confirmed by the host).
// New invoices are created with auto_advance:false so nothing finalizes, emails or charges on its own until the
// user finalizes (charge-automatically invoices are then collected by Stripe; emailed ones wait for Send); every
// create carries an Idempotency-Key that is reused on retry. Emits `saved` {invoiceId, status} after each step.
import { DeleteOutlined, ExportOutlined, FileTextOutlined, SendOutlined } from "@ant-design/icons";
import { Button, Input, InputNumber, Select, Skeleton } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/stripe.css";
import "../../shared/tangram-buttons.css";
import { dashboardUrl, day, errorText, invoiceStatus, money } from "../../shared/stripe-format";
import { IdempotencyKeys } from "./idempotency";
import LineForm, { LineBody } from "./line-form";

const tangram = (window as any).tangram;

type Line = { id: string; description?: string | null; amount: number; currency: string; quantity?: number | null };
type Invoice = {
  id: string;
  number?: string | null;
  customer: string;
  customer_name?: string | null;
  customer_email?: string | null;
  status: string;
  currency: string;
  collection_method: "charge_automatically" | "send_invoice";
  due_date?: number | null;
  total: number;
  amount_due: number;
  description?: string | null;
  livemode?: boolean;
  hosted_invoice_url?: string | null;
  lines?: { data?: Line[]; has_more?: boolean };
};
type Method = Invoice["collection_method"];

function act(resourceType: string, action: string, parameters: Record<string, unknown>, requestBody?: unknown) {
  return tangram.performAction({ resourceType, action }, requestBody === undefined ? { parameters } : { parameters, requestBody });
}

export default function InvoiceComposer() {
  const [customerId, setCustomerId] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [deleted, setDeleted] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [method, setMethod] = useState<Method>("send_invoice");
  const [daysUntilDue, setDaysUntilDue] = useState<number>(30);
  const [description, setDescription] = useState("");
  const keys = useRef(new IdempotencyKeys());
  const seq = useRef(0);
  const stateRef = useRef<Record<string, unknown>>({});

  const reload = useCallback((id: string) => {
    const mine = ++seq.current;
    setLoading(true);
    return act("Invoice", "Get", { id })
      .then((inv: Invoice) => {
        if (mine !== seq.current) return;
        setInvoice(inv);
        setCustomerId(inv.customer);
        setError("");
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setError(errorText(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const invoiceId = String(inputs?.invoiceId ?? "").trim();
      setDeleted("");
      setError("");
      if (invoiceId) reload(invoiceId);
      else {
        seq.current++;
        setInvoice(null);
        setLoading(false);
        setCustomerId(String(inputs?.customerId ?? "").trim());
      }
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [reload]);

  stateRef.current = {
    customerId,
    invoiceId: invoice?.id ?? null,
    status: deleted ? "deleted" : (invoice?.status ?? "not created"),
    collectionMethod: invoice?.collection_method ?? method,
    currency: invoice?.currency ?? null,
    total: invoice?.total ?? null,
    lines: (invoice?.lines?.data ?? []).map((l) => ({ description: l.description, amount: l.amount, quantity: l.quantity })),
  };
  useEffect(() => {
    tangram.provideState?.(() => ({ ...stateRef.current }));
  }, []);

  // Runs one gated write; reports failures inline (including the user declining the host confirmation).
  async function run(step: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await step();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const createDraft = () =>
    run(async () => {
      const body: Record<string, unknown> = { customer: customerId, auto_advance: false, collection_method: method };
      if (method === "send_invoice") body.days_until_due = daysUntilDue;
      if (description.trim()) body.description = description.trim();
      const key = keys.current.keyFor("create", body);
      const inv: Invoice = await act("Invoice", "Create", { "Idempotency-Key": key }, body);
      keys.current.done("create");
      setInvoice(inv);
      tangram.emit("saved", { invoiceId: inv.id, status: inv.status });
      await reload(inv.id);
    });

  const addLine = (line: LineBody) =>
    run(async () => {
      if (!invoice) return;
      const body = { customer: invoice.customer, invoice: invoice.id, ...line };
      const key = keys.current.keyFor("line", body);
      await act("InvoiceItem", "Create", { "Idempotency-Key": key }, body);
      keys.current.done("line");
      await reload(invoice.id);
    });

  const finalize = () =>
    run(async () => {
      if (!invoice) return;
      // Emailed invoices stay put until Send; charge-automatically ones need auto_advance for Stripe to collect.
      const autoAdvance = invoice.collection_method === "charge_automatically";
      const inv: Invoice = await act("Invoice", "Finalize", { id: invoice.id }, { auto_advance: autoAdvance });
      tangram.emit("saved", { invoiceId: inv.id, status: inv.status });
      await reload(invoice.id);
    });

  const send = () =>
    run(async () => {
      if (!invoice) return;
      const inv: Invoice = await act("Invoice", "Send", { id: invoice.id });
      tangram.emit("saved", { invoiceId: inv.id, status: inv.status });
      await reload(invoice.id);
    });

  const remove = () =>
    run(async () => {
      if (!invoice) return;
      await act("Invoice", "Delete", { id: invoice.id });
      seq.current++;
      setDeleted(invoice.id);
      tangram.emit("saved", { invoiceId: invoice.id, status: "deleted" });
      setInvoice(null);
    });

  const errorBox = error ? <div className="s-error inline">{error}</div> : null;

  if (deleted)
    return (
      <div className="s-root s-pad">
        <div className="s-ok">Draft invoice {deleted} deleted.</div>
      </div>
    );

  if (loading && !invoice)
    return (
      <div className="s-root s-pad">
        <Skeleton active paragraph={{ rows: 4 }} />
        {errorBox}
      </div>
    );

  if (!invoice) {
    const ready = /^cus_\w+$/.test(customerId) && (method === "charge_automatically" || daysUntilDue >= 0);
    return (
      <div className="s-root s-pad">
        <div className="s-steps" aria-label="Steps">
          <span className="on">1 Draft</span>›<span>2 Lines</span>›<span>3 Finalize</span>
        </div>
        <h1 className="s-title" style={{ marginBottom: 16 }}>
          New invoice
        </h1>
        <div className="s-form">
          <label htmlFor="s-cus">Customer</label>
          <Input id="s-cus" placeholder="cus_…" value={customerId} disabled={busy} onChange={(e) => setCustomerId(e.target.value.trim())} />
          <label htmlFor="s-method">Payment</label>
          <Select<Method>
            id="s-method"
            value={method}
            disabled={busy}
            onChange={setMethod}
            options={[
              { value: "send_invoice", label: "Email invoice to the customer" },
              { value: "charge_automatically", label: "Charge saved payment method" },
            ]}
          />
          {method === "send_invoice" ? (
            <>
              <label htmlFor="s-days">Due in (days)</label>
              <InputNumber id="s-days" min={0} precision={0} value={daysUntilDue} disabled={busy} onChange={(v) => setDaysUntilDue(Number(v) || 0)} />
            </>
          ) : null}
          <label htmlFor="s-memo">Memo</label>
          <Input.TextArea id="s-memo" autoSize={{ minRows: 2, maxRows: 5 }} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <p className="s-faint" style={{ margin: "12px 0" }}>
          The draft stays a draft: it won't be finalized, emailed or charged until you finalize it here.
        </p>
        {errorBox}
        <div className="s-bar">
          <span className="sp" />
          <Button type="primary" icon={<FileTextOutlined aria-hidden="true" />} loading={busy} disabled={!ready} onClick={createDraft}>
            Create draft
          </Button>
        </div>
      </div>
    );
  }

  const st = invoiceStatus(invoice.status, invoice.due_date);
  const lines = invoice.lines?.data ?? [];
  const draft = invoice.status === "draft";
  const charges = invoice.collection_method === "charge_automatically";
  return (
    <div className="s-root s-pad">
      <div className="s-steps" aria-label="Steps">
        <span className={draft ? "on" : ""}>1 Draft</span>›<span className={draft ? "on" : ""}>2 Lines</span>›
        <span className={!draft ? "on" : ""}>3 {invoice.status === "open" && !charges ? "Send" : "Finalize"}</span>
      </div>
      <div className="s-bar" style={{ marginBottom: 4 }}>
        <h1 className="s-title" style={{ margin: 0 }}>
          {invoice.number || "Draft invoice"}
        </h1>
        <span className={`s-status${st.bad ? " bad" : ""}`} style={{ ["--dot" as any]: st.color }}>
          {st.word}
        </span>
        <span className="sp" />
        <a href={dashboardUrl("invoices", invoice.id, invoice.livemode)} target="_blank" rel="noopener noreferrer">
          Open in Stripe <ExportOutlined aria-hidden="true" />
        </a>
      </div>
      <div className="s-sub" style={{ marginBottom: 12 }}>
        {invoice.customer_name || invoice.customer_email || invoice.customer} ·{" "}
        {charges ? "charges saved payment method" : `emailed, due ${invoice.due_date ? day(invoice.due_date) : "on receipt"}`}
      </div>
      <table className="s-table">
        <colgroup>
          <col />
          <col style={{ width: 70 }} />
          <col style={{ width: 130 }} />
        </colgroup>
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={3} className="s-faint">
                No lines yet.
              </td>
            </tr>
          ) : (
            lines.map((l) => (
              <tr key={l.id}>
                <td title={l.description ?? ""}>{l.description || <span className="s-mono">{l.id}</span>}</td>
                <td className="num">{l.quantity ?? 1}</td>
                <td className="num">{money(l.amount, l.currency)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {invoice.lines?.has_more ? <div className="s-faint">More lines in Stripe.</div> : null}
      <div className="s-total">
        <span className="s-muted">Total</span>
        <span>{money(invoice.total, invoice.currency)}</span>
      </div>
      {draft ? <LineForm currency={invoice.currency} busy={busy || loading} onAdd={addLine} /> : null}
      {draft && charges ? (
        <div className="s-warn" role="note">
          Finalizing charges the customer's saved payment method {money(invoice.amount_due, invoice.currency)} — Stripe collects it
          automatically right after. It can't be undone, only refunded.
        </div>
      ) : null}
      {invoice.status === "open" && !charges && invoice.hosted_invoice_url ? (
        <div className="s-faint" style={{ margin: "8px 0" }}>
          Payment page:{" "}
          <a href={invoice.hosted_invoice_url} target="_blank" rel="noopener noreferrer">
            hosted invoice
          </a>
        </div>
      ) : null}
      {errorBox}
      <div className="s-bar" style={{ marginTop: 12 }}>
        {draft ? (
          <Button danger icon={<DeleteOutlined aria-hidden="true" />} disabled={busy} onClick={remove}>
            Delete draft
          </Button>
        ) : null}
        <span className="sp" />
        {draft ? (
          <Button type="primary" loading={busy} disabled={lines.length === 0 || loading} onClick={finalize}>
            {charges ? "Finalize and charge" : "Finalize"}
          </Button>
        ) : null}
        {invoice.status === "open" && !charges ? (
          <Button type="primary" icon={<SendOutlined aria-hidden="true" />} loading={busy} disabled={loading} onClick={send}>
            Send invoice
          </Button>
        ) : null}
      </div>
    </div>
  );
}
