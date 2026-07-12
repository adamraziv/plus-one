# Plus One

Plus One is an open-source, self-hosted agentic system for couples managing household finances through chat channels such as Telegram and Slack.

The project is designed around a simple rule: agents can analyze and propose, but deterministic services and PostgreSQL constraints decide what is committed.

This repository currently focuses on the core runtime, PostgreSQL persistence, and the checked mutation flow that keeps financial writes explicit and verifiable.

## Current Scope

Today, the implemented agent surface is:

- `orchestrator`: receives requests, coordinates work, and returns the final response
- `query`: the read boundary for household financial data
- `accounting`: proposes and verifies ledger and ingestion mutations

The repository also includes supporting foundations for:

- PostgreSQL migrations and repository code
- runtime policy, execution, scheduling, and delivery primitives
- ingestion, planning, and reporting domain packages
- unit, database, integration, and acceptance tests

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

## Status

This is an active implementation repository, not a finished product surface. If you are new to the codebase, start with `apps/engine`, `packages/runtime`, `packages/database`, `packages/query`, and `packages/accounting`.
