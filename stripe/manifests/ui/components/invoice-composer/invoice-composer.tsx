// Draft → lines → finalize → send, through the connector's write actions (each one confirmed by the host).
// New invoices are created with auto_advance:false so nothing finalizes, emails or charges on its own until the
// user finalizes (charge-automatically invoices are then collected by Stripe; emailed ones wait for Send); every
// create carries an Idempotency-Key that is reused on retry. Emits `saved` {invoiceId, status} after each step.
import { DeleteOutlined, ExportOutlined, FileTextOutlined, ReloadOutlined, SendOutlined } from "@ant-design/icons";
import { Button, Input, InputNumber, Select, Skeleton } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/stripe.css";
import "../../shared/tangram-buttons.css";
import ExtLink from "../../shared/ext-link";
import { dashboardUrl, day, errorText, invoiceStatus, isNotFound, money, safeUrl } from "../../shared/stripe-format";
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
  // the invoice the inputs asked for ("" = compose a new one)
  const [target, setTarget] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [deleted, setDeleted] = useState("");
  // true until the first onInput arrives, so no form flashes before the inputs are known
  const [loading, setLoading] = useState(true);
  // the shown invoice may be out of date (a refresh after a write failed): writes stay blocked until it reloads
  const [stale, setStale] = useState(false);
  // Writes in flight, by invoice id ("create" for a new draft). Kept across input changes so returning to an
  // invoice can't start a second write on it before the first settles; the tick re-renders on release.
  const inFlight = useRef(new Set<string>());
  const [, setLockTick] = useState(0);
  // invoice ids whose Delete got no clear answer: a not-found on reconcile means it was deleted
  const pendingDelete = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [method, setMethod] = useState<Method>("send_invoice");
  const [daysUntilDue, setDaysUntilDue] = useState<number>(30);
  const [description, setDescription] = useState("");
  // invoice ids this composer emailed; Send turns into an explicit Resend
  const [sent, setSent] = useState<Set<string>>(new Set());
  // successful sends per invoice: each completed send makes the next one a new logical request (new key)
  const sendAttempt = useRef(new Map<string, number>());
  const keys = useRef(new IdempotencyKeys());
  // drafts this composer created, by create payload — kept across input changes so a repeat create of the same
  // draft is offered as a resume instead of making another invoice
  const [createdDrafts, setCreatedDrafts] = useState<Record<string, string>>({});
  // bumped on every input change: results of reads/writes started earlier are dropped
  const gen = useRef(0);
  const seq = useRef(0);
  const stateRef = useRef<Record<string, unknown>>({});

  // Re-reads the invoice; true when it now matches Stripe. Ignored once the inputs moved on.
  const reload = useCallback(async (id: string, g: number): Promise<boolean> => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const inv: Invoice = await act("Invoice", "Get", { id });
      pendingDelete.current.delete(id);
      if (g !== gen.current || mine !== seq.current) return false;
      setInvoice(inv);
      setCustomerId(inv.customer);
      setStale(false);
      setError("");
      return true;
    } catch (e) {
      if (pendingDelete.current.has(id) && isNotFound(e)) {
        // the earlier Delete did go through
        pendingDelete.current.delete(id);
        if (g === gen.current && mine === seq.current) {
          tangram.emit("saved", { invoiceId: id, status: "deleted" });
          setDeleted(id);
          setInvoice(null);
          setStale(false);
          setError("");
        }
        return false;
      }
      if (g === gen.current && mine === seq.current) {
        setStale(true);
        setError(`Couldn't refresh the invoice: ${errorText(e)}`);
      }
      return false;
    } finally {
      if (g === gen.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const g = ++gen.current;
      const invoiceId = String(inputs?.invoiceId ?? "").trim();
      setTarget(invoiceId);
      setInvoice(null);
      setDeleted("");
      setError("");
      setStale(false);
      setSent(new Set());
      setCustomerId(String(inputs?.customerId ?? "").trim());
      if (invoiceId) reload(invoiceId, g);
      else {
        seq.current++;
        setLoading(false);
      }
    };
    // onInput fires as soon as the frame is initialised (getInputs() is async in the sandbox shell)
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
    outOfDate: stale,
    sent: invoice ? sent.has(invoice.id) : false,
  };
  useEffect(() => {
    tangram.provideState?.(() => ({ ...stateRef.current }));
  }, []);

  const lockKey = invoice?.id ?? (target || "create");
  const busy = inFlight.current.has(lockKey);

  // Runs one gated write for the current inputs; a result arriving after the inputs changed touches nothing.
  // Failures (including the user declining the host confirmation) show inline.
  async function run(step: (g: number, live: () => boolean) => Promise<unknown>): Promise<boolean> {
    const lock = lockKey;
    if (inFlight.current.has(lock)) return false;
    const g = gen.current;
    const live = () => g === gen.current;
    inFlight.current.add(lock);
    setLockTick((t) => t + 1);
    setError("");
    try {
      await step(g, live);
      return live();
    } catch (e) {
      if (live()) {
        setError(errorText(e));
        // The write may have happened even though no answer came back: nothing else may change until the
        // invoice reloads. Retrying the same request reuses its idempotency key.
        if (invoice) setStale(true);
      }
      return false;
    } finally {
      inFlight.current.delete(lock);
      setLockTick((t) => t + 1);
    }
  }

  // Applies a write's returned invoice at once, then reconciles with a fresh read.
  async function applied(inv: Invoice, g: number, live: () => boolean) {
    if (!live()) return;
    setInvoice(inv);
    setTarget(inv.id);
    tangram.emit("saved", { invoiceId: inv.id, status: inv.status });
    await reload(inv.id, g);
  }

  const createBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = { customer: customerId, auto_advance: false, collection_method: method };
    if (method === "send_invoice") body.days_until_due = daysUntilDue;
    if (description.trim()) body.description = description.trim();
    return body;
  };

  const createDraft = () =>
    run(async (g, live) => {
      const body = createBody();
      const key = keys.current.keyFor("create", body);
      const inv: Invoice = await act("Invoice", "Create", { "Idempotency-Key": key }, body);
      // recorded whatever the inputs did meanwhile: the draft exists either way
      setCreatedDrafts((prev) => ({ ...prev, [JSON.stringify(body)]: inv.id }));
      keys.current.done("create", body);
      await applied(inv, g, live);
    });

  const resume = (id: string) => {
    const g = ++gen.current;
    setTarget(id);
    setError("");
    reload(id, g);
  };

  const addLine = (line: LineBody) =>
    run(async (g, live) => {
      if (!invoice) return;
      const body = { customer: invoice.customer, invoice: invoice.id, ...line };
      const key = keys.current.keyFor("line", body);
      await act("InvoiceItem", "Create", { "Idempotency-Key": key }, body);
      keys.current.done("line", body);
      if (!live()) return;
      // the line exists; totals are unknown until the invoice reloads
      setStale(true);
      await reload(invoice.id, g);
    });

  const finalize = () =>
    run(async (g, live) => {
      if (!invoice) return;
      // Emailed invoices stay put until Send; charge-automatically ones need auto_advance for Stripe to collect.
      const autoAdvance = invoice.collection_method === "charge_automatically";
      const body = { auto_advance: autoAdvance };
      const slot = `finalize:${invoice.id}`;
      const key = keys.current.keyFor(slot, body);
      const inv: Invoice = await act("Invoice", "Finalize", { id: invoice.id, "Idempotency-Key": key }, body);
      keys.current.done(slot, body);
      await applied(inv, g, live);
    });

  const send = () =>
    run(async (g, live) => {
      if (!invoice) return;
      const id = invoice.id;
      const slot = `send:${id}`;
      const attempt = { attempt: sendAttempt.current.get(id) ?? 0 };
      const key = keys.current.keyFor(slot, attempt);
      const inv: Invoice = await act("Invoice", "Send", { id, "Idempotency-Key": key });
      keys.current.done(slot, attempt);
      // the next click is a deliberate resend (new key); a failed attempt keeps its key for the retry
      sendAttempt.current.set(id, (sendAttempt.current.get(id) ?? 0) + 1);
      if (!live()) return;
      setSent((prev) => new Set(prev).add(id));
      await applied(inv, g, live);
    });

  const remove = () =>
    run(async (_g, live) => {
      if (!invoice) return;
      pendingDelete.current.add(invoice.id);
      await act("Invoice", "Delete", { id: invoice.id });
      pendingDelete.current.delete(invoice.id);
      if (!live()) return;
      tangram.emit("saved", { invoiceId: invoice.id, status: "deleted" });
      seq.current++;
      setDeleted(invoice.id);
      setInvoice(null);
    });

  const retry = () => {
    const id = invoice?.id ?? target;
    if (id) reload(id, gen.current);
  };
  // writes need the requested invoice loaded and in sync with Stripe
  const locked = busy || loading || stale;

  const errorBox = error ? <div className="s-error inline">{error}</div> : null;

  if (deleted)
    return (
      <div className="s-root s-pad">
        <div className="s-ok">Draft invoice {deleted} deleted.</div>
      </div>
    );

  if (!invoice && (loading || target))
    return (
      <div className="s-root s-pad">
        {loading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
        {!loading ? <div className="s-error inline">{error || `Couldn't load invoice ${target}.`}</div> : null}
        {!loading ? (
          <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={retry}>
            Retry
          </Button>
        ) : null}
      </div>
    );

  if (!invoice) {
    const prior = createdDrafts[JSON.stringify(createBody())];
    const ready = !prior && /^cus_\w+$/.test(customerId) && (method === "charge_automatically" || daysUntilDue >= 0);
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
        {prior ? (
          <div className="s-warn" role="note">
            You already created this draft ({prior}).{" "}
            <Button size="small" disabled={busy} onClick={() => resume(prior)}>
              Resume it
            </Button>
          </div>
        ) : null}
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
        <ExtLink href={dashboardUrl("invoices", invoice.id, invoice.livemode)}>
          Open in Stripe <ExportOutlined aria-hidden="true" />
        </ExtLink>
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
      {stale ? (
        <div className="s-warn" role="status">
          This invoice may be out of date, so changes are paused until it reloads.{" "}
          <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} loading={loading} onClick={retry}>
            Refresh
          </Button>
        </div>
      ) : null}
      {draft ? <LineForm currency={invoice.currency} busy={locked} onAdd={addLine} /> : null}
      {draft && charges ? (
        <div className="s-warn" role="note">
          Finalizing charges the customer's saved payment method {money(invoice.amount_due, invoice.currency)} — Stripe collects it
          automatically right after. It can't be undone, only refunded.
        </div>
      ) : null}
      {invoice.status === "open" && !charges && safeUrl(invoice.hosted_invoice_url) ? (
        <div className="s-faint" style={{ margin: "8px 0" }}>
          Payment page:{" "}
          <ExtLink href={invoice.hosted_invoice_url}>hosted invoice</ExtLink>
        </div>
      ) : null}
      {errorBox}
      <div className="s-bar" style={{ marginTop: 12 }}>
        {draft ? (
          <Button danger icon={<DeleteOutlined aria-hidden="true" />} disabled={locked} onClick={remove}>
            Delete draft
          </Button>
        ) : null}
        <span className="sp" />
        {draft ? (
          <Button type="primary" loading={busy} disabled={lines.length === 0 || locked} onClick={finalize}>
            {charges ? "Finalize and charge" : "Finalize"}
          </Button>
        ) : null}
        {invoice.status === "open" && !charges && sent.has(invoice.id) ? (
          <>
            <span className="s-status" style={{ ["--dot" as any]: "#16a34a" }}>
              Sent to the customer
            </span>
            <Button icon={<SendOutlined aria-hidden="true" />} loading={busy} disabled={locked} onClick={send}>
              Resend
            </Button>
          </>
        ) : invoice.status === "open" && !charges ? (
          <Button type="primary" icon={<SendOutlined aria-hidden="true" />} loading={busy} disabled={locked} onClick={send}>
            Send invoice
          </Button>
        ) : null}
      </div>
    </div>
  );
}
