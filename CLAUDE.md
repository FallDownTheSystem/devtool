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

```bash
# Run the tests
npm test
```

No build step, no linter configured yet.

## Architecture

```
src/
  index.js          # Entry point — commander program, global flags, registers subcommands
  config/store.js   # Connection types, persistence (via `conf`), legacy migration, connection lookup
  config/setup.js   # Interactive prompts for adding and editing connections
  clients/          # API clients; every exported function takes the connection object as its first argument
  commands/         # Commander subcommands (config, pr, jira, confluence, sd)
  formatters/       # Output formatting — each has three variants: rich (colored tables), plain (compact text), JSON (curated objects)
  utils/
    output.js       # Shared UI primitives: spinner, table (cli-table3), heading, field, divider, mask
    errors.js       # handleError — maps HTTP status codes and connection errors to user-friendly messages
    mode.js         # getOutputMode — reads --json/--plain global flags, returns 'json'|'plain'|'rich'
    connection.js   # connectionFor — resolves the --connection global flag for a command's type
```

### Output Mode Pattern

Every command supports three output modes via global flags `--json` and `--plain`:
- **rich** (default): colored output with tables (cli-table3) and spinners
- **plain**: no colors, no tables, compact text — suitable for piping
- **json**: curated JSON (not raw API responses) via `curate*Json` functions in formatters

Commands follow this pattern: check mode → conditionally show spinner → resolve the connection with `connectionFor(this, type)` → fetch data → format via mode-specific function.

### Config

Stored via `conf` package (projectName: `devtool`) as a `connections` array. Each entry has a `type` (`bitbucket`, `jira`, `confluence`, `serviceDesk`, `graph`), an optional `name`, an optional `default` flag, and the string fields that `types` in `config/store.js` defines for that type. A field may define `validate` (checked by setup prompts and `config set`) and `normalize` (applied on every save); a type may define a `note` shown before its setup prompts. No configuration is required up front; a command fails with a hint only when its type has no connection.

- A connection's label is its name, or its type when unnamed. Labels are unique, so only one unnamed connection per type is allowed and names cannot equal a type.
- A reference (`--connection`, `config set <ref>.<field>`) matches a label first; a bare type falls back to that type's default connection.
- The default connection of a type is the one with `default: true`, otherwise the first of that type.
- Legacy top-level sections (`bitbucket`, `jira`, …) are migrated to unnamed connections when the store loads.

### API Clients

Clients do not read config; commands pass the resolved connection in. Per-site caches are keyed by site, not held as module singletons.

- **Bitbucket** (`clients/bitbucket.js`): Raw fetch against `api.bitbucket.org/2.0`, Basic auth, manual pagination via `next` links
- **Jira** (`clients/jira.js`): Uses `jira.js` SDK (Version2Client) with Bearer token auth (overrides SDK's built-in Basic auth via request interceptor); one client per base URL and token
- **Confluence** (`clients/confluence.js`): Cloud or Server/Data Center, detected per origin
- **Service Desk** (`clients/serviceDesk.js`): Jira Cloud REST v3 and the Service Desk API, Basic auth
- **Microsoft Graph** (`clients/graph.js`, `clients/graph-auth.js`, `clients/graph-cache.js`): delegated MSAL sign-in; the token cache is an AES-256-GCM file per tenant and client ID whose key lives in the OS credential store (`@napi-rs/keyring`), with a lock file spanning MSAL's read-modify-write; `commands/graph.js` builds the auth and client per invocation from the resolved connection
