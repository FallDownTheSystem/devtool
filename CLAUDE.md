# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`devtool` — a Node.js CLI (`dev`) for interacting with Bitbucket pull requests and Jira tickets from the terminal. Uses ES modules, commander for CLI parsing, and the `conf` package for persistent config storage.

## Commands

```bash
# Run the CLI
node src/index.js <command>

# Install globally for `dev` command
npm link
```

No build step, no tests, no linter configured yet.

## Architecture

```
src/
  index.js          # Entry point — commander program, registers subcommands, auto-setup hook
  config/store.js   # Conf-based config (persisted to OS config dir via `conf` package)
  clients/          # API clients (bitbucket.js uses fetch + Basic auth, jira.js uses jira.js SDK + Bearer token)
  commands/         # Commander subcommands (config, pr, jira)
  formatters/       # Output formatting — each has three variants: rich (colored tables), plain (compact text), JSON (curated objects)
  utils/
    output.js       # Shared UI primitives: spinner, table (cli-table3), heading, field, divider, mask
    errors.js       # handleError — maps HTTP status codes and connection errors to user-friendly messages
    mode.js         # getOutputMode — reads --json/--plain global flags, returns 'json'|'plain'|'rich'
```

### Output Mode Pattern

Every command supports three output modes via global flags `--json` and `--plain`:
- **rich** (default): colored output with tables (cli-table3) and spinners
- **plain**: no colors, no tables, compact text — suitable for piping
- **json**: curated JSON (not raw API responses) via `curate*Json` functions in formatters

Commands follow this pattern: check mode → conditionally show spinner → fetch data → format via mode-specific function. The `withMode` helper in `commands/pr.js` abstracts this for simple cases.

### Config

Stored via `conf` package (projectName: `devtool`). Interactive setup runs automatically on first use (preAction hook in index.js). Config keys:
- `bitbucket.{workspace, defaultRepo, email, token}`
- `jira.{baseUrl, token, defaultProject}`

### API Clients

- **Bitbucket** (`clients/bitbucket.js`): Raw fetch against `api.bitbucket.org/2.0`, Basic auth, manual pagination via `next` links
- **Jira** (`clients/jira.js`): Uses `jira.js` SDK (Version2Client) with Bearer token auth (overrides SDK's built-in Basic auth via request interceptor)
