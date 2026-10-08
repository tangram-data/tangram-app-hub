# QuickBooks Online connector

Tangram OS ConnectorApp for the QuickBooks Online Accounting API (v3). Every request is scoped to the company file (realm) captured during OAuth: the
`realmId` arrives on the OAuth callback and is substituted into upstream paths (`/v3/company/{realmId}/...`) per operation — agents and clients never
handle it. The production host `quickbooks.api.intuit.com` is the default; installs may override the endpoint to `sandbox-quickbooks.api.intuit.com`
for Intuit sandbox companies.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `quickbooks_get_company` | `Company.Get` | Company profile; cheapest connection check. |
| `quickbooks_query_entity` | `Entity.Query` | The universal read — QuickBooks SQL-like SELECT over Purchase, Deposit, Transfer, Invoice, Bill, Payment, Account, Vendor, Customer, Attachable, ... |
| `quickbooks_create_purchase` | `Purchase.Create` | **Confirmation-gated.** Record an expense (Cash/Check/CreditCard) against a bank or credit-card account. Pass `requestid` (idempotency key, reused on retry) to avoid duplicates. |
| `quickbooks_update_purchase` | `Purchase.Update` | **Confirmation-gated.** Sparse update by `Id` + `SyncToken` (`sparse: true`) — e.g. set `PrivateNote` after a receipt match. |
| `quickbooks_upload_attachable` | `Attachable.Upload` | Upload the receipt file itself (multipart, streamed from the workspace files by volume reference) and attach it to transactions. |
| `quickbooks_create_attachable` | `Attachable.Create` | Attach a note-only attachable to transactions via `AttachableRef`. |
| `quickbooks_update_attachable` | `Attachable.Update` | **Confirmation-gated.** Full update by `Id` + `SyncToken` — fix a note or re-point it after a mis-match. |
| `quickbooks_delete_attachable` | `Attachable.Delete` | **Confirmation-gated.** Permanent — QuickBooks has no undo for deleted attachables. |
| `quickbooks_create_vendor` | `Vendor.Create` | Create a merchant/payee; query first to avoid `DisplayName` duplicates. |

## Receipt → transaction matching (agent workflow)

The connector is designed so an agent can reconcile a folder (or chat upload) of receipts against corporate bank/credit-card activity instead of a
human doing it one by one:

1. **Read the receipt** — the user uploads receipt images/PDFs into the chat (or a knowledge space); the agent extracts merchant, date, total, and
   last-4/card hints directly from the file.
2. **Find candidates** — `quickbooks_query_entity` with e.g.
   `select * from Purchase where TotalAmt = '42.17' and TxnDate >= '2026-07-01' and TxnDate <= '2026-07-15'`.
   Widen the date window, drop cents-exactness, or filter by `AccountRef` (from `select * from Account where AccountType in ('Bank','Credit Card')`)
   when the first pass is ambiguous. Vendor hints: `select * from Vendor where DisplayName like 'Uber%'`.
3. **Attach on match** — `quickbooks_upload_attachable` uploads the receipt file itself into QuickBooks (pass the chat attachment's volume reference
   as `file_content_01`; the platform streams the bytes server-side) with an `AttachableRef` to the matched `Purchase` Id. Use
   `quickbooks_create_attachable` for a note-only attachment, and optionally `quickbooks_update_purchase` to stamp `PrivateNote`
   (confirmation-gated). Check `select * from Attachable where AttachableRef.EntityRef.Type = 'purchase' and AttachableRef.EntityRef.value = '<id>'`
   first to avoid duplicate attachments.
4. **No match** — either flag for review, or (with user confirmation) `quickbooks_create_purchase` to record the missing expense, creating the vendor
   first if needed.

Binary upload requires a Tangram core build with connector multipart support (docs/connector-multipart-upload-design.md in the tangram repo); on
older cores, fall back to note-only attachables.

## OAuth setup

Create an app in the [Intuit developer portal](https://developer.intuit.com) with the **Accounting** scope (`com.intuit.quickbooks.accounting`) and add
the Tangram callback as a redirect URI:

```
https://<your-tangram-host>/api/core/v1/connector-oauth/callback/com.intuit/quickbooks
```

Store the app credentials as the global system secrets `quickbooksClientId` / `quickbooksClientSecret`. Token exchange uses HTTP Basic auth; access
tokens live ~1 hour and refresh automatically (refresh tokens rotate, ~100-day life). Connection scope is selectable at install: **WorkspaceShared**
(default — one shared connection to the corporate company file) or **PerUser**.

Sandbox: point the install's endpoint override at `https://sandbox-quickbooks.api.intuit.com` and connect a sandbox company created in the developer
portal (development client keys only work against sandbox realms).
