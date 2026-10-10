# HubSpot connector

Tangram OS ConnectorApp for the HubSpot CRM API (objects v3, associations v4). One host (`api.hubapi.com`) for every portal — the OAuth token
identifies the portal.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `hubspot_search_contact` | `Contact.Search` | Text `query` + `filterGroups`, `properties`, `sorts`, paging with `after`. Also feeds Tangram's cross-app search. |
| `hubspot_find_company` / `_deal` / `_ticket` | `<Object>.Find` | Same search body for companies, deals, tickets. |
| `hubspot_get_<object>` | `<Object>.Get` | One record by id; `properties` picks fields, `associations` lists linked ids. |
| `hubspot_create_<object>` | `<Object>.Create` | **Confirmation-gated.** `properties` = internal names → values. |
| `hubspot_update_<object>` | `<Object>.Update` | **Confirmation-gated.** Only given properties change. |
| `hubspot_list_association` | `Association.List` | Linked records (e.g. a contact's companies). |
| `hubspot_create_association` | `Association.Create` | **Confirmation-gated.** Default link between two records. |
| `hubspot_list_owner` | `Owner.List` | Owners (`hubspot_owner_id` ↔ person/email). |
| `hubspot_list_pipeline` | `Pipeline.List` | Deal/ticket pipelines and stage ids. |
| `hubspot_list_property` | `Property.List` | An object's properties and allowed options. |

Search returns only a few default properties — pass `properties` for the fields you need. Stage values (`dealstage`, `hs_pipeline_stage`) are
stage ids; `Pipeline.List` maps them to labels. Creates and updates are irreversible: workflows and sequences can enroll records and send email.

## OAuth setup

Create a HubSpot **public app** (developer account → Apps), add the redirect URL

```
https://<your-tangram-host>/api/core/v1/connector-oauth/callback/com.hubspot/hubspot
```

and the scopes `oauth`, `crm.objects.{contacts,companies,deals}.{read,write}`, `tickets`, `crm.objects.owners.read`,
`crm.schemas.{contacts,companies,deals}.read`. Store the credentials as the global system secrets `hubspotClientId` /
`hubspotClientSecret`. Access tokens last 30 minutes and refresh automatically. HubSpot has no RFC 7009 revocation: disconnect clears Tangram's
tokens; a super admin uninstalls the app under Settings → Integrations → Connected apps to revoke it.

Connection scope is **WorkspaceShared** only: a HubSpot token carries the app's scopes across the whole portal regardless of who connected, so
per-user connections would not narrow access. Control who may search, read or write through Tangram's per-action permissions instead.
