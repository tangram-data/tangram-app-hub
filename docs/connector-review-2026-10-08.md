# Connector review — 2026-10-08

Scope: SaaS connectors in this repo — `google/{gmail,calendar,drive,docs,sheets,slides}`,
`microsoft/{outlook,teams,onedrive,sharepoint,excel}`, `notion`, `quickbooks`.
Method: static read of manifests + the tangram core runtime that executes them. Nothing run live;
items marked *(verify)* need one live call. Codex-reviewed r1; corrections folded in.

Core paths below are relative to
`tangram/tangram-core/tangram-core-server/src/main/scala/ai/tangram/os/core/v1/server/`.

## TL;DR

- Most breakage comes from ~10 **platform** gaps, not the manifests. Fix those first.
- Top connector bugs: Notion block writes rejected, approval bypasses (Calendar update, Notion archive),
  Gmail replies don't thread, Teams needs tenant admin consent to connect at all.
- Portfolio next: GitHub, Salesforce, Stripe; then Jira/Linear, PagerDuty/Sentry, HubSpot, Zendesk.

## 1. Platform gaps (tangram core)

| # | Gap | Where | Breaks |
|---|---|---|---|
| P1 | 302 redirects not followed | `PerformResourceActionRoute.scala:418`, `AppServiceGatewayRoutes.scala:409` | OneDrive/SharePoint Download, DownloadShared, preview, convert-to-PDF |
| P2 | Granted-scope check exact + case-sensitive; Entra returns short/lowercased scopes, omits `offline_access` | `oauth/ConnectorOAuthOrchestrator.scala:426`, drift check `:758` | Likely every Microsoft connect *(verify)* |
| P3 | Explicit `null` fails output validation unless field is `nullable` | `ResolvedActionResolver.scala:299`, `ResolvedActionJsonSchemaValidation.scala:27` | Outlook Event.List/Get, Teams messages/chats/channels |
| P4 | `items: {}` resolves to `string` | `ResolvedActionResolver.scala:291` | Excel + Google Sheets numeric/bool cells (Excel Range.Get/Update, Table.AddRows; Sheets writes, unformatted reads `sheets/.../open_api.yml:230`) |
| P5 | Path params form-encoded (space → `+`, `:` → `%3A`) | `URLComponentEncodeFunction.java:8` | Excel sheet "Q3 Sales", OneDrive search, SharePoint path-form site ids |
| P6 | Array query params dropped in agent/flow/resolved lanes; stringified in sandbox | `AgentToolAppActionBinding.scala:38`, `component/SandboxActionArguments.scala:224` | Gmail `labelIds` silently ignored → whole mailbox |
| P7 | Agent tool schema has no `allOf` handling → `string` | `mcp/SwaggerApiMcpUtil.scala:56` | QuickBooks Purchase create (`AccountRef`, `EntityRef`) |
| P8 | Enum values stringified (`true` → `"true"`) | `ResolvedActionResolver.scala:352` | QuickBooks Purchase.Update always rejected (`sparse: [true]`) |
| P9 | Agent tools drop the action `doc`, parameter-level descriptions and object/array descriptions (operation description and scalar field descriptions survive) | `mcp/SwaggerApiMcpUtil.scala:79,122,139` | Agents miss QBO query examples, Notion block/filter shape |
| P10 | No request-header passthrough; base64 fields inside JSON not decoded (text/binary responses are handled, `AppActionResponseShaper.scala:58`) | request/response adapters | Gmail bodies base64-only; Outlook `Prefer` timezone; Excel workbook sessions |

Smaller:
- Intuit revoke expects JSON body; platform sends form (`ConnectorOAuthOrchestrator.scala:914`) → disconnect leaves grant live.
- `forceRefresh` (401 retry) never called (`ConnectorOAuthOrchestrator.scala:604`).
- QuickBooks `realmId` from callback not validated before use in path (`:569`) — validate `^\d+$`.
- Sandbox confirm dialog: `dialogOpenRef` set at render; dropped second request never answered → promise hangs
  (`ui/.../AgentChat/surfaces/SandboxedComponentFrame.tsx:105,377`).

## 2. Connector bugs

### High
- **Notion** `api/open_api.yml:532` (BlockInput), `:245` (updateBlock body): undeclared fields rejected in sandbox
  lane → page-viewer/composer append, insert, update all fail. Add `additionalProperties: true` (also RichTextInput).
- **Calendar** `api/resources.pkl:61`: `Event.Update` not confirmation-gated but can add attendees + `sendUpdates=all`.
  Bypasses gated Create. Set `requiresConfirmation = true`.
- **Notion** `resources.pkl:62,104`: `archived=true` on Page/Block Update trashes without confirmation. Remove
  `archived` from both Update bodies (or gate whenever supplied); add gated Page.Archive/Restore.
- **Gmail** `open_api.yml:244`: replies carry only `threadId`; no `In-Reply-To`/`References` → not threaded for recipients.
- **Teams** `spec.pkl:30`: `ChannelMessage.Read.All` needs admin consent; bundled → no one connects without it.
  Split channel-read out or document prerequisite. Also `Chat.ReadWrite` → `Chat.Read` + `ChatMessage.Send`.

### Medium
- **Gmail**: attachment path param `id` vs docs `attachmentId` (`open_api.yml:133`); Attachment.Get dumps up to 25 MB
  base64 into agent context; `getMessage` body only base64 (needs P10).
- **Drive** `open_api.yml:46,93`: no default `fields` → no owners/modifiedTime/webViewLink. Docs/Sheets/Slides Get
  have no `fields` mask → MB-sized payloads. Docs lacks `includeTabsContent` (multi-tab docs truncated).
- **Calendar** Update doc: `attendees` replaces the full list; say so.
- **Outlook**: `$search` must be double-quoted (`open_api.yml:25`); `parentFolderId eq 'inbox'` invalid (`:38`) — add
  `/mailFolders/{id}/messages`; `listAttachments` returns all `contentBytes` (`:155`) — add `$select`; recurrence
  schema missing `dayOfMonth`/`index`/`numberOfOccurrences`… (`:789`); event list shows UTC.
- **All Microsoft**: `$skiptoken` doc says copy from `nextLink` → double-encoded. Say URL-decode, or support nextLink replay.
- **Excel** `spec.pkl:28`: `Files.ReadWrite` may not reach shared/SharePoint workbooks *(verify; Graph lists it as
  sufficient for Range.Update)*. Test before switching to `.All`.
- **OneDrive**: search `q` apostrophes must be doubled by direct action callers (the browser already does);
  file-browser omits `remoteItem` → shared hits 404; overlapping loads lack a sequence guard
  (`file-browser.tsx:118`) → stale results can overwrite the current folder.
- **QuickBooks** `open_api.yml:73`: no `requestid` idempotency → double-booked expense on retry.
- **Notion** `spec.pkl:19`: `Notion-Version: 2022-06-28` may break multi-data-source databases *(verify)*.
- **UI components**: Notion viewer keeps stale draft across pages (`page-viewer.tsx:887,915,873`); Drive "Load more"
  pages with edited query (`file-browser.tsx:274`); Gmail ignores part charset (`mail-viewer.tsx:48`); Drive
  search text containing raw-query trigger words ("in", "trashed", "contains") is sent as raw `q` → 400
  (`file-browser.tsx:82`).

### Low
- Composers create duplicates on "Back → Save" after create (calendar, docs, notion).
- Gmail draft → send leaves draft behind.
- Ungated writes worth reviewing: QBO `Attachable.Update` (can detach), Excel `Table.AddRows`, Sheets `AppendValues`.
- Outlook `Event.Create` marked Reversible but emails invites.
- Microsoft authority `/common/` for org-only apps (Teams/SharePoint/Excel) → `/organizations/`.
- Calendar privilege `"Update"` → `"Write"` for consistency; `calendar.readonly` → `calendar.calendarlist.readonly` *(verify)*.
- SharePoint type `List` → tool `sharepoint_list_list`; rename `SiteList`.
- Notion: no `revocationUrl`; README mentions http links but code is https-only.
- README drift: several READMEs cite `manifests/ui/components.pkl` (now `ui/spec.pkl`).
- Local `*.tar.gz` stale (old layout/versions). Gitignored, harmless; rebuild before publish.

## 3. Missing high-value actions

- **Gmail**: modify/batchModify (read, archive, labels), threads get/list, drafts update/send, trash (gated), getProfile.
- **Calendar**: RSVP, instances, quickAdd.
- **Drive**: `alt=media` download, copy, share (gated), upload.
- **Sheets**: batchUpdate, batchGet, clear (gated). **Slides**: thumbnails.
- **Outlook**: reply/reply-all/forward, send draft, mark read, move, RSVP, findMeetingTimes.
- **Teams**: thread replies, create chat, mentions, search.
- **OneDrive/SharePoint**: upload (needs raw-body lane), create folder, sharing link, item by path, tenant search.
- **Excel**: list table rows, add worksheet, clear range.
- **Notion**: get block, users/me, update database schema, property item paging, file upload.
- **QuickBooks**: reports (P&L, Balance Sheet, TransactionList), get by id, CDC, Bill/Deposit/JournalEntry create (gated).

## 4. Portfolio — connectors to add

Ranked by fit with Tangram (data/BI, flows, AI SRE, agents):

1. **Dev + ops** — GitHub, Jira, Linear, PagerDuty, Sentry, Datadog. Feeds AI SRE and flows.
2. **Revenue data** — Salesforce, HubSpot, Stripe, Shopify. Feeds semantic models/dashboards.
3. **Support** — Zendesk, Intercom.
4. **Knowledge** — Confluence, Box/Dropbox. Feeds Knowledge Spaces.
5. **Finance** — Xero, NetSuite (QuickBooks peers).
6. **Warehouses** — BigQuery, Postgres/MySQL, Redshift (gap next to Snowflake/Databricks/ClickHouse).

Next three: **GitHub, Salesforce, Stripe** — provisional; confirm against customer demand and weigh against
finishing the existing connectors' missing actions.

## 5. Suggested order

1. Live connect per Microsoft app to settle P2 (gates all Microsoft work).
2. Confirmation bypasses (Calendar Event.Update, Notion `archived`).
3. Platform P1–P8, then P9–P10.
4. Remaining Highs (Notion BlockInput, Gmail threading, Teams scopes).
5. Mediums + missing actions, bump versions, republish.
6. New connectors: GitHub → Salesforce → Stripe (provisional).

## 6. Status (2026-10-08)

Every commit got a concise Codex review; findings were fixed until ACCEPT.

| Step | Done | Commits |
|---|---|---|
| 1 Microsoft connect | Scope match tolerant for Entra/Google, exact elsewhere. Live connect still to verify. | core bdfcbd29c, 2340d915a |
| 2 Approval bypasses | Calendar/QBO gates; Notion `archived` removed; input validation honors `additionalProperties`; every lane validates connector bodies at the perform route | core 3f570ea16, ab56cc05a, f59a8036e, c0dd5bae9; hub aec06b5 |
| 3 Platform P1–P8 | Redirects (SSRF-guarded), optional nulls, any-scalar cells, RFC 3986 paths, array query params, allOf/enums, tool docs | core affc3ead6, 736c3f6e9 |
| 4 Broken connectors | Notion block writes; Gmail reply threading; Teams split (teams-channels); sandbox confirm hang | core 1431e2739; hub 4eac695, 9b373c1; ui 9b9e7f85 |
| 5 Agent quality | Gmail decoded bodies; 96K agent output budget; query defaults sent; manifest doc/param fixes | core f1f981ff2, 17e5afd06; hub d69353b |
| 6 Polish | Tenant id validation, Intuit JSON revoke; component races/duplicates; patch version bumps | core 3b6798d20; hub 099c8ad, 579e1a9, 464db1a |
| 7a Missing actions | Gmail/Calendar/Drive/Sheets/Outlook/Teams/OneDrive/SharePoint/Excel/QBO actions; restricted scopes approved (gmail.modify, drive, Sites.ReadWrite.All) | hub ad86763, 21641d8 |
| 7b GitHub | New connector 0.1.0; core parses GitHub's comma scope echo | hub 93f3ff8, a9a9e35; core f1ee1eafa, b5c80f4c2 |

Open:
- Legacy chat (`ChatWebsocketServer`) and MCP SSE lanes skip `requiresConfirmation` (bodies are validated now). Product decision needed.
- Live Microsoft connect per app; republish changed connectors; deploy core.
- UI restyle (2026-10-08): Google/Microsoft/Notion components look native, buttons in Tangram's button language; kits in design/kits synced to each app's ui/shared (hub 5c19e22..2eeaf4b). Core + SDK + `tangram app dev` stage ui/shared; workspace packages and desktop projects reject it. Deploy core before republishing.
- Next connectors: Salesforce, Stripe (not started).
- Not done: upload lane (raw body / upload sessions), `forceRefresh` on 401, Notion data-source API migration.
