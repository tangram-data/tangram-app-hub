# Google Calendar connector

Tangram OS ConnectorApp for the Google Calendar API. Proxies exactly one upstream host (`https://www.googleapis.com`, pinned — not overridable at install; like
Drive, Calendar v3 has no dedicated service host and is served under `/calendar/v3/*`). Exposes the calendars behind the OAuth connection as agent tools.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `calendar_list_calendar` | `Calendar.List` | Calendars on the account's calendar list; ids feed `calendarId` (or use `primary`). |
| `calendar_list_event` | `Event.List` | Free-text `q` search plus `timeMin`/`timeMax` window; `singleEvents=true&orderBy=startTime` for agenda order. |
| `calendar_get_event` | `Event.Get` | Full event: times, attendees, description, links. |
| `calendar_create_event` | `Event.Create` | **Confirmation-gated** (`sendUpdates=all` emails invitations; default `none`). `start`/`end` take `{date}` (all-day, end exclusive) or `{dateTime, timeZone}`. |
| `calendar_update_event` | `Event.Update` | **Confirmation-gated.** PATCH semantics — only fields present in the body change; `attendees` replaces the whole list. |
| `calendar_delete_event` | `Event.Delete` | **Confirmation-gated** (irreversible; `sendUpdates=all` sends cancellations). |
| `calendar_query_freebusy` | `FreeBusy.Query` | Busy intervals over a window for one or more calendars — find open slots before scheduling. |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against Google. You need a Google Cloud OAuth client, then the client credentials
stored in Tangram, then each user connects their own account.

### 1. Google Cloud console

1. Create (or reuse) a Google Cloud project and **enable the Google Calendar API**.
2. Create an **OAuth 2.0 Client ID**, type **Web application**.
3. Add the redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.google/calendar
   ```

4. Configure the consent screen with the two scopes the manifest requests:
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`

Both scopes are Google **sensitive** (not restricted) scopes — a public OAuth app needs Google verification but no CASA assessment. As with the rest of the
`com.google` family, the intended v1 path is bring-your-own client with the consent screen's user type set to **Internal** (Google Workspace org accounts
only), which skips verification entirely.

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

Two sandboxed components ship with the app (`manifests/ui/components.pkl`), catalogued as `com.google/calendar/event-list` and
`com.google/calendar/event-composer`:

- **event-list** — agenda view over `Event.List` (an agent scopes it via `calendarId`/`timeMin`/`timeMax`/`q` render inputs). Calendar picker fed by
  `Calendar.List`, free-text search, paging, and in-place row expansion (details come from the list response — descriptions render as plain text).
  Times render in the viewer's local timezone (shown as a caption); an event whose own timezone differs also shows its original wall-clock time and
  zone inline. Clicking a row emits a `select` output (`calendarId`/`eventId`/`summary`/`start`/`end`) for wiring to the composer.
- **event-composer** — agent-assisted scheduling: an agent prefills title/times/attendees/etc. via render inputs, the user edits, and Create goes
  through the confirmation-gated `Event.Create` binding. Setting the `eventId` input switches the form to edit mode (`Event.Update`, PATCH). All-day
  end dates are inclusive in the form and converted to Google's exclusive `end.date` on save. Attendee notification is an explicit `sendUpdates`
  selector (default: no emails). A **Google Meet** toggle (also settable via the `meet` input) requests a Meet link on save — the API only attaches
  one when asked (`conferenceDataVersion=1` + `conferenceData.createRequest`); the saved screen shows the generated link (or a pending/failed note)
  whether it was requested or auto-added by Workspace settings, and the `saved` output includes it as `meetLink`. The request id is kept stable across
  retries (Google treats it as an idempotency key) and once this instance attaches a link to the event being edited it stops re-requesting. Caveat:
  the composer doesn't fetch the target event, so when editing an event created elsewhere it can't tell whether a Meet link already exists — toggling
  Meet on requests a fresh conference, which replaces an existing one. The draft fields are exposed via the SDK's
  `provideState`, so an agent can read the user's in-progress edits (`tangram_get_component_state`) and refine them by re-rendering the same instance.
