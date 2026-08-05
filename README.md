# Plus One

[![Latest release](https://img.shields.io/github/v/release/adamraziv/plus-one)](https://github.com/adamraziv/plus-one/releases/latest)
[![License](https://img.shields.io/github/license/adamraziv/plus-one)](LICENSE)
[![Contributing](https://img.shields.io/badge/contributing-guide-blue)](CONTRIBUTING.md)

Plus One is an open-source, self-hosted household finance agent for couples. The v0.3.0 production channel is Telegram; channel boundaries are designed for additional integrations.

Agents can analyze and propose, but deterministic services and PostgreSQL constraints decide what is committed.

## Current Scope

The registered agent surface includes:

- `orchestrator`: receives channel messages, coordinates specialist work, and returns the final response
- `query`: provides read-only evidence packages from approved reporting relations
- `accounting`: proposes and verifies ledger, chart-of-accounts, transaction-capture, and ingestion mutations
- `budgeting`: produces checked budget proposals and scenario comparisons

The current production surface includes:

- a Telegram gateway with pairing, readiness, graceful shutdown, replay deduplication, and an operator CLI/TUI
- natural-language account, balance, transaction, and governed reporting queries, plus checked budgeting workflows
- multi-turn expense and income capture with clarification, confirmation-backed account/category creation, and durable restart-safe continuation
- checked mutations with policy validation, idempotency, verification, readback, PostgreSQL constraints, and append-only accounting facts
- ingestion and imports with extraction, duplicate matching, reconciliation, and period close
- planning and reporting services, plus persisted scheduled-delivery and scheduled-review support
- durable household and member Working Memory for goals, preferences, names, and conventions, with safe views, confirmed changes, corrections, deletion, and deterministic review

Scheduled delivery and scheduled review have runtime/database integration support, but the `plus-one` gateway does not start a scheduler loop.

## How It Works

In practice, that means:

- reads go through governed query tools
- writes go through maker-checker verification and typed commands
- accounting facts stay append-only
- database constraints remain the final enforcement layer

## Requirements

- Node.js `>=22.13.0`
- pnpm `10.20.0`
- Docker for local PostgreSQL
- an `LLM_API_KEY` for non-test runs
- a `TELEGRAM_BOT_TOKEN` to enable Telegram ingress (optional for HTTP-only local runs)

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:verify
pnpm smoke:orchestrator
pnpm install:cli
```

`.env.example` contains local development defaults for the database roles and connection strings. Set `LLM_API_KEY` in `.env` before running the smoke command or gateway. Telegram is disabled when `TELEGRAM_BOT_TOKEN` is unset; with a token, polling is the default receiver. To use webhook mode, also set `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET`.

The installer creates a symlink at `~/.local/bin/plus-one`. Add that directory to `PATH` if it is not already present. Set `PLUS_ONE_BIN_DIR` to install into a different bin directory. The symlink points back to this checkout; it does not copy `.env` files or secrets.

## Run Plus One

The installed command is cwd-independent:

```bash
cd /tmp
plus-one
```

With no arguments, `plus-one` starts the production gateway in the background. It prints a starting state, waits for the Mastra HTTP server and configured Telegram receiver to become ready, prints the listening state, and returns the shell prompt. Detached gateway output is written to the Plus One state directory.

```bash
plus-one status
plus-one stop
```

`status` reports whether the gateway is stopped, starting, or listening. `stop` terminates the recorded gateway process without stopping PostgreSQL. The internal `--foreground` mode is used by `plus-one live` and is not a chat interface.

The production gateway exposes these routes at the configured host and port (the defaults are `127.0.0.1:4111`):

```text
GET /health/live
GET /health/ready
POST /plus-one/inbound
POST /telegram/webhook        # webhook mode only
```

`/health/ready` becomes ready only after application resources and channel intake are active. Graceful shutdown stops intake before closing the HTTP server and application resources. Accepted follow-up messages are drained in FIFO order per conversation.

In webhook mode, Telegram requests to `/telegram/webhook` must include the configured secret in the `x-telegram-bot-api-secret-token` header.

The command has no chat mode. `plus-one chat ...` is rejected, and the terminal surfaces never send operator-entered conversation text. Conversation ingress is channel-only.

## Development Server

For repository-local Mastra development, run:

```bash
pnpm dev:mastra
```

This uses the workspace-installed Mastra CLI and starts the local development HTTP server. It does not start Telegram polling or call Telegram's `setWebhook` API. By default, Mastra serves Studio at `http://localhost:4111`.

## Logging

By default, the runtime writes rotating operational logs under `~/.plus-one/logs`:

```text
~/.plus-one/logs/agent.log
~/.plus-one/logs/errors.log
~/.plus-one/logs/gateway.log
~/.plus-one/logs/launcher.log
```

Every active file is newline-delimited JSON (NDJSON), with one canonical
`LogEnvelopeV1` event per line. `agent.log` contains all enabled events,
`errors.log` contains `WARN` and `ERROR` events, `gateway.log` contains gateway
runtime and channel events, and `launcher.log` contains background launcher
events. The `plus-one logs gateway` view merges the gateway and launcher
streams chronologically. Raw detached-process fallback output is kept
separately in `launcher-console.log` and is not an operational log stream.

Configure the location and rotation with:

- `PLUS_ONE_HOME`: Plus One home directory; logs are written in its `logs/` subdirectory
- `PLUS_ONE_LOG_LEVEL`: `DEBUG`, `INFO`, `WARN`, or `ERROR` (default `INFO`);
  `WARNING` is accepted as a configuration alias for `WARN`
- `PLUS_ONE_LOG_MAX_SIZE_MB`: rotating `agent.log`, `gateway.log`, and `launcher.log` size (default `5`); `errors.log` uses its own `2` MiB limit
- `PLUS_ONE_LOG_BACKUP_COUNT`: rotating backup count for `agent.log`, `gateway.log`, and `launcher.log` (default `3`); `errors.log` keeps `2` backups
- `PLUS_ONE_LOG_STDOUT=true`: mirror canonical NDJSON to stdout in foreground
  gateway mode for collection by a service manager; it defaults to false

`plus-one logs` renders concise human-readable output by default. With no
arguments it is an alias for `plus-one logs agent --lines 50`.

```bash
plus-one logs
plus-one logs agent --lines 50
plus-one logs gateway --follow
plus-one logs errors --level WARN --since 1h
plus-one logs --event working_memory. --component runtime.memory
plus-one logs --conversation conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K \
  --household hh_01JNZQ4A9B8C7D6E5F4G3H2J1K --request request_example
plus-one logs gateway --json
plus-one logs errors --stack
```

Filters can be combined before the final `--lines` limit. Available filters are
`--level`, `--since`, `--component`, `--event`, and the correlation filters
`--request`, `--conversation`, `--household`, `--task`, `--run`, and
`--delivery`. `--json` emits canonical NDJSON, `--stack` includes a sanitized
stack in human output, and `--follow` continues across rotation. `--stack`
cannot be combined with `--json`.

Operational logs contain allowlisted lifecycle metadata, safe categories,
aggregate counts, and correlation IDs. They exclude message bodies, prompts,
model responses, Working Memory contents, financial amounts, account
descriptions, SQL, credentials, connection strings, tool arguments, raw
destinations, external principal identifiers, and raw provider or database
errors. These records are diagnostic operational logs, not security, compliance, or
tamper-evident audit logs. Planning mutations also create append-only domain audit
records in PostgreSQL; those records are separate from operational logs.

To roll back to an older binary, first stop the gateway and launcher and verify
that no log writer remains. Atomically rename the entire active `logs`
directory to a sibling named `logs.rollback-<timestamp>`, then create a fresh
owner-only `logs` directory at the configured path before starting the older
binary. Keep the rollback directory intact: after re-upgrade, the current
reader includes sibling `logs.rollback-*` directories in chronological
queries. If the rename or fresh-directory creation fails, do not start the
older binary. Never perform this procedure while a writer is active, and do
not delete individual active, rotated, legacy, mixed, corrupt, or partial
files.

For the operational terminal UI, run:

```bash
plus-one live
```

The live UI starts, stops, hides, and inspects the gateway and manages Telegram pairing. It is an operator console, not a chat client.

Pairing commands are also available without the TUI:

```bash
plus-one telegram pairing list-pending
plus-one telegram pairing approve <code> --household <household_id>
plus-one telegram pairing revoke <telegram_user_id>
```

At the default host and port, Mastra's built-in API surface is under `http://localhost:4111/api`; use the configured `ENGINE_HOST` and `ENGINE_PORT` when they differ. The Plus One custom inbound route is registered directly and is not `/api`-prefixed.

At the default host and port, the Plus One inbound route is available at:

```text
POST http://localhost:4111/plus-one/inbound
```

Inbound payloads must satisfy `InboundChannelMessageV1`. In particular:

- `conversationId` must match `conversation_<26-char ULID>`
- `householdId` must match `hh_<26-char ULID>`

The current runtime persists:

- transcript messages and thread metadata in `mastra_memory.mastra_messages` and `mastra_memory.mastra_threads`
- Working Memory in `mastra_memory.mastra_resources`
- observational memory in `mastra_memory.mastra_observational_memory`
- orchestrator workflow snapshots in `mastra_memory.mastra_workflow_snapshot`

## Common Commands

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:db
pnpm test:integration
pnpm test:acceptance
pnpm db:up
pnpm db:down
pnpm db:migrate
pnpm db:verify
pnpm smoke:orchestrator
pnpm dev:mastra
pnpm install:cli
plus-one
plus-one status
plus-one stop
plus-one live
plus-one logs
plus-one telegram pairing list-pending
```

## Repository Layout

- `apps/engine`: application bootstrap, orchestrator, agents, workflows, and runtime routes
- `packages/contracts`: shared schemas and domain contracts
- `packages/runtime`: execution, policy, tool, artifact, and scheduling primitives
- `packages/database`: PostgreSQL config, pools, migrations, and repository adapters
- `packages/accounting`: ledger posting, accounting mutations, and accounting team logic
- `packages/mutations`: checked mutation command registration, execution, and recovery
- `packages/query`: query tools, SQL validation, and evidence handling
- `packages/ingestion`: import, extraction, matching, and reconciliation support
- `packages/planning`: planning-domain repositories and services
- `packages/reporting`: reporting projections and reporting-domain services
- `database`: SQL migrations, bootstrap, and repair scripts
- `test`: shared helpers plus database, integration, and acceptance coverage

## Release Status

v0.3.0 is the current public development release. It provides a working self-hosted Telegram finance flow, while APIs, configuration, and operational behavior may still change before 1.0.

If you are new to the codebase, start with `apps/engine`, `packages/contracts`, `packages/runtime`, `packages/mutations`, `packages/database`, `packages/query`, `packages/accounting`, `packages/ingestion`, `packages/planning`, and `packages/reporting`.
