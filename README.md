# Plus One

[![Latest release](https://img.shields.io/github/v/release/adamraziv/plus-one)](https://github.com/adamraziv/plus-one/releases/latest)
[![License](https://img.shields.io/github/license/adamraziv/plus-one)](LICENSE)
[![Contributing](https://img.shields.io/badge/contributing-guide-blue)](CONTRIBUTING.md)

Plus One is an open-source, self-hosted household finance agent for couples. The v0.1.0 production channel is Telegram; channel boundaries are designed for additional integrations.

Agents can analyze and propose, but deterministic services and PostgreSQL constraints decide what is committed.

Latest release: [Plus One v0.1.0](https://github.com/adamraziv/plus-one/releases/tag/v0.1.0).

## Current Scope

The implemented agent surface includes:

- `orchestrator`: receives requests, coordinates work, and returns the final response
- `query`: the read boundary for household financial data
- `accounting`: proposes and verifies ledger and ingestion mutations

The current production surface includes:

- a Telegram gateway with pairing, readiness, graceful shutdown, replay deduplication, and an operator CLI/TUI
- natural-language account, balance, transaction, and governed reporting queries
- multi-turn expense and income capture with clarification, confirmation-backed account/category creation, and durable restart-safe continuation
- checked mutations with policy validation, idempotency, verification, readback, PostgreSQL constraints, and append-only accounting facts
- ingestion and imports with extraction, duplicate matching, reconciliation, and period close
- planning, reporting, and scheduled delivery services
- durable household and member Working Memory for goals, preferences, names, and conventions, with safe views, confirmed changes, corrections, deletion, and deterministic or scheduled review

## How It Works

In practice, that means:

- reads go through governed query tools
- writes go through maker-checker verification and typed commands
- accounting facts stay append-only
- database constraints remain the final enforcement layer

## Requirements

- Node.js `>=22.13.0`
- pnpm `10.20.0`
- Docker
- an `LLM_API_KEY` for live model-backed runs

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

`.env.example` contains local development defaults for the database roles and connection strings.

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

The production gateway reports:

```text
GET /health/live
GET /health/ready
POST /plus-one/inbound
```

`/health/ready` becomes ready only after application resources and channel intake are active. Graceful shutdown stops intake before closing the HTTP server and application resources. Accepted follow-up messages are drained in FIFO order per conversation.

The command has no chat mode. `plus-one chat ...` is rejected, and the terminal surfaces never send operator-entered conversation text. Conversation ingress is channel-only.

## Development Server

For repository-local Mastra development, run:

```bash
pnpm dev:mastra
```

## Logging

The runtime writes rotating operational logs under `~/.plus-one/logs`:

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
- `PLUS_ONE_LOG_MAX_SIZE_MB`: rotating `agent.log` and `gateway.log` size (default `5`)
- `PLUS_ONE_LOG_BACKUP_COUNT`: rotating backup count for `agent.log` and `gateway.log` (default `3`)
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
errors. These records are diagnostic, not security, compliance, or
tamper-evident audit logs; audit logging is explicitly deferred.

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

This uses the workspace-installed Mastra CLI and starts the local development HTTP server. It does not activate Telegram polling or register the production webhook. By default, Mastra serves Studio at `http://localhost:4111`.

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

Mastra's built-in API surface stays under `http://localhost:4111/api`, but the Plus One custom inbound route is registered directly and is not `/api`-prefixed.

The Plus One inbound route is available at:

```text
POST http://localhost:4111/plus-one/inbound
```

Inbound payloads must satisfy `InboundChannelMessageV1`. In particular:

- `conversationId` must match `conversation_<26-char ULID>`
- `householdId` must match `hh_<26-char ULID>`

The current runtime persists:

- transcript memory in `mastra_memory.mastra_messages` and `mastra_memory.mastra_threads`
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
```

## Repository Layout

- `apps/engine`: application bootstrap, orchestrator, agents, workflows, and runtime routes
- `packages/contracts`: shared schemas and domain contracts
- `packages/runtime`: execution, policy, tool, artifact, and scheduling primitives
- `packages/database`: PostgreSQL config, pools, migrations, and repository adapters
- `packages/accounting`: ledger posting, accounting mutations, and accounting team logic
- `packages/query`: query tools, SQL validation, and evidence handling
- `packages/ingestion`: import, extraction, matching, and reconciliation support
- `packages/planning`: planning-domain repositories and services
- `packages/reporting`: reporting projections and reporting-domain services
- `database`: SQL migrations, bootstrap, and repair scripts
- `test`: shared helpers plus database, integration, and acceptance coverage

## Release Status

v0.1.0 is the first public development release. It provides a working self-hosted Telegram finance flow, while APIs, configuration, and operational behavior may still change before 1.0.

If you are new to the codebase, start with `apps/engine`, `packages/runtime`, `packages/database`, `packages/query`, and `packages/accounting`.
