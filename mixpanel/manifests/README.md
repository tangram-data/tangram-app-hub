# Mixpanel connector

Tangram OS ConnectorApp for the Mixpanel Query API and App API. Authenticates with a **service account** (username + secret, sent as HTTP
Basic) entered at install — Mixpanel has no third-party OAuth. US (`mixpanel.com`) by default; EU and India residency projects set the
install's endpoint override to `eu.mixpanel.com` or `in.mixpanel.com`.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `mixpanel_list_project` | `Project.List` | Projects + data views the service account can read. Every other action takes `project_id` from here. |
| `mixpanel_list_schema` | `Schema.List` | Lexicon: documented events / profile properties. |
| `mixpanel_run_report` | `Report.Run` | Saved Insights report by `bookmark_id`. |
| `mixpanel_list_funnel` / `mixpanel_query_funnel` | `Funnel.List` / `Funnel.Query` | Step counts + conversion over `from_date`..`to_date`. |
| `mixpanel_query_retention` | `Retention.Query` | Birth or compounded retention. |
| `mixpanel_names_event` / `mixpanel_top_event` | `Event.Names` / `Event.Top` | What is tracked (31 days) / today's top events. |
| `mixpanel_segment_event` / `mixpanel_count_event` | `Event.Segment` / `Event.Count` | One event broken down by a property / totals for several events. |
| `mixpanel_topproperties_event` / `mixpanel_propertyvalues_event` / `mixpanel_propertytrend_event` | `Event.*` | Property names, top values of an event property, values over time. |
| `mixpanel_query_profile` / `mixpanel_activity_profile` | `Profile.Query` / `Profile.Activity` | Profiles by id, `where` filter or cohort; a user's event history. |
| `mixpanel_list_cohort` | `Cohort.List` | Saved cohorts. |
| `mixpanel_list_annotation` | `Annotation.List` | Chart annotations in a date range. |
| `mixpanel_create_annotation` / `mixpanel_delete_annotation` | `Annotation.Create` / `Annotation.Delete` | **Confirmation-gated.** Visible on every chart of the project. |

Dates are `YYYY-MM-DD` in the project's timezone. Filters (`where`, `on`) use Mixpanel expressions, e.g.
`properties["plan"] == "pro"`. List-valued parameters (`event` of `Event.Count`, `distinct_ids`, `output_properties`) are JSON arrays
passed as strings.

**Rate limits:** Mixpanel allows 60 Query API calls per hour and 5 concurrent per project; the agent is told to keep date ranges tight and
not repeat queries. Raw event export and ingestion (`data.mixpanel.com`, `api.mixpanel.com`) are not covered.

## Setup

1. Organization Settings → **Service Accounts** → Add. Give it the **Analyst** role (or Consumer for read-only — annotations then fail)
   on only the projects Tangram should see. The connection is shared by the workspace, so every call runs with this account's roles.
2. Enter the username and secret as the install secrets `mixpanelServiceAccountUsername` / `mixpanelServiceAccountSecret`.
3. EU / India data residency: set the endpoint override to `https://eu.mixpanel.com` / `https://in.mixpanel.com`.

To keep the connector read-only, withhold `Annotation.Create` / `Annotation.Delete` through Tangram action permissions.
