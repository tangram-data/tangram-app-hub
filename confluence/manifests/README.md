# Confluence Cloud connector

Tangram OS ConnectorApp for Confluence Cloud (REST v2, plus v1 CQL search) through Atlassian's OAuth 2.0 (3LO) gateway. Upstream calls go to
`https://api.atlassian.com/ex/confluence/{cloudId}/wiki/...`; the site's `cloudId` is captured when the account connects (the **first** site in
Atlassian's `accessible-resources`) and injected by the platform, so no action takes it. To use another site, reconnect and grant only that site.

Searchable from Tangram's cross-app search: `Content.Search` declares `x-tangram-search` (the words become
`siteSearch ~ '<words>' and type = page`), and each page hit opens with `Page.Get`.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `confluence_list_site` | `Site.List` | Granted sites (`id`, `name`, `url`); the connection uses the first. |
| `confluence_search_content` | `Content.Search` | CQL search, e.g. `type = page and text ~ "onboarding"`. Hits carry `content.id`, `title`, `excerpt`, `url`. |
| `confluence_list_space` / `confluence_get_space` | `Space.List` / `Space.Get` | Spaces with `id`, `key`, `name`, `homepageId`. |
| `confluence_list_page` | `Page.List` | Pages by `space-id` or exact `title`; bodies only with `body-format`. |
| `confluence_get_page` | `Page.Get` | Page + storage-format body + `version.number`. |
| `confluence_listchildren_page` | `Page.ListChildren` | Direct children — walk a tree from a space's `homepageId`. |
| `confluence_create_page` | `Page.Create` | **Confirmation-gated.** New page (storage XHTML body), optionally under `parentId`; `status: draft` keeps it unpublished. |
| `confluence_update_page` | `Page.Update` | **Confirmation-gated.** Full replace of title + body; `version.number` = current + 1. History keeps old versions. |
| `confluence_delete_page` | `Page.Delete` | **Confirmation-gated.** Moves the page to the space trash. |
| `confluence_list_comment` | `Comment.List` | Footer comments on a page. |
| `confluence_create_comment` | `Comment.Create` | **Confirmation-gated.** Posts as the connected user; watchers are notified. |

Bodies use the Confluence storage format (XHTML): `<p>text</p><h2>Heading</h2><ul><li>item</li></ul>`.

## OAuth setup

Create an OAuth 2.0 (3LO) app in the [Atlassian developer console](https://developer.atlassian.com/console/myapps/), add the Confluence API
granular scopes below, and register the callback:

```
https://<your-tangram-host>/api/core/v1/connector-oauth/callback/com.atlassian/confluence
```

Scopes: `read:space:confluence`, `read:page:confluence`, `write:page:confluence`, `delete:page:confluence`, `read:comment:confluence`,
`write:comment:confluence`, `read:content-details:confluence` (CQL search), `offline_access` (refresh token).

Store the credentials as the global system secrets `atlassianClientId` / `atlassianClientSecret`. Access tokens last 1 hour and refresh
automatically (rotating refresh tokens). Atlassian has no token-revocation endpoint: disconnect clears Tangram's tokens; users revoke the grant at
id.atlassian.com → Connected apps. Connection scope: **PerUser** (default — each user sees what their Confluence permissions allow) or
**WorkspaceShared**.
