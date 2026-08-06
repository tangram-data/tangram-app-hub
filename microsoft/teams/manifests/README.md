# Microsoft Teams connector

Tangram OS ConnectorApp for the Microsoft Graph Teams API. Proxies exactly one upstream host (`https://graph.microsoft.com`, pinned — not overridable at
install) and exposes the teams and chats behind the OAuth connection as agent tools. Team/chat listing is pinned to `/me`; channel operations only reach
teams the connected user is a member of.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `teams_list_team` | `Team.List` | Teams the connected user has joined; team ids scope everything else. |
| `teams_list_channel` | `Channel.List` | A team's channels (e.g. General); channel ids scope message calls. |
| `teams_list_channelmessage` | `ChannelMessage.List` | Newest first; `$top` for page size, `$expand=replies` for threads, page with `@odata.nextLink`. |
| `teams_send_channelmessage` | `ChannelMessage.Send` | **Confirmation-gated** (irreversible). Body `{body:{contentType,content}}`, contentType `text` or `html`. |
| `teams_list_chat` | `Chat.List` | 1:1 and group chats; `$expand=members` reveals who each chat is with. |
| `teams_list_chatmessage` | `ChatMessage.List` | Newest first; `$top` + `@odata.nextLink` paging. |
| `teams_send_chatmessage` | `ChatMessage.Send` | **Confirmation-gated** (irreversible). Same body shape as channel send. |

## OAuth setup

The connector uses the OAuth 2.0 authorization-code flow (with PKCE) against the Microsoft identity platform. You need an Azure app registration, then the
client credentials stored in Tangram, then each user connects their own account.

### 1. Azure portal (Entra ID)

1. **App registrations → New registration.** Supported account types: *Accounts in any organizational directory* — this package's Graph APIs are not
   available to personal Microsoft accounts (or restrict to your tenant and change the manifest's `/common/` endpoints to `/{tenantId}/`).
2. Add a **Web** redirect URI, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.microsoft/teams
   ```

3. **Certificates & secrets → New client secret** — this is the value for `microsoftClientSecret` below.
4. **API permissions → Microsoft Graph → Delegated:** add `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`,
   `ChannelMessage.Send`, and `Chat.ReadWrite`. **`ChannelMessage.Read.All` requires admin consent in most tenants** — grant it once via
   *Grant admin consent* or users will be blocked at the consent prompt. (Reading channel messages is a Graph "protected API" for *application*
   permissions, requiring a Microsoft approval process — but this connector uses *delegated* permissions, which are fine.)

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

Register/publish the app to your instance's App Hub, then install it either globally (shared `tangram_os_shared` workspace, usable from every workspace) or
into a single workspace. Connections default to **PerUser** — each user OAuths their own Teams account; `WorkspaceShared` is allowed at install for a
shared service account.

## Notes

- Message listings return **newest first**; follow `@odata.nextLink` verbatim for older pages rather than computing `$skip` offsets.
- `html` message bodies contain raw HTML markup (mentions, formatting, inline images).
- Sent messages cannot be deleted via this connector — that is why both send actions are confirmation-gated.
