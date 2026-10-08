# GitHub connector

Tangram OS ConnectorApp for the GitHub REST API. Proxies exactly one upstream host (`https://api.github.com`, pinned — not overridable at install,
so GitHub Enterprise Server is not supported) and exposes the repositories, issues, pull requests, code, and Actions runs visible to the OAuth
connection as agent tools. Every request carries `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.

Every call runs as the connected GitHub user: the tools see exactly the repositories that user can see, and writes (issues, comments, PRs,
reviews, re-runs) appear under that user's name.

## Agent tools

| Tool | Action | Notes |
|------|--------|-------|
| `github_get_user` | `User.Get` | The connected account's profile; its `login` is the owner for personal repos. |
| `github_list_repository` | `Repository.List` | Repos the user owns, collaborates on, or reaches via org membership; `visibility`, `affiliation`, `sort`. |
| `github_get_repository` | `Repository.Get` | One repo by `owner`/`repo`: default branch, visibility, open issue count. |
| `github_list_issue` | `Issue.List` | Filter by `state`, `labels`, `assignee`, `since`. **Includes pull requests** — entries with a `pull_request` field are PRs. |
| `github_get_issue` | `Issue.Get` | One issue by number. |
| `github_create_issue` | `Issue.Create` | **Confirmation-gated** (irreversible: notifies watchers; the API can close but not delete issues). |
| `github_update_issue` | `Issue.Update` | **Confirmation-gated.** Edit title/body, close/reopen (`state`, `state_reason`); `labels`/`assignees` replace wholesale. |
| `github_list_issuecomment` | `IssueComment.List` | Conversation comments on an issue or PR (pass the PR number as `issue_number`). |
| `github_create_issuecomment` | `IssueComment.Create` | **Confirmation-gated** (irreversible: participants are notified). |
| `github_list_pullrequest` | `PullRequest.List` | Filter by `state`, `head` (`user:branch`), `base`. |
| `github_get_pullrequest` | `PullRequest.Get` | Head/base, `mergeable`, `merged`, diff stats. |
| `github_listfiles_pullrequest` | `PullRequest.ListFiles` | Changed files with per-file `patch` (omitted for binary/huge diffs). |
| `github_create_pullrequest` | `PullRequest.Create` | **Confirmation-gated** (irreversible). `head` branch must already exist; `draft` supported. |
| `github_review_pullrequest` | `PullRequest.Review` | **Confirmation-gated** (irreversible). `event` `APPROVE` / `REQUEST_CHANGES` / `COMMENT`; the last two need a `body`. |
| `github_issues_search` | `Search.Issues` | GitHub query syntax; always include `is:issue` or `is:pr`. |
| `github_code_search` | `Search.Code` | Default branches only; returns paths + blob shas (read with `github_get_blob`). |
| `github_get_content` | `Content.Get` | **Top-level names only** (`README.md`, `src`) — see Notes. |
| `github_get_tree` | `Tree.Get` | Repo file listing; `recursive=1` walks everything in one call. |
| `github_get_blob` | `Blob.Get` | File content by blob sha (base64). |
| `github_list_workflowrun` | `WorkflowRun.List` | Actions runs, newest first; filter by `branch`, `status`, `event`. |
| `github_rerun_workflowrun` | `WorkflowRun.Rerun` | **Confirmation-gated** (irreversible: repeats tests/deploys and uses Actions minutes). |

## OAuth setup

The connector uses GitHub's OAuth App authorization-code flow (with PKCE). You need a GitHub OAuth App, its credentials stored in Tangram, then each
user connects their own GitHub account.

### 1. GitHub OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App** (or the same page under an organization's settings to own it as
   the org).
2. Set **Authorization callback URL**, using your Tangram instance's public base URL:

   ```
   https://<tangram-host>/api/core/v1/connector-oauth/callback/com.github/github
   ```

3. **Generate a new client secret** — this is the value for `githubClientSecret` below.

This is an OAuth App, not a GitHub App: GitHub App user tokens expire after 8 hours and use fine-grained permissions instead of scopes, which this
manifest does not model.

### 2. Tangram publisher credentials

The manifest references two Tangram system secrets:

- `githubClientId` — the OAuth App's *Client ID*
- `githubClientSecret` — the client secret value

Set them in **Settings → Connector OAuth** (publisher credentials; stored in the `tangram_os` system workspace). This works pre-install — the
credentials are resolved from the app catalog, so you can configure them before or after installing the app.

### 3. Install

Register/publish the app to your instance's App Hub, then install it either globally (shared `tangram_os_shared` workspace, usable from every
workspace) or into a single workspace. Note: the CLI `app install` path doesn't carry connector deployment params; install via the UI.

### 4. Connect an account

Connection scope defaults to **PerUser**: each Tangram user links their own GitHub account. `WorkspaceShared` (one account — e.g. a bot user — for a
whole workspace) is also allowed at install time for per-workspace installs; it is rejected on the shared global workspace, which is per-user only.

Organizations with **OAuth App access restrictions** hide their repositories from the token until an org owner approves the app (the consent screen
offers a *Request* / *Grant* button per org).

### Scopes

Classic OAuth App scopes are coarse:

- `repo` — required to see private repositories at all, and the only OAuth App scope that permits writing issues, comments, PRs, reviews, and
  workflow re-runs. GitHub OAuth Apps have no narrower write scope, so the token can also push code — the connector simply exposes no action that
  does; every write action it does expose is confirmation-gated.
- `read:org` — org membership, so org-owned repositories show up in listings.

### Token lifetime and revocation

By default OAuth App tokens don't expire: the exchange returns no `refresh_token` or `expires_in`, so Tangram stores the token without an expiry.
If the OAuth App enables GitHub's optional **expiring user tokens**, the exchange returns `expires_in` + `refresh_token` and Tangram refreshes the
token 10 minutes before it expires. A token dies when the user revokes it at **github.com/settings/applications**, or after one year of non-use. The manifest declares no
`revocationUrl`: GitHub revokes through `DELETE /applications/{client_id}/grant` with Basic client auth, which is not RFC 7009, so disconnecting in
Tangram only drops the local token — revoke on GitHub to remove the grant upstream.

GitHub echoes granted scopes comma-separated (`"read:org,repo"`); Tangram parses that form.

## Notes

- **Pagination:** list and search tools take `per_page` (default 30, max 100) and 1-based `page`. GitHub signals more pages in the `Link` response
  header (`rel="next"`); a page shorter than `per_page` is the last one. Search reaches at most the first 1000 results.
- **Rate limits:** 5,000 requests/hour per user token; search has its own budget (30/minute for issues, 10/minute for code). Exceeding returns 403
  or 429 with `x-ratelimit-reset`.
- **Reading files:** the platform escapes `/` inside path parameters (`%2F`) so a value stays one URL segment, and GitHub's contents endpoint answers
  404 for an escaped nested path. `github_get_content` is therefore modeled for top-level names only. For nested files, call `github_get_tree`
  (`tree_sha` = branch name or commit sha, `recursive=1`) to find the file's blob sha, or `github_code_search`, then `github_get_blob`. Branch names
  containing `/` hit the same escaping in `tree_sha` — pass the commit sha (`head.sha` from a PR, or `head_sha` from a run) instead.
- Issue and PR numbers share one sequence per repo; the issue endpoints (`github_get_issue`, `github_list_issuecomment`,
  `github_create_issuecomment`) accept PR numbers too.
- The OpenAPI spec is a curated subset of the upstream API; extend it by adding operations to `api/open_api.yml` and mapping them to actions in
  `api/resources.pkl`.
