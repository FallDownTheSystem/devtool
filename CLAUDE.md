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
  config/pending.js # Pending write actions awaiting approval, one JSON file each under <config dir>/pending
  clients/          # API clients; every exported function takes the connection object as its first argument
  actions/          # Write actions (prepare/summary/details/run/report); index.js is the registry by action name
  commands/         # Commander subcommands (config, pr, jira, confluence, pending, api); jira.js builds `dev jira` and its alias `dev sd`, with issueWrites.js and issueFields.js
  formatters/       # Output formatting — each has three variants: rich (colored tables), plain (compact text), JSON (curated objects)
  utils/
    output.js       # Shared UI primitives: spinner, table (cli-table3), heading, field, divider, mask
    errors.js       # handleError — maps HTTP status codes and connection errors to user-friendly messages
    mode.js         # getOutputMode — reads --json/--plain global flags, returns 'json'|'plain'|'rich'
    connection.js   # connectionFor — resolves the --connection global flag for a command's type
    write.js        # runWrite — the gate every write command goes through; execute, text and --field helpers
    markup.js       # Conversions between plain text, ADF (Jira Cloud), and Confluence storage format
    http.js         # jsonInit, apiError, and the request timeout (DEV_TIMEOUT), shared by the clients
    api.js          # `dev api`: path validation, the --select projection, pagination across API styles
    jiraFields.js   # Jira field metadata, name resolution, schema-aware --field values, readable field values
    deployment.js   # Cloud or Server/Data Center detection of a Confluence site, per origin
```

### Writes

Every write command calls `runWrite(cmd, action, buildInput)`. It refuses unless the connection has `allowWrite`; then `action.prepare` validates, resolves defaults, and reads what `run` needs (Confluence page version, transition ID). With `requireApproval` (the default) and no global `--approve`, `action.preview` reads display-only state (current comment text, PR head), the params are stored as a pending action with the connection's `writeTarget` site, and the command exits with status 2; `dev pending approve <id>` checks the site, runs `action.verify` (state that must not have changed, e.g. a PR head before merge), and then runs the stored params through `execute`, so what runs is exactly what was previewed. Summaries and details are derived from the stored params, never stored. Approval restores the pending action when the server answered with an error, and drops it when the outcome is unknown. A new write operation is a client function, an action registered through `actions/index.js`, and a command that calls `runWrite`. `dev api` is read-only: it sends GET, and POST only to the `READ_ONLY_POST` endpoints in `commands/api.js`; each client's `apiTarget` supplies its base URL and auth header.

### Output Mode Pattern

Every command supports three output modes via global flags `--json` and `--plain`:
- **rich** (default): colored output with tables (cli-table3) and spinners
- **plain**: no colors, no tables, compact text — suitable for piping
- **json**: curated JSON (not raw API responses) via `curate*Json` functions in formatters

Commands follow this pattern: check mode → conditionally show spinner → resolve the connection with `connectionFor(this, type)` → fetch data → format via mode-specific function.

### Config

Stored via `conf` package (projectName: `devtool`) as a `connections` array. Each entry has a `type` (`bitbucket`, `jira`, `confluence`, `serviceDesk`, `graph`), an optional `name`, an optional `default` flag, the boolean `settings` (`allowWrite`, `requireApproval`) for `writable` types, and the string fields that `types` in `config/store.js` defines for that type. A field may define `validate` (checked by setup prompts and `config set`) and `normalize` (applied on every save); a type may define a `note` shown before its setup prompts. No configuration is required up front; a command fails with a hint only when its type has no connection.

- A connection's label is its name, or its type when unnamed. Labels are unique, so only one unnamed connection per type is allowed and names cannot equal a type.
- A reference (`--connection`, `config set <ref>.<field>`) matches a label first; a bare type falls back to that type's default connection.
- The default connection of a type is the one with `default: true`, otherwise the first of that type.
- Legacy top-level sections (`bitbucket`, `jira`, …) are migrated to unnamed connections when the store loads.

### API Clients

Clients do not read config; commands pass the resolved connection in. Per-site caches are keyed by site, not held as module singletons.

- **Bitbucket** (`clients/bitbucket.js`): Raw fetch against `api.bitbucket.org/2.0`, Basic auth, manual pagination via `next` links
- **Jira** (`clients/jira.js`): `site(connection)` picks the client and value formats (`text`, `user`) for a `jira` or `serviceDesk` connection; the deployment comes from the `deployment` field, the host, the email, or `/rest/api/2/serverInfo`. Issue keys route to the connection whose `projects` or `defaultProject` lists them (`getConnection(types, ref, project)`); actions name the key with `route`.
- **Jira Server/Data Center** (`clients/jiraServer.js`): `jira.js` SDK (Version2Client); Bearer for a personal access token, Basic when the connection has an email
- **Jira Cloud** (`clients/jiraCloud.js`): REST v3 and the Service Desk API, Basic auth; comments are internal unless public
- **Confluence** (`clients/confluence.js`): Cloud or Server/Data Center, detected per origin
- **Service Desk** (`clients/serviceDesk.js`): the Jira Cloud client, with comments through the Service Desk API as before
- **Microsoft Graph** (`clients/graph.js`, `clients/graph-auth.js`, `clients/graph-cache.js`): delegated MSAL sign-in; the token cache is an AES-256-GCM file per tenant and client ID whose key lives in the OS credential store (`@napi-rs/keyring`), with a lock file spanning MSAL's read-modify-write; `commands/graph.js` builds the auth and client per invocation from the resolved connection
