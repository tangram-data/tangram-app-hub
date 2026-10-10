# Xero connector

Tangram OS ConnectorApp for the Xero Accounting API. Xero serves every organisation from one host and picks the organisation by the
`xero-tenant-id` header. The install setting **`organisationName`** (e.g. `Acme Ltd`, matched case-insensitively) says which one: when an account
connects, the platform looks that organisation up in Xero's `GET /connections`, stores its tenant id on the connection, and injects the header on
every call. Connecting fails for an account without access to that organisation, or when two organisations it authorised share the name (rename one in
Xero). Names containing an apostrophe aren't supported yet.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `xero_get_organisation` | `Organisation.Get` | Connection check; currency, year end, tax settings. |
| `xero_search_contact` | `Contact.Search` | `searchTerm` over name/email/account number, `where`, paging. Also feeds Tangram's cross-app search. |
| `xero_get_contact` / `xero_create_contact` | `Contact.Get` / `Contact.Create` | Create: `Name` must be unique — search first. |
| `xero_list_invoice` / `xero_get_invoice` | `Invoice.List` / `Invoice.Get` | Sales invoices (`ACCREC`) and bills (`ACCPAY`); filter by `Statuses`, `ContactIDs`, `where`. |
| `xero_create_invoice` | `Invoice.Create` | **Confirmation-gated.** `DRAFT` by default; `AUTHORISED` posts to the ledger. |
| `xero_list_payment` / `xero_list_banktransaction` / `xero_list_account` | `…List` | Payments, bank transactions, chart of accounts. |
| `xero_profitandloss_report` / `xero_balancesheet_report` / `xero_trialbalance_report` | `Report.*` | Financial reports with date ranges and comparison periods. |

`where` uses Xero's filter syntax, e.g. `Type=="ACCREC" AND Status=="AUTHORISED" AND DueDate<DateTime(2026,10,10)`. Xero allows 60 calls a minute and
5,000 a day per organisation.

## OAuth setup

Create a **Web app** in the [Xero developer portal](https://developer.xero.com/app/manage) with the redirect URI

```
https://<your-tangram-host>/api/core/v1/connector-oauth/callback/com.xero/xero
```

Store the client id/secret as the global system secrets `xeroClientId` / `xeroClientSecret`. Scopes requested (granular, as Xero requires for apps
created from March 2026): `offline_access`, `accounting.invoices`, `accounting.payments.read`, `accounting.banktransactions.read`,
`accounting.contacts`, `accounting.settings.read`, `accounting.reports.profitandloss.read`, `accounting.reports.balancesheet.read`,
`accounting.reports.trialbalance.read`. Access tokens last 30 minutes and refresh
automatically (rotating refresh tokens, 60-day life); disconnect revokes the grant. Connection scope: **WorkspaceShared** (default — one bookkeeping
connection) or **PerUser**.
