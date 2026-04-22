# dev

A terminal-first CLI for working with Bitbucket PRs, Jira tickets, and Confluence pages. Skip the browser, stay in your terminal.

## Install

```bash
npm install
npm link
```

This gives you the `dev` command globally. On first run, it'll walk you through connecting your Bitbucket, Jira, and Confluence accounts.

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

dev config setup             # re-run setup
dev config show              # current config (tokens masked)
dev config set <key> <value> # set a single value
```

Most commands have short aliases: `ls`, `read`, `find`, `my`.

### Output modes

Every command supports three output formats:

```bash
dev pr list              # colored tables (default)
dev pr list --plain      # no colors, no tables, pipe-friendly
dev pr list --json       # curated JSON, not raw API dumps
```

## Config

Stored via the `conf` package in your OS config directory. You'll need:

- **Bitbucket**: workspace, default repo, email, app password
- **Jira**: base URL, API token, default project
- **Confluence**: uses the same Jira base URL and token

## License

ISC
