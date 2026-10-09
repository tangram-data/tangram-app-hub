# Salesforce connector

Tangram OS ConnectorApp for the Salesforce REST API (v62.0). Every org has its own API host, so the install **requires the org's My Domain URL**
as its endpoint (`https://<domain>.my.salesforce.com`; any `*.my.salesforce.com` host is accepted). Users connect with Salesforce OAuth and see
what their own profile and sharing rules allow.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `salesforce_me_user` | `User.Me` | Connected user + org. Connection check. |
| `salesforce_query_record` | `Record.Query` | SOQL — the universal read. `done: false` → `Record.QueryMore`. |
| `salesforce_querymore_record` | `Record.QueryMore` | Next page by the `nextRecordsUrl` locator. |
| `salesforce_search_record` | `Record.Search` | SOSL full-text search. Also feeds Tangram's cross-app search (accounts, contacts, leads, opportunities, cases); hits open with the typed `Get`. |
| `salesforce_listobjects_record` | `Record.ListObjects` | The org's objects, incl. custom (`__c`). |
| `salesforce_describe_record` | `Record.Describe` | Fields, types, picklist values of one object. |
| `salesforce_get_record` | `Record.Get` | Any object by `sobject` + `id`. |
| `salesforce_create_record` | `Record.Create` | **Confirmation-gated.** Any object; body = field API names → values. |
| `salesforce_update_record` | `Record.Update` | **Confirmation-gated.** Only the given fields change. |
| `salesforce_delete_record` | `Record.Delete` | **Confirmation-gated.** To the Recycle Bin (15 days). |
| `salesforce_get_account` / `_contact` / `_lead` / `_opportunity` / `_case` | `<Object>.Get` | One record by id. |

Writes are marked irreversible: record-triggered flows, assignment rules and email alerts may fire, and undoing the record doesn't undo them.

## OAuth setup

Create an **External Client App** (or Connected App) in Salesforce Setup with OAuth enabled, scopes **Manage user data via APIs (`api`)**,
**Access the identity URL service (`id`)** and **Perform requests at any time (`refresh_token`, `offline_access`)**, PKCE required, and the callback:

```
https://<your-tangram-host>/api/core/v1/connector-oauth/callback/com.salesforce/salesforce
```

Store the consumer key/secret as the global system secrets `salesforceClientId` / `salesforceClientSecret`. Login goes through
`login.salesforce.com` (production orgs; sandboxes are not supported in this version). Salesforce returns no token lifetime; Tangram refreshes
the access token after 10 minutes of use (inside even a 15-minute session timeout), so set the app's refresh-token policy to *valid until revoked* (default). Disconnect revokes the token. Connection
scope: **PerUser** (default) or **WorkspaceShared** (one integration user for everyone).
