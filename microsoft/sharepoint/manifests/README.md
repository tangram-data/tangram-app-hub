# SharePoint connector

Tangram OS ConnectorApp for the Microsoft Graph SharePoint API. Proxies exactly one upstream host (`https://graph.microsoft.com`, pinned — not overridable at
install) and exposes SharePoint sites, lists, and document libraries behind the OAuth connection as agent tools. Read-only in this version — every operation
is a GET.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `sharepoint_search_site` | `Site.Search` | Keyword search over site names/descriptions (e.g. `search=contoso intranet`); returns site ids for the other tools. |
| `sharepoint_get_site` | `Site.Get` | One site by composite id (`hostname,siteCollectionId,siteId`), path (`hostname:/sites/name`), or `root` for the tenant root site. |
| `sharepoint_list_list` | `List.List` | A site's lists; `list.template` tells generic lists (`genericList`) from document libraries (`documentLibrary`). |
| `sharepoint_list_listitem` | `ListItem.List` | List items with `$expand=fields` for column values; page with `$top` + `@odata.nextLink`. |
| `sharepoint_get_listitem` | `ListItem.Get` | One item by `siteId` + `listId` + `itemId`, with `$expand=fields`. |
| `sharepoint_list_drive` | `Drive.List` | A site's document libraries; drive ids feed the DriveItem tools. |
| `sharepoint_list_driveitem` | `DriveItem.List` | Children of a folder; `itemId` = `root` for the library root, then descend with child ids. |
| `sharepoint_download_driveitem` | `DriveItem.Download` | Raw file bytes (Graph 302-redirects to a download URL); non-JSON results arrive as a typed `app_action_result` envelope — inline up to 32KB, otherwise a saved file. |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against the Microsoft identity platform. You need an Azure app registration, then the
client credentials stored in Tangram, then each user connects their own account.

### 1. Azure portal (Entra ID)

1. **App registrations → New registration.** Supported account types: *Accounts in any organizational directory* — this package's Graph APIs are not
   available to personal Microsoft accounts (or restrict to your tenant and change the manifest's `/common/` endpoints to `/{tenantId}/`).
2. Add a **Web** redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.microsoft/sharepoint
   ```

3. **Certificates & secrets → New client secret** — this is the value for `microsoftClientSecret` below.
4. **API permissions → Microsoft Graph → Delegated:** add `Sites.Read.All`. Admin consent is typically required for this permission — grant it once via
   *Grant admin consent* to spare every user the consent prompt.

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
into a single workspace. Connections default to **PerUser** — each user OAuths their own account; `WorkspaceShared` is allowed at install for a
shared service account.

## Notes

- Site ids come in two shapes and both work everywhere a `siteId` is expected: the composite `hostname,siteCollectionId,siteId` returned by search, or the
  server-relative path form `contoso.sharepoint.com:/sites/marketing`. The literal `root` addresses the tenant's root site.
- This version is read-only (`Sites.Read.All`); write access (`Sites.ReadWrite.All` plus list-item and file mutations) is planned for a later version.
- Graph paging is cursor-style: follow `@odata.nextLink` verbatim rather than computing offsets.
- `$filter` on non-indexed custom columns requires the `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly` header, which this connector does not send —
  fetch pages with `$top` and filter client-side instead.
