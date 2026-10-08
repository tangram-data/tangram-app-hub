# Gmail connector

Tangram OS ConnectorApp for the Gmail API. Proxies exactly one upstream host (`https://gmail.googleapis.com`, pinned — not overridable at install) and
exposes the mailbox behind the OAuth connection as agent tools. All operations are pinned to `users/me`, so a caller can only act on the connected mailbox.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `gmail_list_message` | `Message.List` | Search with a Gmail query string (same syntax as the Gmail search box); filter by label ids from `gmail_list_label`. |
| `gmail_get_message` | `Message.Get` | Full message: headers, body, MIME parts. |
| `gmail_send_message` | `Message.Send` | **Confirmation-gated** (irreversible). Accepts normal `to`/`cc`/`bcc`/`subject`/`text`/`html` fields and optional attachments. |
| `gmail_modify_message` | `Message.Modify` | Add/remove label ids: mark read = remove `UNREAD`, archive = remove `INBOX`, star = add `STARRED`. |
| `gmail_trash_message` | `Message.Trash` | **Confirmation-gated.** Moves to Trash (restorable for 30 days). |
| `gmail_list_thread` | `Thread.List` | Search conversations with `q` / `labelIds`; returns thread ids + snippets. |
| `gmail_get_thread` | `Thread.Get` | Every message in a thread. Bodies stay base64url under `messages[].payload` (not decoded) — use `format=metadata` to skim, `gmail_get_message` for a decoded body. |
| `gmail_create_draft` | `Draft.Create` | Accepts the same readable email fields, saved instead of sent. |
| `gmail_list_draft` | `Draft.List` | Draft ids with their message id/threadId; optional `q` filter. |
| `gmail_send_draft` | `Draft.Send` | **Confirmation-gated** (irreversible). Sends a draft by draft id. |
| `gmail_get_attachment` | `Attachment.Get` | Fetch attachment content (base64url) by `messageId` + `attachmentId` from `getMessage`'s MIME parts. |
| `gmail_list_label` | `Label.List` | System and user labels. |
| `gmail_get_profile` | `Profile.Get` | The connected account's email address and message/thread totals. |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against Google. You need a Google Cloud OAuth client, then the client credentials
stored in Tangram, then each user connects their own account.

### 1. Google Cloud console

1. Create (or reuse) a Google Cloud project and **enable the Gmail API**.
2. Create an **OAuth 2.0 Client ID**, type **Web application**.
3. Add the redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.google/gmail
   ```

4. Configure the consent screen with the three scopes the manifest requests:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.modify` (labels + trash)

**Restricted-scope warning:** all three Gmail scopes are Google **restricted** scopes. A public OAuth app using them requires Google verification plus an annual CASA
security assessment. The intended v1 path is bring-your-own client: register the OAuth client in your own Google Cloud project and set the consent screen's user
type to **Internal** (Google Workspace org accounts only), which skips verification entirely.

You do **not** need to configure offline access manually — the manifest sends `access_type=offline` and `prompt=consent` on every authorize request (`api/spec.pkl`),
which is what makes Google issue a refresh token. Tokens are refreshed automatically (10-minute refresh window before expiry).

### 2. Tangram publisher credentials

The manifest references two Tangram system secrets (shared by the whole `com.google` connector family, so one Google OAuth client serves gmail, sheets, docs,
slides, and drive):

- `googleClientId`
- `googleClientSecret`

Set them in **Settings → Connector OAuth** (publisher credentials; they are  stored in the `tangram_os` system workspace). This works pre-install —
the credentials are resolved from the app catalog, so you can configure them before or after installing the app.

### 3. Install

Register/publish the app to your instance's App Hub, then install it either:

- **Globally** — flip the *Install globally* switch in the install drawer.
  The app deploys into the shared `tangram_os_shared` workspace and becomes
  usable from every workspace (agents in any workspace can bind its tools;
  it shows up in each workspace's Applications panel with a *Global* tag).
- **Per workspace** — a normal install into one workspace.

Note: the CLI `app install` path doesn't carry connector deployment params; install via the UI.

### 4. Connect an account

Connection scope defaults to **PerUser**: each Tangram user links their own Google account before the tools work for them. Open the app in the
Applications panel (for a global install, the *Global* tag opens the shared deployment's drawer) and click **Connect** — this runs the Google
consent flow and stores the per-user tokens.

`WorkspaceShared` (one shared bot/service Google account for a whole workspace) is also allowed at install time for per-workspace installs;
it is rejected on the shared global workspace, which is per-user only.

## UI components

Two sandboxed components ship with the app (`manifests/ui/spec.pkl`), catalogued as `com.google/gmail/mail-viewer`and
`com.google/gmail/mail-composer`:

- **mail-viewer** — renders a message by `messageId` via the `Message.Get` binding. HTML bodies go through a strict allowlist sanitizer
  (no scripts, styles, remote/data/SVG images, or event handlers; http(s)/mailto links only). Referenced `cid:` PNG/JPEG/GIF/WebP parts are
  fetched through `Attachment.Get`, signature/size/dimension checked, and displayed from bounded local data URLs. Lists and downloads attachments;
  a Reply button emits a `reply` output (`to`/`subject`/`threadId`) for wiring to the composer.
- **mail-composer** — agent-assisted compose: an agent prefills `to`/`cc`/`subject`/`body`/`threadId` via render inputs, the user edits and
  optionally attaches local files (capped at ~3.5 MB), and Send goes through the confirmation-gated `Message.Send` binding (Save draft uses
  `Draft.Create`). The connector boundary turns those readable fields into standards-compliant MIME and Gmail's base64url `raw` envelope;
  callers never construct provider-specific email payloads.
  The draft fields are exposed via the SDK's `provideState`, so an agent can read the user's in-progress edits
  (`tangram_get_component_state`) and refine them by re-rendering the same instance — attachments stay local and survive the re-render.
