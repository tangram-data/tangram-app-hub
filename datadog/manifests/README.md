# Datadog connector

Tangram OS ConnectorApp for the Datadog API (v1 + v2). Authenticates with an **API key** + **application key** entered at install (Datadog's
OAuth is limited to Marketplace partners). US1 (`api.datadoghq.com`) by default; other sites set the install's endpoint override:
`api.us3.datadoghq.com`, `api.us5.datadoghq.com`, `api.datadoghq.eu`, `api.ap1.datadoghq.com`, `api.ap2.datadoghq.com`, `api.ddog-gov.com`.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `datadog_validate_connection` | `Connection.Validate` | API key check. |
| `datadog_search_monitor` | `Monitor.Search` | Monitor query syntax: `status:alert`, `service:checkout status:(alert OR warn)`, `tag:env:prod`. Also feeds Tangram's cross-app search. |
| `datadog_get_monitor` | `Monitor.Get` | Definition + state; `group_states: all` for per-host/service states. |
| `datadog_query_metric` | `Metric.Query` | Timeseries: `query` + `from`/`to` (UNIX seconds). |
| `datadog_listactive_metric` | `Metric.ListActive` | Metric names reporting since `from`. |
| `datadog_search_log` | `Log.Search` | Log query over `filter.from`/`filter.to`; cursor paging. Needs `logs_read_data`. |
| `datadog_search_event` | `Event.Search` | Event stream (deploys, alerts, changes) — correlate alerts with deploys. |
| `datadog_list_host` | `Host.List` | Hosts by name/tag. |
| `datadog_list_dashboard` / `datadog_get_dashboard` | `Dashboard.List` / `Dashboard.Get` | Widget queries are reusable with `Metric.Query`. |
| `datadog_list_slo` / `datadog_history_slo` | `SLO.List` / `SLO.History` | SLI and error budget over a window. |
| `datadog_list_downtime` | `Downtime.List` | `current_only: true` = active only; omit it to include upcoming. `page[offset]`/`page[limit]` paging. |
| `datadog_create_downtime` | `Downtime.Create` | **Confirmation-gated.** Silences notifications for a scope; always set `schedule.end`. |
| `datadog_cancel_downtime` | `Downtime.Cancel` | **Confirmation-gated.** |

## UI components

| Component | Shows | Opened by |
|---|---|---|
| `monitor-list` | Monitors matching a monitor query, one line each (status dot, name, type, tags, last triggered); a row expands to query, thresholds, message and non-OK groups. `Select` emits `open` {monitorId, name}. | `Monitor.Search` results; or render with `query` |
| `metric-chart` | A metric query as a line chart, one line per series (click a legend entry to hide it), 15m–7d range selector, unit on the y-axis, at most 10 series. | `Metric.Query` results; or render with `query` + `range` (or `from`/`to`) |

Both are read-only and call the connector's own actions as the viewer.

## Setup

1. **API key** — Organization Settings → API Keys.
2. **Application key** — Organization Settings → Application Keys. Every call runs with this key's permissions, and the connection is shared by
   the workspace. Create it on a service account and **scope** it to what the actions need: `monitors_read`, `metrics_read`, `timeseries_query`,
   `logs_read_data`, `logs_read_index_data`, `events_read`, `hosts_read`, `dashboards_read`, `slos_read`, `monitors_downtime`.
   `monitors_downtime` covers listing downtimes as well as creating/cancelling them — to keep the connector read-only but still list downtimes,
   keep the scope and withhold `Downtime.Create`/`Downtime.Cancel` through Tangram action permissions instead.

Enter both as the install secrets `datadogApiKey` / `datadogApplicationKey`.
