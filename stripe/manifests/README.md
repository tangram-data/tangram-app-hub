# Stripe connector

Tangram OS ConnectorApp for the Stripe API. It answers revenue, billing and support questions (who paid, what failed, which invoices are open,
which subscriptions are past due) and handles routine billing operations: customers, invoices, refunds and subscription cancellation. Every
write asks for confirmation, and the install's restricted key decides which writes Stripe accepts at all.

**Money can move.** No action creates a charge directly, but an invoice with `collection_method: charge_automatically` is charged to the
customer's saved payment method once it is finalized (by `Finalize`, or by Stripe itself about an hour after creation when `auto_advance` is
true), and an invoice item added without an `invoice` lands on the customer's next subscription invoice. Refunds return money immediately.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `stripe_get_balance` | `Balance.Get` | Available/pending balance per currency. Connection check. |
| `stripe_search_customer` | `Customer.Search` | Stripe search syntax (`email:'jo@acme.com'`, `name~'acme'`). Also feeds Tangram's cross-app search (name or email contains the words; queries under 3 characters skip Stripe). |
| `stripe_find_<object>` | `<Object>.Find` | Search payment intents, charges, invoices, subscriptions, products (e.g. `status:'open' AND total>5000`). |
| `stripe_list_<object>` | `<Object>.List` | Customers, payment intents, charges, invoices, subscriptions, refunds, disputes, payouts, products, prices, balance transactions — filters + `created[gte]`/`created[lte]`, cursor paging with `starting_after`. |
| `stripe_get_<object>` | `<Object>.Get` | One object by id; `expand[]` inlines related objects. |
| `stripe_create_customer` / `stripe_update_customer` | `Customer.Create` / `.Update` | **Confirmation-gated.** Name, email, description, phone, metadata. |
| `stripe_create_invoice` | `Invoice.Create` | **Confirmation-gated.** Draft for a customer; `auto_advance: false` keeps it a draft until Finalize. |
| `stripe_create_invoiceitem` | `InvoiceItem.Create` | **Confirmation-gated, irreversible.** A line on a draft invoice — or, without `invoice`, on the customer's next subscription invoice. |
| `stripe_finalize_invoice` / `stripe_send_invoice` / `stripe_void_invoice` / `stripe_delete_invoice` | `Invoice.*` | **Confirmation-gated, irreversible.** Finalize makes it payable; Send emails it; Void cancels a finalized invoice; Delete removes a draft. |
| `stripe_create_refund` | `Refund.Create` | **Confirmation-gated, irreversible.** Full or partial refund of a charge or payment intent. |
| `stripe_update_subscription` / `stripe_cancel_subscription` | `Subscription.Update` / `.Cancel` | **Confirmation-gated, irreversible.** `cancel_at_period_end`, metadata; Cancel stops billing now. |

Writes are sent form-encoded (Stripe's format) — the platform encodes the JSON arguments. Every create takes an `Idempotency-Key` header
parameter: use a unique key per logical request and reuse it on a retry, so Stripe returns the first result instead of acting twice.

Requests pin `Stripe-Version: 2024-06-20`. Amounts are integers in the smallest currency unit (`4999` = $49.99). Search results can lag about a minute behind writes and are not available
for accounts in India — use `List` filters there.

## Setup

Create a **restricted key** in the Stripe Dashboard (Developers → API keys → Create restricted key) and enter it as the install secret
`stripeApiKey`. Give it **Read** on Balance, Customers, PaymentIntents, Charges, Invoices, Subscriptions, Refunds, Disputes, Payouts, Products,
Prices and Balance transactions, and **Write** only where the agent may act: Customers, Invoices (covers invoice items), Refunds, Subscriptions.
Leave Write off to keep the connector read-only — Stripe then rejects every write. The connection is shared by the workspace; use an
`rk_test_…` key against test mode first. Never use a secret key (`sk_…`).
