# dev

A terminal-first CLI for Bitbucket PRs, Jira tickets, Confluence pages, Service Desk tickets, and Microsoft Graph. Microsoft Graph provides read-only access to Teams chats, email, calendars, and SharePoint.

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

dev jira view PROJ-123       # ticket details
dev jira comments PROJ-123   # ticket comments
dev jira search "sprint = 5" # JQL search
dev jira children PROJ-123   # epic children or subtasks (auto-detect)
dev jira mine                # your open tickets

dev confluence spaces        # list spaces
dev confluence view 12345    # read a page
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

## Config

Stored via the `conf` package in your OS config directory. Each connection has a type and its own fields:

- **bitbucket**: workspace, default repo, email, app password
- **jira**: base URL, API token, default project
- **confluence**: base URL, email, API token, default space. Cloud and Server/Data Center are detected from the base URL. For Server/Data Center, include any context path (`https://company.com/confluence`) and leave the email empty to use a personal access token, or set it to your username for Basic auth.
- **serviceDesk**: base URL, email, API token, default project
- **graph**: tenant ID, client ID, default SharePoint site (see [Microsoft Graph](#microsoft-graph))

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

Tokens use an OS-protected cache outside the repository, partitioned by tenant and client ID. Windows uses current-user DPAPI, macOS uses Keychain, and Linux requires Secret Service/libsecret. There is no plaintext fallback. Native dependency installation may require platform-specific build tools. `dev graph logout` removes the local cached account for the current tenant/client pair; it does not revoke grants or sign out browser sessions. Changing IDs selects another cache; log out before changing IDs if you want to remove the old account.

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

## License

ISC
