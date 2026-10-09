# Google Drive connector (`com.google/drive`)

Tangram OS ConnectorApp for the Google Drive API. Proxies exactly one upstream
host (`https://www.googleapis.com`, pinned — not overridable at install; unlike
the other Google APIs, Drive v3 is not served from a `drive.googleapis.com`
service host): file discovery, metadata, download/export, copy, and sharing.

It exists mainly to fill a gap in the other Workspace connectors: the Sheets,
Docs, and Slides APIs have no list endpoints, so finding an existing
spreadsheet/doc/presentation by name or content is the Drive API's job. Use
`drive_search_file` with a `mimeType` filter for discovery, then hand the file
id to the per-product connector — or skip them entirely and read any Workspace
document as plain text/CSV via `drive_export_file`.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `drive_search_file` | `File.Search` | List or search with a Drive query, e.g. `fullText contains 'roadmap'` or `name contains 'Q3' and mimeType='application/vnd.google-apps.spreadsheet'`. Paginated via `nextPageToken`. |
| `drive_get_file` | `File.Get` | Metadata by file id. `fields` defaults to id, name, mimeType, size, modifiedTime, owners, parents, webViewLink (same mask for `drive_search_file`); override as needed. |
| `drive_export_file` | `File.Export` | Export a Google Workspace document's content: Docs → `text/plain`/`text/markdown`, Sheets → `text/csv`, etc. Fails with 400 on unsupported mimeType/file combos. |
| `drive_download_file` | `File.Download` | Bytes of an uploaded (non-Workspace) file, e.g. PDF/image/Office; saved to a workspace file. Docs/Sheets/Slides → use `drive_export_file`. |
| `drive_copy_file` | `File.Copy` | Copy a file with an optional new `name` and one destination folder in `parents`. |
| `drive_create_permission` | `Permission.Create` | **Confirmation-gated.** Share: `role` reader/commenter/writer, `type` user/group (`emailAddress`), domain, or anyone (link). `sendNotificationEmail=false` shares silently. |
| `drive_get_about` | `About.Get` | Connected account (name, email) and storage quota. |

Copy and share are the only mutating tools; uploads are not supported.

Download (served from Drive's `/download/drive/v3/files/{id}?alt=media` media path) and export results are non-JSON, so the platform wraps them in a JSON envelope
(`{contentType, sizeBytes, text, truncated?, file?, note?}`): text content is
inlined up to 32 KB; anything larger (and any binary export mimeType, e.g.
`application/pdf`) is saved to the caller's workspace files under
`<user>/app_action_results/…` and returned as a `file` reference.

## UI components

Two sandboxed components ship with the app (`manifests/ui/spec.pkl`), catalogued as `com.google/drive/file-browser` and
`com.google/drive/file-viewer`:

- **file-browser** — search/browse files via the `File.Search` binding. An agent can prefill a Drive query via render inputs; the user
  can edit it (plain text becomes a `name contains` search, text with Drive operators is passed through as a raw `q`). Folder rows
  drill down (`'<id>' in parents`) with a breadcrumb trail back to the original search, file names link to Drive, pagination via *Load more*, and a per-row Select button emits an
  `open` output (`fileId`/`name`/`mimeType`/`webViewLink`) — e.g. for wiring to the viewer.
- **file-viewer** — metadata + content preview by `fileId` via `File.Get` and `File.Export`. Docs and Slides are exported as
  `text/plain`, Sheets as `text/csv` rendered as a table (first 500 rows); binary uploads get metadata and an Open-in-Drive link
  only. Handles the platform's non-JSON result envelope, including truncation and too-large-saved-to-files cases.

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against
Google. You need a Google Cloud OAuth client, then the client credentials
stored in Tangram, then each user connects their own account.

### 1. Google Cloud console

1. Create (or reuse) a Google Cloud project and **enable the Google Drive API**.
2. Create an **OAuth 2.0 Client ID**, type **Web application**.
3. Add the redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.google/drive
   ```

4. Configure the consent screen with the two scopes the manifest requests:
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/drive` (copy + share)

**Restricted-scope warning:** both are Google **restricted** scopes (like the
Gmail scopes). The non-restricted `drive.file` scope only sees files the app
itself created, so it cannot discover, copy, or share existing files and is
useless here. A public OAuth app using these scopes requires Google
verification plus an annual CASA security assessment; the intended v1 path is
bring-your-own client — register the OAuth client in your own Google Cloud
project with consent-screen user type **Internal** (Google Workspace org
accounts only), which skips verification entirely.

You do **not** need to configure offline access manually — the manifest sends
`access_type=offline` and `prompt=consent` on every authorize request
(`api/spec.pkl`), which is what makes Google issue a refresh token. Tokens
are refreshed automatically (10-minute refresh window before expiry).

### 2. Tangram publisher credentials

The manifest references two Tangram system secrets (shared by the whole
`com.google` connector family, so one Google OAuth client serves gmail,
sheets, docs, slides, and drive — add each installed app's redirect URI to
that one client):

- `googleClientId`
- `googleClientSecret`

Set them in **Settings → Connector OAuth** (publisher credentials; they are
stored in the `tangram_os` system workspace). This works pre-install — the
credentials are resolved from the app catalog, so you can configure them
before or after installing the app.

### 3. Install

Register/publish the app to your instance's App Hub, then install it either:

- **Globally** — flip the *Install globally* switch in the install drawer.
  The app deploys into the shared `tangram_os_shared` workspace and becomes
  usable from every workspace (agents in any workspace can bind its tools;
  it shows up in each workspace's Applications panel with a *Global* tag).
- **Per workspace** — a normal install into one workspace.

Note: the CLI `app install` path doesn't carry connector deployment params;
install via the UI.

### 4. Connect an account

Connection scope defaults to **PerUser**: each Tangram user links their own
Google account, and the tools see exactly the files that account can see.
Open the app in the Applications panel (for a global install, the *Global*
tag opens the shared deployment's drawer) and click **Connect** — this runs
the Google consent flow and stores the per-user tokens.

`WorkspaceShared` (one shared bot/service Google account for a whole
workspace) is also allowed at install time for per-workspace installs; it is
rejected on the shared global workspace, which is per-user only.

## Layout

```
manifests/
  app.pkl                 # app identity (group/name/version/type)
  api/spec.pkl            # endpoint, auth header template, OAuth2 config
  api/open_api.yml        # curated subset of the Drive v3 REST API
  api/resources.pkl       # File/Permission/About actions → tools
  ui/spec.pkl             # logo, deployment mode, published UI components (browser + viewer)
  ui/components/*.tsx     # sandboxed component sources
```

To add an operation: add it to `api/open_api.yml`, then map it to an action
in `api/resources.pkl`.

## Validate

From the repo root:

```
tangram app manifest validate drive
```
