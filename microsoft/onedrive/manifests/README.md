# OneDrive connector

Tangram OS ConnectorApp for the Microsoft Graph drive API. Proxies exactly one upstream host (`https://graph.microsoft.com`, pinned — not overridable at
install) and is **read-only**: browsing, search, metadata, and content download. All operations are pinned to `/me/drive`, so a caller can only see the
connected account's files (plus items shared with it).

It is the discovery connector for the `com.microsoft` family (the same role Google's `drive` connector plays for the Workspace connectors): Word and
PowerPoint have no content-editing Graph API, so reading them goes through `onedrive_download_driveitem` with `format=pdf`, and Excel workbooks found here
feed the excel connector, whose tools take the workbook's `itemId`.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `onedrive_list_driveitem` | `DriveItem.List` | Children of a folder; `itemId` `root` lists the drive root, folder ids from previous calls drill down. `$top`, `$select`, `$orderby` (e.g. `name asc`). |
| `onedrive_search_driveitem` | `DriveItem.Search` | Free-text search over names and content across the whole drive, **including items shared with the user** — shared hits carry a `remoteItem` facet with the real `driveId` + `id` for the two tools below. |
| `onedrive_get_driveitem` | `DriveItem.Get` | One item's metadata: name, size, `folder`/`file` facets, `parentReference`, `webUrl`. |
| `onedrive_download_driveitem` | `DriveItem.Download` | Raw file bytes; `format=pdf` converts docx/xlsx/pptx to PDF. |
| `onedrive_getshared_driveitem` | `DriveItem.GetShared` | Metadata of an item in another drive, by `remoteItem.parentReference.driveId` + `remoteItem.id`. |
| `onedrive_downloadshared_driveitem` | `DriveItem.DownloadShared` | Download from another drive (shared items); `format=pdf` works here too. |

All actions are `Read`-privileged and stateless; there are no mutating tools.

Downloads are non-JSON, so the platform wraps them in a typed `app_action_result` envelope: text content is inlined up to 32 KB; anything larger (and any
binary content, e.g. a PDF conversion) is saved to the caller's workspace files and returned as a `file` reference.

## UI components

Two sandboxed components ship with the app (`manifests/ui/spec.pkl`), catalogued as `com.microsoft/onedrive/file-browser` and
`com.microsoft/onedrive/file-viewer`:

- **file-browser** — search/browse via the `DriveItem.Search` / `DriveItem.List` bindings. An agent can prefill search text via render
  inputs; the user can edit it. Search is plain text matched against names *and* content (Graph has no query-operator syntax); an empty
  query browses from the drive root, and folder rows drill down by item id with a breadcrumb trail back to the search/root. Graph's
  `@odata.nextLink` is a full URL that can't be replayed through a binding (and children listing has no `$skip`), so instead of a *Load
  more* button the component shows a "more items exist" note — raise `pageSize` or narrow the search/folder. A per-row Select button
  emits an `open` output (`itemId`/`name`/`mimeType`/`webUrl`) — e.g. for wiring to the viewer.
- **file-viewer** — metadata + content preview by `itemId` via `DriveItem.Get` and `DriveItem.Download`. Text-like files (`text/*`,
  JSON, CSV, markdown) download and render inline, CSV as a table (first 500 rows). Office files have no text export in Graph: Word and
  PowerPoint get a *Convert to PDF* button (`format=pdf`; the binary result is saved to workspace files and shown as a file card), and
  Excel gets a note pointing at the excel connector. Handles the platform's non-JSON result envelope, including truncation and
  too-large-saved-to-files cases.

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against the Microsoft identity platform. You need an Azure app registration, then the
client credentials stored in Tangram, then each user connects their own account.

### 1. Azure portal (Entra ID)

1. **App registrations → New registration.** Supported account types: *Accounts in any organizational directory* — personal Microsoft accounts work for
   this package's APIs, but the shared `com.microsoft` registration also serves teams/sharepoint/excel, whose APIs are work/school-only (or restrict to
   your tenant and change the manifest's `/common/` endpoints to `/{tenantId}/`).
2. Add a **Web** redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.microsoft/onedrive
   ```

3. **Certificates & secrets → New client secret** — this is the value for `microsoftClientSecret` below.
4. **API permissions → Microsoft Graph → Delegated:** add `Files.Read.All`. Many tenants require admin consent for it — grant it once via *Grant admin
   consent* to spare every user the consent prompt.

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
into a single workspace. Connections default to **PerUser** — each user OAuths their own drive; `WorkspaceShared` is allowed at install for a
shared service account.

## Notes

- Graph's `/me/drive/sharedWithMe` listing is **deprecated** (degraded since late 2025, scheduled to stop returning data after Nov 2026), so this connector
  deliberately does not expose it — shared-file discovery goes through `onedrive_search_driveitem` instead.

- Downloads: Graph answers **302** with a pre-authenticated download URL; the platform follows the redirect and returns the file bytes.
- Graph paging is cursor-style: follow `@odata.nextLink` verbatim rather than computing offsets.
- The search path uses Graph's OData function-call syntax — `search(q='...')` with the parentheses and quotes as literal path characters.
