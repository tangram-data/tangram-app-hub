# Box connector

Tangram OS ConnectorApp for the Box Platform API 2.0. Each user connects their own Box account (PerUser by default) and sees exactly what Box
lets them see.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `box_me_user` | `User.Me` | Connection check. |
| `box_search_item` | `Item.Search` | Full-text search (names, contents, comments, tags) with type/extension/folder/date filters. Also feeds Tangram's cross-app search: file hits open with `File.Download`, folders with `Folder.ListItems`. |
| `box_get_folder` / `box_listitems_folder` | `Folder.Get` / `Folder.ListItems` | Browse; root folder id is `0`. |
| `box_create_folder` | `Folder.Create` | New folder under `parent.id`. |
| `box_get_file` | `File.Get` | File details. |
| `box_download_file` | `File.Download` | Content (inline text up to 32KB, else a saved file reference). |
| `box_update_file` | `File.Update` | **Confirmation-gated.** Rename, move, or describe. |
| `box_share_file` | `File.Share` | **Confirmation-gated.** Create/change the shared link (`open`, `company`, `collaborators`). |
| `box_delete_file` | `File.Delete` | **Confirmation-gated.** To the trash. |
| `box_list_comment` / `box_create_comment` | `Comment.List` / `Comment.Create` | Create is **confirmation-gated** (notifies collaborators). |

Uploads are not supported yet.

## OAuth setup

Create a **Custom App → User Authentication (OAuth 2.0)** in the [Box Developer Console](https://app.box.com/developers/console), enable
*Read all files and folders* and *Write all files and folders*, and add the redirect URI:

```
https://<your-tangram-host>/api/core/v1/connector-oauth/callback/com.box/box
```

Store the client id/secret as the global system secrets `boxClientId` / `boxClientSecret`. Access tokens last 60 minutes and refresh automatically
(single-use rotating refresh tokens, 60-day life — a connection idle for 60 days must reconnect). Box's revoke endpoint needs client credentials
in the body, which the platform doesn't send, so disconnect only clears Tangram's tokens; users revoke under Box Account Settings → Apps.
