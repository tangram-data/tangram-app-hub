# Google Slides connector

Tangram OS ConnectorApp for the Google Slides API. It proxies the pinned
`https://slides.googleapis.com` host and exposes presentations available to the
connected Google account as agent tools.

The Slides API does not provide file discovery. To find an existing presentation,
use the Google Drive connector's `drive_list_file` tool with the MIME type
`application/vnd.google-apps.presentation`, then pass the returned file id as the
`presentationId` here.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `slides_create_presentation` | `Presentation.Create` | Create an empty presentation with a title; returns its presentation id. |
| `slides_get_presentation` | `Presentation.Get` | Read slides, layouts, masters, and page elements; optional `fields` mask trims the payload. |
| `slides_update_presentation` | `Presentation.Update` | **Confirmation-gated.** Apply an ordered batch of Slides edit requests. |
| `slides_get_page_presentation` | `Presentation.GetPage` | Read one slide by its page object id. |

Batch updates accept Google Slides request objects for operations such as creating
slides, inserting text or images, and applying styles. Requests run in order in a
single `presentations.batchUpdate` call.

## OAuth setup

The connector uses Google's OAuth 2.0 authorization-code flow with PKCE.

1. In a Google Cloud project, enable the **Google Slides API**.
2. Create an OAuth 2.0 Client ID with application type **Web application**.
3. Add this redirect URI, replacing the host with your Tangram instance:

   ```text
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.google/slides
   ```

4. Add the scope requested by the manifest:

   ```text
   https://www.googleapis.com/auth/presentations
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
  ui/static/googleslides.svg
```
