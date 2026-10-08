# Outlook connector

Tangram OS ConnectorApp for the Microsoft Graph mail and calendar APIs — one app for the Outlook product surface, one OAuth connection. Proxies exactly one
upstream host (`https://graph.microsoft.com`, pinned — not overridable at install) and exposes the mailbox and calendars behind the OAuth connection as agent
tools. All operations are pinned to `/me`, so a caller can only act on the connected account.

## Agent tools

### Mail

| Tool | Action | Notes |
|------|--------|-------|
| `outlook_list_message` | `Message.List` | `$search` for free-text/KQL (value wrapped in double quotes, e.g. `"from:alice@contoso.com"`), `$filter` for structured queries (e.g. `isRead eq false`); page with `$top` + `@odata.nextLink`. |
| `outlook_listinfolder_message` | `Message.ListInFolder` | Same as `Message.List`, scoped to one folder: `folderId` is a `MailFolder.List` id or a well-known name (`inbox`, `sentitems`, `drafts`, `deleteditems`, `archive`). |
| `outlook_get_message` | `Message.Get` | Full message: subject, sender, recipients, body (`$select` to trim). |
| `outlook_send_message` | `Message.Send` | **Confirmation-gated** (irreversible). Graph `sendMail` — structured JSON body, no MIME assembly needed. |
| `outlook_create_draft` | `Draft.Create` | Same message shape, saved to Drafts for the user to review. |
| `outlook_list_attachment` | `Attachment.List` | Attachment metadata; pass `$select=id,name,contentType,size,isInline` to skip base64 `contentBytes` (up to ~3MB each). |
| `outlook_get_attachment` | `Attachment.Get` | One attachment with content, by `messageId` + `attachmentId`. |
| `outlook_list_mailfolder` | `MailFolder.List` | Folder ids feed `folderId` of `Message.ListInFolder`; well-known names like `inbox` also work. |

### Calendar

| Tool | Action | Notes |
|------|--------|-------|
| `outlook_list_calendar` | `Calendar.List` | Calendar ids feed the `calendarId` of event operations; `isDefaultCalendar=true` marks the user's default calendar. |
| `outlook_list_event` | `Event.List` | `calendarView` — requires a `startDateTime`/`endDateTime` window and expands recurring events into instances; `$orderby=start/dateTime` for agenda order. |
| `outlook_get_event` | `Event.Get` | Full event: times, attendees with response status, body, Teams join link. |
| `outlook_create_event` | `Event.Create` | **Confirmation-gated**. `start`/`end` are `{dateTime, timeZone}`; `isOnlineMeeting` + `onlineMeetingProvider=teamsForBusiness` attaches a Teams link. |
| `outlook_update_event` | `Event.Update` | **Confirmation-gated** (Graph emails attendees about the change). PATCH semantics — only fields present in the body change. |
| `outlook_delete_event` | `Event.Delete` | **Confirmation-gated** (irreversible). Attendees receive a cancellation. |
| `outlook_query_schedule` | `Schedule.Query` | `getSchedule` free/busy — find open slots before scheduling; queries any SMTP addresses. |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against the Microsoft identity platform. You need an Azure app registration, then the
client credentials stored in Tangram, then each user connects their own account (one connection covers mail and calendar).

### 1. Azure portal (Entra ID)

1. **App registrations → New registration.** Supported account types: *Accounts in any organizational directory* — personal Microsoft accounts work for
   this package's mail/calendar APIs (except `getSchedule`), but the shared `com.microsoft` registration also serves teams/sharepoint/excel, whose APIs are
   work/school-only (or restrict to your tenant and change the manifest's `/common/` endpoints to `/{tenantId}/`).
2. Add a **Web** redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.microsoft/outlook
   ```

3. **Certificates & secrets → New client secret** — this is the value for `microsoftClientSecret` below.
4. **API permissions → Microsoft Graph → Delegated:** add `Mail.ReadWrite`, `Mail.Send`, and `Calendars.ReadWrite`. These are not admin-restricted by
   default, but many tenants require admin consent — grant it once via *Grant admin consent* to spare every user the consent prompt.

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

## UI components

Four sandboxed components ship with the app (`manifests/ui/spec.pkl`), catalogued as `com.microsoft/outlook/mail-viewer`,
`com.microsoft/outlook/mail-composer`, `com.microsoft/outlook/event-list`, and `com.microsoft/outlook/event-composer`:

- **mail-viewer** — renders a message by `messageId` via the `Message.Get` binding. HTML bodies go through a strict allowlist sanitizer
  (no scripts, styles, images, or event handlers; http(s)/mailto links only). Lists attachments via `Attachment.List` and downloads them via
  `Attachment.Get` (base64 `contentBytes`); a Reply button emits a `reply` output (`to`/`subject`/`conversationId`) for wiring to the composer.
- **mail-composer** — agent-assisted compose: an agent prefills `to`/`cc`/`subject`/`body` via render inputs, the user edits and optionally
  attaches local files (embedded as inline `fileAttachment` JSON, capped at ~3 MB — Graph's inline-attachment limit), and Send goes through the
  confirmation-gated `Message.Send` binding (`sendMail` returns 202 with an empty body, so the `sent` output echoes the local fields only).
  Save draft uses `Draft.Create` and links to the created draft in Outlook on the web. Graph's `sendMail` cannot thread onto an existing
  conversation, so the composer has no reply-threading field. The draft fields are exposed via the SDK's `provideState`, so an agent can read
  the user's in-progress edits (`tangram_get_component_state`) and refine them by re-rendering the same instance — attachments stay local and
  survive the re-render.
- **event-list** — agenda view over `Event.List` (an agent scopes it via `calendarId`/`startDateTime`/`endDateTime`/`q` render inputs; the window
  defaults to today + 30 days since `calendarView` requires both bounds). Calendar picker fed by `Calendar.List`, defaulting to the
  `isDefaultCalendar=true` entry — Graph has no `primary` alias, so without a `calendarId` input the list waits for `Calendar.List` to resolve the
  default. Subject search maps to an OData `contains(subject, ...)` `$filter`. Times render as wall-clock strings read straight off Graph's
  offset-less `dateTime` values, with the event's `timeZone` shown inline (no viewer-local conversion; Graph returns UTC unless a timezone preference
  is set upstream). Rows expand in place (`bodyPreview`, attendees with response status, `webLink`, Teams join link). Clicking a row emits a `select`
  output (`calendarId`/`eventId`/`subject`/`start`/`end`/`timeZone`) for wiring to the composer; all-day ends are converted from Graph's exclusive
  next-midnight to the inclusive last day the composer expects. `@odata.nextLink` is an opaque URL the binding can't replay, so **Load more** reloads
  with a doubled `$top` instead of cursor paging.
- **event-composer** — agent-assisted scheduling: an agent prefills title/times/attendees/etc. via render inputs, the user edits, and Create goes
  through the confirmation-gated `Event.Create` binding. Setting the `eventId` input switches the form to edit mode (`Event.Update`, PATCH). All-day
  end dates are inclusive in the form and converted to Graph's exclusive next-midnight end (+ `isAllDay=true`) on save; timed events are sent as
  `{dateTime, timeZone}` wall-clock pairs in the zone given by the `timeZone` input (event-list's `select` passes the Graph-returned zone through so
  edits don't shift the instant), defaulting to the viewer's IANA zone. A **Teams meeting** toggle (also settable via the `teams` input) sets
  `isOnlineMeeting=true` + `onlineMeetingProvider=teamsForBusiness` on create — Graph attaches `onlineMeeting.joinUrl` in the create response, which
  the saved screen shows and the `saved` output includes as `joinUrl` (with `id` and `webLink`). The toggle is create-only: adding a meeting to an
  existing event via PATCH is unreliable, so edit mode never sends the meeting fields (accepted gap). Create requires a real `calendarId` input
  (no default-calendar alias); edits patch `/me/events/{eventId}` and need none. There is no `sendUpdates` selector — Graph emails attendees
  automatically. The draft fields are exposed via the SDK's `provideState`, so an agent can read the user's in-progress edits
  (`tangram_get_component_state`) and refine them by re-rendering the same instance.

## Notes

- Graph paging is cursor-style: to fetch the next page, copy the `$skiptoken` (or `$skip`) value out of the previous response’s `@odata.nextLink` into the same-named tool parameter.
- `$search` cannot be combined with `$filter`/`$orderby` (Graph limitation).
- `sendMail` returns **202 with an empty body** on success.
- Inline JSON attachments cap out around 3MB; larger files need Graph upload sessions, which this connector does not expose yet.
- `calendarView` **requires** the `startDateTime`/`endDateTime` window and expands recurring events into per-instance rows (Graph's analog of Google's
  `singleEvents=true`); expanded instances carry a `seriesMasterId`.
- Graph datetime quirk: event `start`/`end` `dateTime` values carry **no UTC offset** (e.g. `2026-07-10T14:00:00`) — the sibling `timeZone` field carries
  the zone.
- `getSchedule` needs only `Calendars.Read` for the connected user's own availability, but reading **other users'** schedules may require the
  `Calendars.Read.Shared` delegated permission depending on tenant policy — add it to the app registration if `querySchedule` returns 403 for colleagues.
- `getSchedule` is a work/school-only API — personal Microsoft accounts get an error from `outlook_query_schedule`.
