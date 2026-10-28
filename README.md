# dev

A terminal-first CLI for Bitbucket PRs, Jira tickets, Confluence pages, Service Desk tickets, and Microsoft Graph. Bitbucket, Jira, Confluence, and Service Desk can also create, change, and delete data when a connection allows it (see [Writing](#writing)). Microsoft Graph provides read-only access to Teams chats, email, calendars, and SharePoint.

## Install

```bash
npm install -g @falldownthesystem/devtool
```

This gives you the `dev` command globally. Add a connection for each service you use with `dev config add`; services you don't use need no configuration.

## Usage

```bash
dev pr list                  # your open PRs
dev pr view 42               # PR details, reviewers, status
dev pr comments 42           # review comments
dev pr diff 42               # changed files
dev pr activity 42           # approvals, updates, comments

dev jira view PROJ-123       # ticket details, with resolution, time tracking, versions, due date, parent
dev jira view PROJ-123 --fields Account,"Story Points"   # extra fields by ID or display name
dev jira view PROJ-123 --all-fields                    # every non-empty field (--json adds raw values)
dev jira fields PROJ-123     # fields an edit can set: type, required, allowed values
dev jira fields --create --project PROJ --type Bug     # fields a new issue takes; required first
dev jira comments PROJ-123   # ticket comments
dev jira search "sprint = 5" # JQL search
dev jira children PROJ-123   # epic children or subtasks (auto-detect)
dev jira mine                # your open tickets

dev confluence spaces        # list spaces
dev confluence view 12345    # read a page, with labels, ancestors, and the version author and date
dev confluence view 12345 --children   # also list child pages
dev confluence attachments 12345       # attachment names, sizes, media types, IDs
dev confluence pages         # pages in a space
dev confluence search "auth" # CQL search

dev config setup             # add or edit connections interactively
dev config add jira -n work  # add a named Jira connection
dev config edit work         # edit a connection interactively
dev config remove work       # remove a connection
dev config default work      # make it the default for its type
dev config show              # all connections (tokens masked)
dev config set <key> <value> # set a single field, e.g. work.baseUrl
```

Most commands have short aliases: `ls`, `read`, `find`, `my`.

### Jira Cloud and Server/Data Center

`dev jira` works with Jira Cloud (including Service Desk) and Jira Server/Data Center, like `dev confluence` does for Confluence. The connection's site decides the format: Cloud takes ADF and account IDs, Server takes wiki markup and user names. The deployment is detected (an `atlassian.net` host or a `serverInfo` answer of `Cloud` is Cloud; a connection without an email is Server, which signs in with a personal access token), or set it with `dev config set <connection>.deployment cloud|server`.

List the project keys of each site on its connection, and an issue key picks the connection by itself:

```bash
dev config set work.projects PROJ,OPS        # Jira Server
dev config set cloud.projects SQTUKI         # Jira Cloud
dev jira view SQTUKI-12320                   # uses "cloud" without --connection
```

A connection's default project counts too. A key that matches no connection uses the default Jira connection; `--connection` always wins. Commands without an issue key (`search`, `mine`, `queues`) take `--project <key>` to pick the connection.

On Cloud, `dev jira comment add` writes an internal comment unless `--public`; `dev jira queues` and `dev jira queue <name>` read Service Desk queues and fail on a project without one. `dev sd` (alias `servicedesk`) is kept for existing notes and scripts: it has the same commands and, without a project match, uses the default `serviceDesk` connection. Pending actions held as `sd.*` by earlier versions can still be approved.

### Raw reads: `dev api`

`dev api` reads any REST endpoint of a configured connection that the other commands do not cover. The CLI adds the connection's base URL and credentials; it never prints them.

```bash
dev api jira /rest/api/2/issue/PROJ-1/editmeta
dev api jira /rest/api/2/issue/PROJ-1 --query fields=customfield_15300,timetracking,resolution
dev api serviceDesk /rest/api/3/field --select '[].{id,name,schema}'
dev api confluence /rest/api/content/123 --query expand=version,ancestors,metadata.labels
dev api bitbucket /repositories/my-workspace/my-repo/pullrequests --query state=MERGED --all-pages
```

- `<connection>` is a connection name, or a type for its default connection, as with `--connection`.
- `<path>` is relative to the connection's base URL: the site for Jira and Service Desk, `/wiki` on Confluence Cloud or the context path on Server/Data Center, and `https://api.bitbucket.org/2.0` for Bitbucket. Absolute and scheme-relative URLs, `.`/`..` segments (also percent-encoded), and backslashes are rejected, and redirects are not followed, so credentials only go to the connection's own site.
- **Read-only.** Requests are GET. `--post '<json>'` is accepted only for a short list of POST endpoints that only read (JQL search: Jira `/rest/api/2/search`, Jira Cloud `/rest/api/3/search/jql` and `/rest/api/3/search/approximate-count`). Writes go through the write commands and their approval flow.
- Output is JSON, indented by default and compact with `--plain` or `--json`. `--raw` prints the body unchanged; non-JSON bodies print as text.
- `--select` projects the JSON: dot paths (`issues.0.key`), `[]` for each item of an array or each value of an object (`issues[].key`), and `{a,b.c}` to pick keys (`issues[].{key,fields.summary}`; keys are named by the path as written).
- `--all-pages` follows `startAt`/`maxResults`/`total` (Jira), `nextPageToken`/`isLast` (Jira Cloud), `_links.next` (Confluence, Service Desk API), and `next` (Bitbucket), up to `--limit` items (default 1,000). Without it, one page is returned and standard error shows how to get the next.

### Timeouts

Every API request gives up after 30 seconds with a timeout error instead of hanging. Set `DEV_TIMEOUT=<seconds>` to change it.

### Output modes

Every command supports three output formats:

```bash
dev pr list              # colored tables (default)
dev pr list --plain      # no colors, no tables, pipe-friendly
dev pr list --json       # curated JSON, not raw API dumps
```

### Multiple connections

You can add any number of connections of each type. A connection's name is optional: an unnamed connection is referred to by its type (`jira`), and only one unnamed connection per type is allowed. Commands use the default connection of their type; pick another with `--connection`:

```bash
dev jira view PROJ-123                # default Jira connection
dev jira view OPS-7 --connection work # the Jira connection named "work"
dev confluence spaces -c wiki         # the Confluence connection named "wiki"
```

The default is the connection marked with `dev config default`, or otherwise the first connection of that type.

## Writing

Every Bitbucket, Jira, Confluence, and Service Desk connection has two settings:

- **allowWrite** (default `false`): commands that create, change, or delete data fail on this connection until it is enabled. Reads always work.
- **requireApproval** (default `true`): a write does not run at once. The CLI stores the exact change as a *pending action*, prints its ID, and exits with status `2`.

Set them in `dev config setup` / `dev config edit <connection>`, or directly:

```bash
dev config set work.allowWrite true
dev config set work.requireApproval false   # run writes at once on this connection
```

The settings are a guard against accidental writes, for example by an AI agent that uses the CLI. They are not a security boundary: anything that can run `dev` can also change its configuration.

### Approval

```bash
$ dev jira comment add PROJ-123 "Deployed to staging."
Approval required [3f9a2c1e]: Add a comment to PROJ-123
  Connection: jira
  Issue: PROJ-123
  Comment: Deployed to staging.
Nothing was sent. Show this action to the user and run the approve command only after the user approves it.
If the user asks for changes, run the command again with the changes and add --replaces 3f9a2c1e.
Approve: dev pending approve 3f9a2c1e
Reject:  dev pending reject 3f9a2c1e
Expires: 2026-10-28T09:00:00.000Z

$ dev pending approve 3f9a2c1e
✓ Added comment 10234 to PROJ-123
```

`dev pending approve` runs the stored action, not the original command again, so what runs is exactly what was shown. The preview reads the current state where that helps a decision: the summary of an issue to delete, the text of a comment to edit or delete, the pull request to merge, the transition and its target status, and the page version an edit is based on. A Confluence edit is sent against that version, so a page that changed in the meantime fails with a conflict instead of being overwritten.

```bash
dev pending                  # list pending actions
dev pending show <id>        # details; --json includes the full parameters
dev pending approve <id>     # run it
dev pending reject <id>      # discard it
```

The global `--approve` flag runs a write at once, without a pending action. Use it only when the user approved that exact change.

A pending action cannot be edited. When the user asks for changes, run the command again with the changes and `--replaces <id>`:

```bash
dev jira comment add PROJ-123 "Deployed to production." --replaces 3f9a2c1e
```

The new request is held as a new pending action, and `3f9a2c1e` is discarded, so the version the user turned down can no longer be approved by mistake. An unknown or expired ID stops the command before anything is held or sent. With `--approve`, the old action is discarded only if the new write succeeds.

Pending actions expire after 24 hours. Approval checks again that the connection exists, still points to the same site, and allows writes. A held merge also fails if the pull request got new commits after the preview. If the server refuses the request (4xx), the action stays pending; if the outcome is unknown (a 5xx error or a timeout), it is removed so it cannot run twice. With `--json`, a held write prints `{"status": "pending_approval", "id": ..., "approve": "dev pending approve <id>", ...}`.

### Write commands

Text can be given inline or with `--file <path>` (`-` reads standard input), which keeps multi-line text out of shell quoting. Comment listings show comment IDs.

```bash
# Jira Cloud and Server/Data Center (dev jira; dev sd is an alias)
dev jira create --summary "Fix login" --type Bug --project PROJ -d "Steps..."
dev jira edit PROJ-1 --summary "New" --labels a,b --assignee jdoe --field customfield_10010=5
dev jira edit PROJ-1 --unassign
dev jira delete PROJ-1 [--delete-subtasks]
dev jira transitions PROJ-1                  # list available transitions (read)
dev jira transition PROJ-1 "In Progress"     # by transition name, ID, or target status
dev jira comment add PROJ-1 "text"           # or --file notes.txt
dev jira comment edit PROJ-1 <commentId> "text"
dev jira comment delete PROJ-1 <commentId>
dev jira comment add TUKI-1 "text"           # Cloud: internal note by default
dev jira comment add TUKI-1 "text" --public  # Cloud: reply visible to the customer
dev jira worklog list PROJ-1                 # worklogs (read)
dev jira worklog add PROJ-1 "1h 30m" --started 2026-10-28 -m "Review" [--remaining 2h | --keep-remaining]
dev jira worklog delete PROJ-1 <worklogId>

# Bitbucket
dev pr create --title "Add X" --source feature/x [--destination main] [-d "..."] [--reviewer <accountId>]
dev pr edit 42 --title "New title"
dev pr merge 42 [--strategy squash] [--close-source-branch]
dev pr decline 42
dev pr approve 42                            # Bitbucket review approval
dev pr unapprove 42
dev pr request-changes 42
dev pr comment add 42 "text" [--path src/a.js --line 10]
dev pr comment edit 42 <commentId> "text"
dev pr comment delete 42 <commentId>

# Confluence (bodies are storage format XHTML; --text converts plain text)
dev confluence view 12345 --storage          # current body in storage format
dev confluence create --title "Notes" --space DEV [--parent 12345] --file page.xhtml
dev confluence edit 12345 --file page.xhtml [--title "New"] [-m "version comment"]
dev confluence delete 12345
dev confluence comments 12345                # list comments (read)
dev confluence comment add 12345 "Looks good" --text
dev confluence comment delete <commentId>
```

Text is plain text on Jira Cloud, converted to paragraphs, and wiki markup on Server/Data Center; `--assignee` is an account ID on Cloud and a user name on Server. The approval preview of an edit shows each changed field's current value next to the new one. `worklog add` starts now by default; a date alone starts at 09:00 local time. It reduces the remaining estimate by the time logged unless `--remaining` or `--keep-remaining` is given; Tempo on Jira Server records worklogs made through this API.

`--field <name>=<value>` takes a field ID or display name (`--field Account=23533`, `--field "Story Points=5"`). Before anything is held or sent, the field is looked up in the create metadata (create) or edit metadata (edit) and the value is converted to what its schema expects: text and plugin fields get a string, numbers a number, option and select fields `{"id": ...}` for an allowed value (matched by value, name, or ID) or `{"value": ...}`, user fields the user reference of the site, and array fields a comma-separated list. JSON (`{...}`, `[...]`, a quoted `"..."`, or `null`) is sent unchanged, e.g. `--field 'customfield_1={"value":"High"}'`. A value that does not fit, a field that is not on the screen, or a required field missing on create fails with the field's name, type, and some allowed values. The approval preview shows each field as `Name (id)` with the value that is sent. `dev jira fields` lists the fields and their types.

## Config

Stored via the `conf` package in your OS config directory. Each connection has a type and its own fields:

- **bitbucket**: workspace, default repo, email, app password
- **jira**: base URL, email (Cloud; on Server/Data Center empty for a personal access token, or a username for Basic auth), API token, default project, project keys, deployment (optional)
- **confluence**: base URL, email, API token, default space. Cloud and Server/Data Center are detected from the base URL. For Server/Data Center, include any context path (`https://company.com/confluence`) and leave the email empty to use a personal access token, or set it to your username for Basic auth.
- **serviceDesk**: base URL, email, API token, default project, project keys (a Jira Cloud connection; kept for `dev sd`)
- **graph**: tenant ID, client ID, default SharePoint site (see [Microsoft Graph](#microsoft-graph))

Bitbucket, Jira, Confluence, and Service Desk connections also have the `allowWrite` and `requireApproval` settings (see [Writing](#writing)).

### Tokens

A connection's token is looked up in this order:

1. the config file (`dev config set <connection>.token <value>`)
2. the environment variable `DEV_<CONNECTION>_TOKEN`, e.g. `DEV_WORK_TOKEN`, or `DEV_JIRA_TOKEN` for an unnamed Jira connection (characters other than letters and digits become `_`)
3. the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service), under service `devtool` and account `<connection>.token`

```bash
dev config token work                 # hidden prompt; stores the token in the credential store
op read op://vault/jira | dev config token work   # or from standard input
dev config token work --move          # move the token from the config file to the credential store
dev config token work --remove        # delete it from the credential store
```

Storing a token removes it from the config file, which would otherwise be used first. `dev config add` and `dev config edit` offer the credential store when you enter a token. Renaming a connection moves its entry, and removing the connection deletes it. `dev config show` shows where each token comes from, masked.

`dev config set <connection>.<field> <value>` addresses a connection by name or type, so the older keys such as `bitbucket.workspace` keep working. Configuration from earlier versions, with one section per service, is converted to unnamed connections on first run.

## Microsoft Graph

A Graph connection uses one application registration and one sign-in for all four services. No PAT or client secret is required. Graph commands do not require Bitbucket or Jira configuration. Like other connection types, you can add several Graph connections (for example one per tenant) and pick one with `--connection`.

### Application registration and setup

1. Register a single-tenant application in the [Microsoft Entra admin center](https://entra.microsoft.com).
2. Under **Authentication**, add **Mobile and desktop applications** with redirect URI `http://localhost`.
3. Add Microsoft Graph **delegated** permissions: `User.Read`, `Chat.Read`, `Mail.Read`, `Sites.Read.All`.
4. Obtain administrator approval if your organization requires it.
5. Run the Graph wizard, then sign in through your browser:

```bash
dev graph setup                  # edits the selected Graph connection, or adds one; also: dev config add graph
dev graph login
dev graph status                 # cached account only, not a token-validity check
```

The wizard asks for the **Directory (tenant) ID**, **Application (client) ID**, and an optional default SharePoint site URL. These IDs are not secrets. You can also set them individually:

```bash
dev config set graph.tenantId <tenant-uuid>
dev config set graph.clientId <client-uuid>
dev config set graph.defaultSite https://company.sharepoint.com/sites/MySite
```

`graph.<field>` addresses the default Graph connection; use `<name>.<field>` for a named one. Setup and login require an interactive terminal without `--json` or `--plain`. Data commands never prompt or open a browser. If sign-in expires or needs fresh consent, run `dev graph login` again.

Tokens are kept in a cache file outside the repository, partitioned by tenant and client ID and encrypted with AES-256-GCM. The encryption key is stored in the OS credential store: Windows Credential Manager, macOS Keychain, or Linux Secret Service (required on Linux). There is no plaintext fallback. The credential store binding ships prebuilt for each platform, so installation needs no build tools or install scripts. `dev graph logout` removes the local cached account for the current tenant/client pair; it does not revoke grants or sign out browser sessions. Changing IDs selects another cache; log out before changing IDs if you want to remove the old account.

For one sign-in covering every supported service, add the optional delegated permissions `Mail.Read.Shared`, `Calendars.Read.Shared`, and `Calendars.ReadBasic`, then run:

```bash
dev graph login --all
```

This is an alternative to the individual login flags, not an additional login step. The application name in the consent screen comes from your Entra registration. A permission marked **Admin consent required: No** can still require approval under your organization's user-consent policy. Changing authentication flows does not bypass that policy.

### Teams chats

```bash
dev graph teams chats --limit 25
dev graph teams view "<chat-id>"
dev graph teams messages "<chat-id>" --limit 50
dev graph teams message "<chat-id>" "<message-id>"
```

This covers your chats, not Teams channels. Expanded chat member lists can stop at 25 members.

### Email

```bash
dev graph mail folders
dev graph mail folders --parent "<folder-id>"
dev graph mail list --folder inbox --limit 25
dev graph mail search 'subject:release' --limit 50
dev graph mail view "<message-id>"
```

`email` is an alias for `mail`. Reads do not mark messages as read. Search uses Microsoft's message search syntax and service-defined order, with a maximum of 1,000 matches. The CLI displays message bodies as text; it does not download email attachments.

For shared mailboxes or another person's shared folders, add the **delegated** `Mail.Read.Shared` permission and sign in with that scope:

```bash
dev graph login --shared-mail
dev graph mail --mailbox shared@company.com folders
dev graph mail --mailbox shared@company.com list --folder inbox
dev graph mail --mailbox owner@company.com view "<message-id>" --folder "<shared-folder-id>"
```

You also need Exchange access to the mailbox or folder. `Mail.Read` alone covers only your own mailbox. `--mailbox` accepts the mailbox owner's address or user ID; Graph does not discover your shared mailboxes. With folder-only access, specify that folder instead of requesting the entire mailbox. Normal commands do not request shared-mail permission.

### Calendars

Add the **delegated** `Calendars.Read.Shared` and `Calendars.ReadBasic` permissions, then sign in with `--calendars` (or `--all`). These cover calendar details and the free/busy query. Calendar details include your calendars and shared calendars you already have permission to read. It does not grant new Exchange access or allow event changes.

```bash
dev graph login --calendars
dev graph login --calendars --shared-mail   # both optional permissions in one sign-in
dev graph calendar list
dev graph calendar next
dev graph calendar events --limit 50
dev graph calendar events --from 2026-09-14T00:00:00+03:00 --to 2026-09-21T00:00:00+03:00
dev graph calendar --calendar "<calendar-id>" next
dev graph calendar --mailbox owner@company.com --calendar "<calendar-id>" events
dev graph calendar --calendar "<calendar-id>" view "<event-id>"
```

`calendars` aliases `calendar`. `list` returns calendars in the addressed mailbox, including shared calendars added there. Supply `--mailbox` to address the owner directly when needed. Calendar IDs belong to the mailbox context that returned them. The permission does not discover every calendar across the organization.

`events`, `next`, and `view` use the primary calendar unless you supply `--calendar`; they do not merge all calendars. Event times use UTC. Date inputs require ISO 8601 with an explicit timezone. The default window starts now and ends 30 days later; custom windows can span up to 366 days. The client expands recurring meetings through `calendarView`, reads the complete window (up to 1,000 events), and sorts before selecting results. If the window exceeds 1,000 events, narrow the date range instead of accepting an unreliable next event.

`next` finds the next appointment or meeting in the selected calendar. It excludes cancelled, declined, and already-started events. If no event qualifies, the result includes the checked date range. It does not change attendance, read status, or calendar contents.

### Other users' free/busy times

```bash
dev graph calendar availability colleague@company.com
dev graph calendar availability colleague@company.com room@company.com --from 2026-09-14T09:00:00+03:00 --to 2026-09-14T17:00:00+03:00 --interval 30
```

This calls Microsoft's read-only `getSchedule` query using `Calendars.ReadBasic`. It requires no event creation or attendance changes. Unlike full shared-calendar details, free/busy availability follows Exchange publishing and organization sharing policies. Private subjects and details may remain hidden.

Supply 1–20 email addresses, not `--mailbox` or `--calendar`. The default range is now through 24 hours later. Custom ranges must be shorter than 62 days; intervals accept 5–1440 minutes. Results include UTC blocks and a compact slot string: `0` = free or working elsewhere, `1` = tentative, `2` = busy, `3` = out of office. Per-person errors remain visible and cause a nonzero exit status; missing or denied availability never means free. If Microsoft reports error `5006`, narrow the range or increase the interval.

### SharePoint

```bash
dev graph sharepoint sites "Product"
dev graph sharepoint site
dev graph sharepoint --site https://company.sharepoint.com/sites/Other libraries
dev graph sharepoint libraries
dev graph sharepoint files "<drive-id>"
dev graph sharepoint files "<drive-id>" --path "Product Data/Documentation/My Product"
dev graph sharepoint files "<drive-id>" --folder "<folder-item-id>"
dev graph sharepoint file "<drive-id>" "<item-id>"
dev graph sharepoint download "<drive-id>" "<item-id>" "./document.pdf"
dev graph sharepoint lists
dev graph sharepoint items "<list-id>"
dev graph sharepoint item "<list-id>" "<item-id>"
```

`sp` is an alias for `sharepoint`. Site-based commands use the connection's default site unless you supply `--site`. File commands use the explicit drive ID. Select the **Documents** library from `libraries`; `--path` starts inside that library, so omit the `Documents/` prefix. File downloads use a temporary file and expose the destination only after the transfer completes. An atomic hard link prevents overwriting a destination created concurrently; the destination filesystem must support hard links. Normal failures clean up temporary files. A forced process termination may leave a `.devtool-download-*` temporary directory, but never a partial destination. Each download request defaults to a 120-second timeout; use `--timeout <seconds>` (1–86400) for slower transfers. Other Graph requests have a 60-second timeout. The download changes no remote data and sends no Graph bearer token to the SharePoint download host.

### Output and limits

All Graph data commands support rich tables, `--plain`, and curated `--json`. Collection commands default to 25 results; `--limit` accepts 1–1000. The client follows server pagination up to that limit, so more results can exist. JSON lists are arrays. Errors go to stderr with a nonzero exit status; `--json` errors use `{"error":{"message":"...","status":403}}`. Authentication tokens, raw Graph metadata, and preauthenticated file download URLs never appear in curated output.

Content reads use GET. The only POST is the fixed `/me/calendar/getSchedule` endpoint, which computes free/busy information without changing data. The CLI has no Graph mail-send, message-send, upload, update, or delete commands.

## Development

```bash
npm test
```

The Node.js test suite uses mock Graph and authentication responses, temporary configuration, and local download fixtures. It does not access Microsoft 365 data.

Releases are automated: every push to `master` with a user-facing [Conventional Commit](https://www.conventionalcommits.org/) publishes a patch release to npm through release-please, and Dependabot's minor and patch updates merge and release on their own. See [CLAUDE.md](CLAUDE.md#release--ci-automation).

## License

ISC
