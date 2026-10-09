# Google Sheets connector

Tangram OS ConnectorApp for the Google Sheets API. It proxies the pinned
`https://sheets.googleapis.com` host and exposes spreadsheets available to the
connected Google account as agent tools.

The Sheets API does not provide file discovery. To find an existing spreadsheet,
use the Google Drive connector's `drive_search_file` tool with the MIME type
`application/vnd.google-apps.spreadsheet`, then pass the returned file id as the
`spreadsheetId` here.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `sheets_create_spreadsheet` | `Spreadsheet.Create` | Create an empty spreadsheet with a title; returns its id and URL. |
| `sheets_get_spreadsheet` | `Spreadsheet.Get` | Read spreadsheet metadata, sheet names, ids, and dimensions; optional `fields` mask. |
| `sheets_read_values_spreadsheet` | `Spreadsheet.ReadValues` | Read values from an A1 range such as `Sheet1!A1:D10`. |
| `sheets_update_values_spreadsheet` | `Spreadsheet.UpdateValues` | **Confirmation-gated.** Overwrite values in an A1 range. |
| `sheets_append_values_spreadsheet` | `Spreadsheet.AppendValues` | Append rows after the table containing the selected range. |
| `sheets_batchreadvalues_spreadsheet` | `Spreadsheet.BatchReadValues` | Read several A1 ranges in one call (`ranges` array). |
| `sheets_clearvalues_spreadsheet` | `Spreadsheet.ClearValues` | **Confirmation-gated** (irreversible). Clear values in an A1 range; formatting stays. |
| `sheets_batchupdate_spreadsheet` | `Spreadsheet.BatchUpdate` | **Confirmation-gated.** Atomic Sheets API `requests`, e.g. `[{"addSheet": {"properties": {"title": "Q3"}}}]`; rename/delete sheets, formatting, etc. |

## OAuth setup

The connector uses Google's OAuth 2.0 authorization-code flow with PKCE.

1. In a Google Cloud project, enable the **Google Sheets API**.
2. Create an OAuth 2.0 Client ID with application type **Web application**.
3. Add this redirect URI, replacing the host with your Tangram instance:

   ```text
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.google/sheets
   ```

4. Add the scope requested by the manifest:

   ```text
   https://www.googleapis.com/auth/spreadsheets
   ```

The connector requests offline access and prompts for consent so Google issues a
refresh token. Tangram refreshes tokens automatically.

### Tangram publisher credentials

The connector shares the Google OAuth client used by the other `com.google`
connectors. Configure these publisher secrets in **Settings → Connector OAuth**:

- `googleClientId`
- `googleClientSecret`

## Install and connect

Install the connector globally or into one workspace through the Applications UI.
The default connection scope is **PerUser**, so each Tangram user connects their
own Google account. A per-workspace installation may instead select
**WorkspaceShared**.

The manifest does not deploy a Tangram-managed service; requests are sent through
the connector runtime to the pinned Google API host.

## Package layout

```text
manifests/
  app.pkl
  api/spec.pkl
  api/open_api.yml
  api/resources.pkl
  ui/spec.pkl
  ui/static/googlesheets.svg
```
