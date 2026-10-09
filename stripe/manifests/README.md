# Stripe connector (read-only)

Tangram OS ConnectorApp for the Stripe API — **read-only by design**. It answers revenue, billing and support questions (who paid, what failed,
which invoices are open, which subscriptions are past due) without any ability to move money. Writes (refunds, invoice changes, …) are out of
scope: Stripe takes form-encoded write bodies, which the connector gateway does not send, and money movement deserves its own reviewed integration.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `stripe_get_balance` | `Balance.Get` | Available/pending balance per currency. Connection check. |
| `stripe_search_customer` | `Customer.Search` | Stripe search syntax (`email:'jo@acme.com'`, `name~'acme'`). Also feeds Tangram's cross-app search (name or email contains the words). |
| `stripe_find_<object>` | `<Object>.Find` | Search payment intents, charges, invoices, subscriptions, products (e.g. `status:'open' AND total>5000`). |
| `stripe_list_<object>` | `<Object>.List` | Customers, payment intents, charges, invoices, subscriptions, refunds, disputes, payouts, products, prices, balance transactions — filters + `created[gte]`/`created[lte]`, cursor paging with `starting_after`. |
| `stripe_get_<object>` | `<Object>.Get` | One object by id; `expand[]` inlines related objects. |

Amounts are integers in the smallest currency unit (`4999` = $49.99). Search results can lag about a minute behind writes and are not available
for accounts in India — use `List` filters there.

## Setup

Create a **restricted key** in the Stripe Dashboard (Developers → API keys → Create restricted key) with **Read** on the resources above
(Balance, Customers, PaymentIntents, Charges, Invoices, Subscriptions, Refunds, Disputes, Payouts, Products, Prices, Balance transactions) and
nothing else, and enter it as the install secret `stripeApiKey`. The connection is shared by the workspace; use an `rk_test_…` key against test
mode. Never use a secret key (`sk_…`): it would grant write access the connector doesn't need.
