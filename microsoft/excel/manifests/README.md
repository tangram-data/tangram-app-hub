# Excel connector

Tangram OS ConnectorApp for the Microsoft Graph Excel workbook API. Proxies exactly one upstream host (`https://graph.microsoft.com`, pinned — not
overridable at install) and exposes workbook ranges and tables behind the OAuth connection as agent tools. Operations address workbooks by
`driveId` + `itemId`, so they reach the connected account's OneDrive and any SharePoint document library the account can access — always through the
caller's own OAuth token.

## Finding a workbook

This connector has **no file listing** — it operates on a workbook's drive `itemId`, exactly like the Google Sheets connector relies on the Drive
connector for discovery. Find the workbook first with the onedrive connector (`onedrive_search_driveitem`), then pass its `itemId` to every Excel tool.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `excel_list_worksheet` | `Worksheet.List` | Worksheets (tabs) with ids, names, positions, visibility. |
| `excel_get_range` | `Range.Get` | Read a range by A1 address (e.g. `A1:D20` — no `Sheet1!` prefix; the worksheet is named in the path). |
| `excel_getused_range` | `Range.GetUsed` | The non-empty rectangle — read a whole sheet without knowing its size. |
| `excel_update_range` | `Range.Update` | **Confirmation-gated.** Overwrites the range; `values` dimensions must match the address; strings starting with `=` become formulas. |
| `excel_list_table` | `Table.List` | Tables across all worksheets, with ids and names. |
| `excel_addrows_table` | `Table.AddRows` | Append-only — rows land at the end of the table, never overwriting existing data (like `sheets_appendvalues`). |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against the Microsoft identity platform. You need an Azure app registration, then the
client credentials stored in Tangram, then each user connects their own account.

### 1. Azure portal (Entra ID)

1. **App registrations → New registration.** Supported account types: *Accounts in any organizational directory* — this package's Graph APIs are not
   available to personal Microsoft accounts (or restrict to your tenant and change the manifest's `/common/` endpoints to `/{tenantId}/`).
2. Add a **Web** redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.microsoft/excel
   ```

3. **Certificates & secrets → New client secret** — this is the value for `microsoftClientSecret` below.
4. **API permissions → Microsoft Graph → Delegated:** add `Files.ReadWrite`. The workbook API needs write access to the file even for range updates and
   table row adds; it is not admin-restricted by default, but many tenants require admin consent — grant it once via *Grant admin consent* to spare every
   user the consent prompt.

You do **not** need to request offline access manually — the manifest includes the `offline_access` scope (`api/spec.pkl`), which is what makes Azure AD issue
a refresh token. Tokens are refreshed automatically (10-minute refresh window before expiry).

### 2. Tangram publisher credentials

The manifest references two Tangram system secrets (shared by the whole `com.microsoft` connector family, so one Azure app registration serves
outlook, teams, onedrive, sharepoint, and excel — put the union of their delegated scopes on that single registration):

- `microsoftClientId` — the app registration's *Application (client) ID*
- `microsoftClientSecret` — the client secret value

Set them in **Settings → Connector OAuth** (publisher credentials; they are stored in the `tangram_os` system workspace). This works pre-install — the
credentials are resolved from the app catalog, so you can configure them before or after installing the app.

### 3. Install

Install it either globally (shared `tangram_os_shared` workspace, usable from every workspace) or
into a single workspace. Connections default to **PerUser** — each user OAuths their own OneDrive; `WorkspaceShared` is allowed at install for a
shared service account.

## Notes

- Workbook sessions (`workbook-session-id` header) are **not** used — every call is sessionless and commits immediately, at the cost of some per-call
  overhead on large workbooks.
- Large ranges: prefer `excel_getused_range` or a bounded address over guessing huge ranges; Graph rejects oversized payloads.
- Range addresses in these tools are sheet-relative (`A1:C10`) because the worksheet is already named in the path; the `Sheet1!A1:C10` form appears only in
  response `address` fields.
- All paths use the `/drives/{driveId}/items/{itemId}` form: pass the user's own OneDrive driveId (any onedrive item's `parentReference.driveId`) or a SharePoint document library id from `sharepoint_list_drive`.
