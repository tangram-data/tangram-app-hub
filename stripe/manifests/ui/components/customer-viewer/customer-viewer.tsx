// One Stripe customer at a glance: profile facts, then recent payments, invoices and subscriptions as quiet
// tables, all through the connector's read actions. An invoice row emits `open` {invoiceId} for the host/agent.
import { ExportOutlined, ReloadOutlined, UserOutlined } from "@ant-design/icons";
import { Button, Skeleton, Tooltip } from "antd";
import ExtLink from "../../shared/ext-link";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/stripe.css";
import "../../shared/tangram-buttons.css";
import {
  dashboardUrl,
  day,
  errorText,
  invoiceStatus,
  money,
  paymentStatus,
  stableJson,
  Status,
  subscriptionStatus,
  when,
} from "../../shared/stripe-format";

const tangram = (window as any).tangram;

type Customer = {
  id: string;
  name?: string | null;
  email?: string | null;
  description?: string | null;
  created?: number;
  balance?: number;
  currency?: string | null;
  livemode?: boolean;
  delinquent?: boolean;
  metadata?: Record<string, string>;
};
type PaymentIntent = { id: string; amount: number; currency: string; status: string; created: number; description?: string | null };
type Invoice = {
  id: string;
  number?: string | null;
  total: number;
  currency: string;
  status?: string;
  due_date?: number | null;
  created: number;
  hosted_invoice_url?: string | null;
};
type Subscription = {
  id: string;
  status: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  items?: { data?: { price?: { id: string; nickname?: string | null; unit_amount?: number | null; currency?: string } }[] };
};
type Section<T> = { state: "loading" | "ready" | "error"; rows: T[]; error?: string; more?: boolean };

const loading = <T,>(): Section<T> => ({ state: "loading", rows: [] });

function read(resourceType: string, action: string, parameters: Record<string, unknown>) {
  return tangram.performAction({ resourceType, action }, { parameters });
}

function Dot({ s }: { s: Status }) {
  return (
    <span className={`s-status${s.bad ? " bad" : ""}`} style={{ ["--dot" as any]: s.color }}>
      {s.bad ? <b>{s.word}</b> : s.word}
    </span>
  );
}

function SectionBody<T>({
  title,
  section,
  empty,
  onRetry,
  children,
}: {
  title: string;
  section: Section<T>;
  empty: string;
  onRetry: () => void;
  children: (rows: T[]) => React.ReactNode;
}) {
  return (
    <section className="s-section" aria-label={title}>
      <h3>
        {title}
        {section.state === "ready" ? (
          <span className="n">
            {section.rows.length}
            {section.more ? "+" : ""}
          </span>
        ) : null}
      </h3>
      {section.state === "loading" ? (
        <Skeleton active title={false} paragraph={{ rows: 2 }} />
      ) : section.state === "error" ? (
        <div className="s-error inline">
          {section.error}{" "}
          <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : section.rows.length === 0 ? (
        <div className="s-empty">{empty}</div>
      ) : (
        children(section.rows)
      )}
    </section>
  );
}

export default function CustomerViewer() {
  const [customerId, setCustomerId] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [payments, setPayments] = useState<Section<PaymentIntent>>(loading());
  const [invoices, setInvoices] = useState<Section<Invoice>>(loading());
  const [subs, setSubs] = useState<Section<Subscription>>(loading());
  const seq = useRef(0);

  // One section's read; a retry runs under the current customer load and is dropped if that load moved on.
  const sectionSeq = useRef<Record<string, number>>({});
  const loadSection = useCallback((name: "payments" | "invoices" | "subs", id: string, loadId: number) => {
    const mine = (sectionSeq.current[name] = (sectionSeq.current[name] ?? 0) + 1);
    const live = () => loadId === seq.current && mine === sectionSeq.current[name];
    const run = <T,>(p: Promise<{ data?: T[]; has_more?: boolean }>, set: (s: Section<T>) => void) => {
      set(loading());
      p.then((r) => live() && set({ state: "ready", rows: r?.data ?? [], more: !!r?.has_more })).catch(
        (e: unknown) => live() && set({ state: "error", rows: [], error: errorText(e) }),
      );
    };
    if (name === "payments") run(read("PaymentIntent", "List", { customer: id, limit: 10 }), setPayments);
    else if (name === "invoices") run(read("Invoice", "List", { customer: id, limit: 10 }), setInvoices);
    else run(read("Subscription", "List", { customer: id, status: "all", limit: 10 }), setSubs);
  }, []);
  const load = useCallback((id: string) => {
    const mine = ++seq.current;
    const live = () => mine === seq.current;
    setCustomerId(id);
    setCustomer(null);
    setError("");
    if (!id) {
      setState("idle");
      return;
    }
    setState("loading");
    setPayments(loading());
    setInvoices(loading());
    setSubs(loading());
    read("Customer", "Get", { id })
      .then((c: Customer) => {
        if (!live()) return;
        if ((c as any)?.deleted) {
          setError("This customer was deleted in Stripe.");
          setState("error");
          return;
        }
        setCustomer(c);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (!live()) return;
        setError(errorText(e));
        setState("error");
      });
    loadSection("payments", id, mine);
    loadSection("invoices", id, mine);
    loadSection("subs", id, mine);
  }, []);

  const retrySection = (name: "payments" | "invoices" | "subs") => loadSection(name, customerId, seq.current);

  useEffect(() => {
    let last: string | undefined;
    const apply = (inputs: Record<string, unknown>) => {
      // the shell re-sends the same inputs on token renewal: keep what's on screen
      const sig = stableJson(inputs);
      if (sig === last) return;
      last = sig;
      load(String(inputs?.customerId ?? "").trim());
    };
    // onInput fires as soon as the frame is initialised (getInputs() is async in the sandbox shell)
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  function openInvoice(inv: Invoice) {
    tangram.emit("open", { invoiceId: inv.id });
  }

  if (state === "idle") return <div className="s-root s-pad s-muted">No customer selected.</div>;
  if (state === "error")
    return (
      <div className="s-root">
        <div className="s-error">
          <b>Couldn't load customer {customerId}</b>
          {error ? <div>{error}</div> : null}
          <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} style={{ marginTop: 8 }} onClick={() => load(customerId)}>
            Retry
          </Button>
        </div>
      </div>
    );

  const c = customer;
  const meta = Object.entries(c?.metadata ?? {});
  return (
    <div className="s-root">
      <header className="s-head">
        <div className="sp">
          <div className="s-kind">
            <UserOutlined aria-hidden="true" /> Customer
            {c?.livemode === false ? <span className="s-tag">Test mode</span> : null}
            {c?.delinquent ? <span className="s-status bad" style={{ ["--dot" as any]: "#df1b41" }}><b>Delinquent</b></span> : null}
          </div>
          {state === "loading" || !c ? (
            <Skeleton active title paragraph={{ rows: 1 }} />
          ) : (
            <>
              <h1 className="s-title" title={c.name ?? c.email ?? c.id}>
                {c.name || c.email || c.id}
              </h1>
              <div className="s-sub" title={c.email ?? ""}>
                {c.name && c.email ? c.email : ""} <span className="s-mono s-faint">{c.id}</span>
              </div>
            </>
          )}
        </div>
        {c ? (
          <>
            <Tooltip title="Refresh">
              <Button size="small" aria-label="Refresh" icon={<ReloadOutlined aria-hidden="true" />} onClick={() => load(customerId)} />
            </Tooltip>
            <ExtLink href={dashboardUrl("customers", c.id, c.livemode)}>
              Open in Stripe <ExportOutlined aria-hidden="true" />
            </ExtLink>
          </>
        ) : null}
      </header>
      {c ? (
        <div className="s-facts">
          <div className="s-fact">
            <div className="k">Customer since</div>
            <div className="v">{day(c.created)}</div>
          </div>
          <div className="s-fact">
            <div className="k">Balance</div>
            <div className="v" title="Negative is credit the customer can spend">
              {c.currency ? money(c.balance ?? 0, c.currency) : "—"}
            </div>
          </div>
          <div className="s-fact">
            <div className="k">Currency</div>
            <div className="v">{c.currency ? c.currency.toUpperCase() : "—"}</div>
          </div>
          {c.description ? (
            <div className="s-fact">
              <div className="k">Description</div>
              <div className="v" title={c.description}>
                {c.description}
              </div>
            </div>
          ) : null}
          {meta.length ? (
            <div className="s-fact" style={{ gridColumn: "1 / -1" }}>
              <div className="k">Metadata</div>
              <div className="s-meta">
                {meta.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <span className="k s-mono">{k}</span>
                    <span title={v}>{v}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <SectionBody title="Payments" section={payments} empty="No payments yet." onRetry={() => retrySection("payments")}>
        {(rows) => (
          <table className="s-table">
            <colgroup>
              <col style={{ width: 120 }} />
              <col />
              <col style={{ width: 130 }} />
              <col style={{ width: 120 }} />
            </colgroup>
            <thead>
              <tr>
                <th className="num">Amount</th>
                <th>Description</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="num">{money(p.amount, p.currency)}</td>
                  <td className="s-muted" title={p.description ?? p.id}>
                    {p.description || <span className="s-mono">{p.id}</span>}
                  </td>
                  <td>
                    <Dot s={paymentStatus(p.status)} />
                  </td>
                  <td className="s-mono s-muted">{when(p.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionBody>

      <SectionBody title="Invoices" section={invoices} empty="No invoices yet." onRetry={() => retrySection("invoices")}>
        {(rows) => (
          <table className="s-table">
            <colgroup>
              <col />
              <col style={{ width: 120 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 70 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Number</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th>Due</th>
                <th aria-label="Link" />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr
                  key={inv.id}
                  className="click"
                  tabIndex={0}
                  onClick={() => openInvoice(inv)}
                  onKeyDown={(e) => {
                    // only the row itself: Enter on the View link inside opens the page, not the invoice
                    if (e.key === "Enter" && e.target === e.currentTarget) openInvoice(inv);
                  }}
                >
                  <td title={inv.number ?? inv.id}>
                    {inv.number ? inv.number : <span className="s-mono">{inv.id}</span>}
                  </td>
                  <td className="num">{money(inv.total, inv.currency)}</td>
                  <td>
                    <Dot s={invoiceStatus(inv.status, inv.due_date)} />
                  </td>
                  <td className="s-muted">{day(inv.due_date)}</td>
                  <td>
                    {inv.hosted_invoice_url ? <ExtLink href={inv.hosted_invoice_url}>View</ExtLink> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionBody>

      <SectionBody title="Subscriptions" section={subs} empty="No subscriptions." onRetry={() => retrySection("subs")}>
        {(rows) => (
          <table className="s-table">
            <colgroup>
              <col />
              <col style={{ width: 130 }} />
              <col style={{ width: 190 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Status</th>
                <th>Current period ends</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const price = s.items?.data?.[0]?.price;
                const extra = (s.items?.data?.length ?? 0) - 1;
                const label = price?.nickname || price?.id || s.id;
                return (
                  <tr key={s.id}>
                    <td title={label}>
                      {label}
                      {price?.unit_amount != null ? (
                        <span className="s-faint"> · {money(price.unit_amount, price.currency)}</span>
                      ) : null}
                      {extra > 0 ? <span className="s-faint"> +{extra} more</span> : null}
                    </td>
                    <td>
                      <Dot s={subscriptionStatus(s.status)} />
                    </td>
                    <td className="s-muted">
                      {day(s.current_period_end)}
                      {s.cancel_at_period_end ? <span className="s-faint"> · cancels then</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionBody>
      <div style={{ height: 16 }} />
    </div>
  );
}
