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
```

`.env.example` contains local development defaults for the database roles and connection strings.

## Run The Server Locally

After setup, start the local agent server with:

```bash
pnpm dev:mastra
```

This uses the workspace-installed Mastra CLI and starts the local development server. By default, Mastra serves Studio at `http://localhost:4111`.

The Plus One inbound route is available at:

```text
POST http://localhost:4111/plus-one/inbound
```

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
