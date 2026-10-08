# Google Docs connector

Tangram OS ConnectorApp for the Google Docs API. Proxies exactly one upstream host (`https://docs.googleapis.com`, pinned — not overridable at install)
and exposes documents accessible to the OAuth connection as agent tools.

The Docs API has no list/search endpoint — discovery is the Drive connector's job (`drive_list_file` with `mimeType='application/vnd.google-apps.document'`);
this app operates on known documentIds (from a Docs URL, Drive, or `docs_create_document`).

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `docs_create_document` | `Document.Create` | Create a new empty document with a title; returns its `documentId`. |
| `docs_get_document` | `Document.Get` | Full structured content: body structural elements, headers, footers. `includeTabsContent=true` returns every tab; optional `fields` mask trims the payload. |
| `docs_update_document` | `Document.Update` | **Confirmation-gated.** `:batchUpdate` — an ordered list of Docs API request objects (insertText, replaceAllText, styling, …). `{"insertText": {"endOfSegmentLocation": {}, "text": "..."}}` appends to the body. |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against Google. You need a Google Cloud OAuth client, then the client credentials
stored in Tangram, then each user connects their own account.

### 1. Google Cloud console

1. Create (or reuse) a Google Cloud project and **enable the Google Docs API**.
2. Create an **OAuth 2.0 Client ID**, type **Web application**.
3. Add the redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.google/docs
   ```

4. Configure the consent screen with the scope the manifest requests:
   - `https://www.googleapis.com/auth/documents`

The scope is Google **sensitive** (not restricted) — a public OAuth app needs Google verification but no CASA assessment. As with the rest of the
`com.google` family, the intended v1 path is bring-your-own client with the consent screen's user type set to **Internal** (Google Workspace org
accounts only), which skips verification. Personal-account users need an **External** consent screen (Testing mode: manual test users + 7-day
refresh-token expiry; production: standard verification).

You do **not** need to configure offline access manually — the manifest sends `access_type=offline` and `prompt=consent` on every authorize request
(`api/spec.pkl`), which is what makes Google issue a refresh token. Tokens are refreshed automatically (10-minute refresh window before expiry).

### 2. Tangram publisher credentials

The manifest references two Tangram system secrets (shared by the whole `com.google` connector family, so one Google OAuth client serves gmail, sheets,
docs, slides, drive, and calendar):

- `googleClientId`
- `googleClientSecret`

Set them in **Settings → Connector OAuth** (publisher credentials; they are stored in the `tangram_os` system workspace). This works pre-install —
the credentials are resolved from the app catalog, so you can configure them before or after installing the app.

### 3. Install

Register/publish the app to your instance's App Hub, then install it either:

- **Globally** — flip the *Install globally* switch in the install drawer. The app deploys into the shared `tangram_os_shared` workspace and becomes
  usable from every workspace.
- **Per workspace** — a normal install into one workspace.

Note: the CLI `app install` path doesn't carry connector deployment params; install via the UI.

### 4. Connect an account

Connection scope defaults to **PerUser**: each Tangram user links their own Google account before the tools work for them. Open the app in the
Applications panel and click **Connect** — this runs the Google consent flow and stores the per-user tokens.

`WorkspaceShared` (one shared service Google account for a whole workspace) is also allowed at install time for per-workspace installs; it is rejected
on the shared global workspace, which is per-user only.

## UI components

Two sandboxed components ship with the app (`manifests/ui/spec.pkl`), catalogued as `com.google/docs/doc-viewer` and `com.google/docs/doc-composer`:

- **doc-viewer** — renders a document by `documentId` via the `Document.Get` binding: headings, styled text runs (bold/italic/underline), bullet and
  numbered lists (glyph types from the document's list metadata), and tables. Links render for http(s) URLs only; images, drawings, and other embeds
  are skipped. An Append button emits an `edit` output (`documentId`/`title`) for wiring to the composer.
- **doc-composer** — agent-assisted writing: an agent prefills `title`/`content` (plain text) via render inputs, the user edits, and Create makes the
  document then writes the content with a single confirmation-gated `insertText` batchUpdate. Setting the `documentId` input switches to append mode
  (a paragraph-break newline separates appended text from existing content). If the create succeeds but the write fails, the component links the empty
  document and offers a retry-as-append. The draft fields are exposed via the SDK's `provideState`, so an agent can read the user's in-progress edits
  (`tangram_get_component_state`) and refine them by re-rendering the same instance.
