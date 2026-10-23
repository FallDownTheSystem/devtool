# dev

A terminal-first CLI for working with Bitbucket PRs, Jira tickets, and Confluence pages. Skip the browser, stay in your terminal.

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

`dev config set <connection>.<field> <value>` addresses a connection by name or type, so the older keys such as `bitbucket.workspace` keep working. Configuration from earlier versions, with one section per service, is converted to unnamed connections on first run.

## License

ISC
