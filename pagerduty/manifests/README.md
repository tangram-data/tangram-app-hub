# PagerDuty connector

Tangram OS ConnectorApp for the PagerDuty REST API v2, connected through PagerDuty OAuth so every write is attributed to the connected responder.
US region (`api.pagerduty.com`) by default; EU accounts set the install's endpoint override to `https://api.eu.pagerduty.com`.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `pagerduty_list_incident` | `Incident.List` | Filter by `statuses[]`, `service_ids[]`, `urgencies[]`, `team_ids[]`, `user_ids[]`, `since`/`until`. Default window is the last 30 days; `date_range: all` lifts it. |
| `pagerduty_get_incident` | `Incident.Get` | By id or number. |
| `pagerduty_listlogentries_incident` | `Incident.ListLogEntries` | Timeline: triggers, notifications, acks, escalations, notes, resolve. |
| `pagerduty_listnotes_incident` | `Incident.ListNotes` | Responder notes. |
| `pagerduty_listalerts_incident` | `Incident.ListAlerts` | Alerts in the incident with their monitoring payload. |
| `pagerduty_create_incident` | `Incident.Create` | **Confirmation-gated.** Pages the service's escalation policy. `incident_key` dedupes retries. |
| `pagerduty_update_incident` | `Incident.Update` | **Confirmation-gated.** Acknowledge, resolve, reassign, escalate, change urgency/priority/title. Acknowledging a resolved incident reopens it and assigns it to the connected user. |
| `pagerduty_addnote_incident` | `Incident.AddNote` | **Confirmation-gated.** Notes cannot be edited or deleted. |
| `pagerduty_list_service` / `pagerduty_get_service` | `Service.List` / `Service.Get` | Services and their status/escalation policy. |
| `pagerduty_list_oncall` | `OnCall.List` | Who is on call now or in a window, per policy level and schedule. |
| `pagerduty_list_schedule` / `pagerduty_get_schedule` | `Schedule.List` / `Schedule.Get` | Rotations; `Get` with `since`/`until` renders the final schedule. |
| `pagerduty_list_escalationpolicy` | `EscalationPolicy.List` | Who gets paged, in which order. |
| `pagerduty_me_user` / `pagerduty_list_user` | `User.Me` / `User.List` | Connected user (connection check) and user lookup. |
| `pagerduty_list_team` | `Team.List` | Teams. |

Array filters are sent as repeated keys (`statuses[]=triggered&statuses[]=acknowledged`). Lists page with `offset`/`limit` while `more` is true.

## UI components

| Component | Inputs | What it shows |
|-----------|--------|---------------|
| `incident-viewer` | `incidentId` | Status, urgency, service, assignees, overview timeline and notes. **Acknowledge**, **Resolve** and **Add note** run the confirmation-gated `Incident.Update` / `Incident.AddNote` (the host asks first), then the view refreshes and emits `updated`. Shown automatically for `Incident.Get` results. |
| `oncall-board` | `escalationPolicyIds`, `scheduleIds` (optional) | Who is on call now per escalation policy and level, with shift end in the viewer's time zone, plus open (triggered / acknowledged) incidents; clicking one emits `open`. Read-only. |

Look and feel: `design/kits/pagerduty.css` (synced to `ui/shared/` by `scripts/sync-ui-kits.sh`).

## OAuth setup

In PagerDuty, **Integrations → App Registration → New App → OAuth 2.0 (Scoped OAuth)**, add the redirect URL:

```
https://<your-tangram-host>/api/core/v1/connector-oauth/callback/com.pagerduty/pagerduty
```

and grant `incidents.read`, `incidents.write`, `services.read`, `oncalls.read`, `schedules.read`, `escalation_policies.read`, `users.read`,
`teams.read`. Store the credentials as the global system secrets `pagerdutyClientId` / `pagerdutyClientSecret`. Tokens refresh automatically.
PagerDuty has no token-revocation endpoint: disconnect clears Tangram's tokens; to revoke the grant, remove the app in PagerDuty
([Remove apps](https://docs.pagerduty.com/integrations/apps#remove-apps)). Connection scope: **PerUser** (default — actions run as each responder) or **WorkspaceShared**.
