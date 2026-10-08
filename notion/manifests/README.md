# Notion connector

Tangram OS ConnectorApp for the Notion public API. Proxies exactly one upstream host (`https://api.notion.com`, pinned — not overridable at install) and
exposes the pages, databases, and users shared with the OAuth connection as agent tools. Every request carries `Notion-Version: 2022-06-28`.

Visibility follows Notion's sharing model: a page or database is reachable only if it (or an ancestor) is shared with the integration — for OAuth
connections that is the set of pages the user picks on the consent screen (and anything Notion's "access will update automatically" option adds later).

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `notion_search_workspace` | `Workspace.Search` | Title search across accessible pages and databases; the discovery entry point. Notion's search index can lag recent edits and is not guaranteed exhaustive. |
| `notion_get_page` | `Page.Get` | Page properties (title, database fields, url) — content blocks come from `notion_list_block`. |
| `notion_create_page` | `Page.Create` | Under a parent page (title only), as a database item (schema properties), or — parent omitted — as a private workspace-level page; optional initial `children` blocks. |
| `notion_update_page` | `Page.Update` | Patch properties or icon. Trashing goes through the confirmation-gated `Block.Delete`. |
| `notion_list_block` | `Block.List` | A block's children; pass a page id to read page content. Nested blocks need further calls. |
| `notion_append_block` | `Block.Append` | Append content blocks to a page or block (max 100 per call); `after` inserts mid-page. |
| `notion_update_block` | `Block.Update` | Replace fields of a block in place (e.g. `paragraph.rich_text`, `to_do.checked`); rich_text is replaced wholesale and the block's type cannot change. |
| `notion_delete_block` | `Block.Delete` | **Confirmation-gated.** Move a block or page to trash (restorable in Notion). |
| `notion_get_database` | `Database.Get` | Title + property schema; read before creating items or building filters. |
| `notion_query_database` | `Database.Query` | Items with Notion filter/sorts objects. |
| `notion_create_database` | `Database.Create` | New database under a parent page with a property schema. |
| `notion_list_user` | `User.List` | Workspace members and bots, for people properties and mentions. |
| `notion_list_comment` | `Comment.List` | Open comments on a page or block. |
| `notion_create_comment` | `Comment.Create` | **Confirmation-gated** — comments notify participants and the API cannot delete them. |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow against Notion. You need a **public** Notion integration, then its credentials stored in
Tangram, then each user connects their own Notion account.

### 1. Notion integration

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and create an integration.
2. Under **Distribution**, make it **public** (private integrations use static internal tokens, not OAuth, and won't work here).
3. Set the redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.notion/notion
   ```

4. Under **Capabilities**, grant what the tools need: read content, update content, insert content, read comments, insert comments, and read user
   information. Notion has **no OAuth scopes** — these integration-level capabilities are the whole authorization contract, and the manifest requests
   nothing at authorize time.

### 2. Tangram publisher credentials

The manifest references two Tangram system secrets:

- `notionClientId`
- `notionClientSecret`

Set them in **Settings → Connector OAuth** (publisher credentials; stored in the `tangram_os` system workspace). This works pre-install — the
credentials are resolved from the app catalog, so you can configure them before or after installing the app.

### 3. Install

Register/publish the app to your instance's App Hub, then install it either:

- **Globally** — flip the *Install globally* switch in the install drawer. The app deploys into the shared `tangram_os_shared` workspace and becomes
  usable from every workspace.
- **Per workspace** — a normal install into one workspace.

Note: the CLI `app install` path doesn't carry connector deployment params; install via the UI.

### 4. Connect an account

Connection scope defaults to **PerUser**: each Tangram user links their own Notion account before the tools work for them. Open the app in the
Applications panel and click **Connect** — Notion's consent screen asks which pages to share with the integration; only those pages (and their
children) are visible to the tools.

`WorkspaceShared` (one shared Notion account for a whole workspace) is also allowed at install time for per-workspace installs; it is rejected on the
shared global workspace, which is per-user only.

### Token lifetime

Notion access tokens are long-lived: the token exchange returns no `expires_in` and no `refresh_token`, so Tangram stores the token without an expiry
and never refreshes it. A token dies only when the user revokes the integration in Notion — reconnecting issues a new one. Token-endpoint
authentication is HTTP Basic (`client_id:client_secret`), and the authorize URL carries Notion's required `owner=user` parameter. PKCE is not
supported by Notion and is disabled in the manifest.

## UI components

Two sandboxed components ship with the app (`manifests/ui/spec.pkl`), catalogued as `com.notion/notion/page-viewer` and
`com.notion/notion/page-composer`:

- **page-viewer** — renders a page by `pageId` via the `Page.Get` + `Block.List` bindings: headings, paragraphs with annotations
  (bold/italic/strikethrough/underline/code), bulleted and numbered lists, to-dos, toggles, quotes, callouts, code blocks, dividers, bookmarks, and
  child page/database markers. Links render for https URLs only. Top-level blocks are paged 100 at a time (capped at 500 with a truncation notice);
  collapsed sections fetch their subtree lazily on click. The pencil button toggles a Notion-style edit mode: hovering a top-level block reveals
  controls to edit its text in place (`Block.Update`, plain text — saving flattens formatting), insert new blocks after it (`Block.Append` with
  `after`), or delete it (`Block.Delete`, confirmation-gated), plus an append editor for the end of the page. Edit-mode drafts parse markdown-style
  prefixes (`#`/`##`/`###` headings, `-` bullets, `1.` numbered, `[]`/`[x]` to-dos, `>` quotes, `---` dividers, ``` fenced code) into matching block
  types. The append draft is exposed via `provideState`, and a re-render with a `draft` input prefills/refines it.
- **page-composer** — agent-assisted writing in a Notion-editor-style surface: a large borderless title over a seamless content area, with the
  parent-page picker tucked into the header. An agent prefills `parentPageId`/`title`/`content` (plain text) via render inputs, the user edits, and
  Create makes the page with the content parsed into blocks (same markdown-style prefixes as the viewer; other lines become paragraphs; long lines
  split at Notion's 2000-char span limit; overflow beyond 100 blocks appended in batches). An empty `parentPageId` creates a private workspace-level
  page. Setting the `pageId` input switches to append mode. Partial failures never duplicate content: the component tracks how many blocks landed,
  keeps only the unwritten lines, and offers retry-as-append against the already-created page. The draft fields are exposed via the SDK's
  `provideState`, so an agent can read the user's in-progress edits (`tangram_get_component_state`) and refine them by re-rendering the same
  instance.

## Notes

- Page/database/block ids accept UUIDs with or without dashes; the id is the 32-hex-char tail of any Notion URL.
- Database items are created with `notion_create_page` (`parent.database_id` + schema-matching properties), not a database action.
- The OpenAPI spec is a curated subset of the upstream API; extend it by adding operations to `api/open_api.yml` and mapping them to actions in
  `api/resources.pkl`.
- The manifest pins `Notion-Version: 2022-06-28`. The 2025-09-03 API version restructures databases into data sources (querying moves to
  `/v1/data_sources/{id}/query`); adopting it is a deliberate migration, not a header bump.
