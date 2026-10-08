# Microsoft Teams channels connector

Read-only Tangram OS ConnectorApp for Microsoft Teams channel messages via Microsoft Graph (`https://graph.microsoft.com`, pinned). Split from the
**teams** connector because reading channel messages needs `ChannelMessage.Read.All`, which requires tenant admin consent; keeping it separate lets
every user connect **teams** without an admin.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `teams_channels_list_team` | `Team.List` | Teams the connected user has joined. |
| `teams_channels_list_channel` | `Channel.List` | A team's channels; channel ids scope message calls. |
| `teams_channels_list_channelmessage` | `ChannelMessage.List` | Newest first; `$top` for page size, `$expand=replies` for threads, page with `@odata.nextLink`. |
| `teams_channels_listreplies_channelmessage` | `ChannelMessage.ListReplies` | Full reply thread of one root message (`messageId` from `ChannelMessage.List`); `$top` + `@odata.nextLink` paging. |

## OAuth setup

Same Entra app registration and `microsoftClientId` / `microsoftClientSecret` secrets as the rest of the `com.microsoft` family.

1. Add the redirect URI `https://<tangram-host>/api/core/v1/connector-oauth/callback/com.microsoft/teams-channels`.
2. **API permissions → Microsoft Graph → Delegated:** `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`.
3. **Grant admin consent** for `ChannelMessage.Read.All` — without it users are blocked at the consent prompt.

Work/school accounts only (the manifest uses the `/organizations/` endpoints). Connections default to **PerUser**.
