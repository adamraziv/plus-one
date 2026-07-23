# Contributing to Plus One

Thank you for contributing to Plus One, an open-source, self-hosted household finance agent for couples.

Plus One handles financial data. Contributions must therefore prioritize correctness, privacy, data integrity, and operational safety.

## Before Contributing

- **Read first:** [Inside Plus One: Building a Verifiable Finance Agent for Households](https://open.substack.com/pub/adamraziv/p/inside-plus-one-building-a-verifiable?r=24re3c&utm_campaign=post-expanded-share&utm_medium=web) — a technical tour of the agent hierarchy, channel gateway, PostgreSQL boundary, and checked-mutation runtime behind Plus One’s first public release.
- Read the [README](README.md).
- Read the relevant package documentation.
- Search existing issues and pull requests.
- Review any applicable project specification available in your checkout.

## Fork-First Workflow

All external contributions should start from a fork.

1. Fork [`adamraziv/plus-one`](https://github.com/adamraziv/plus-one) on GitHub.
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/plus-one.git
   cd plus-one
   ```

3. Add the upstream repository:

   ```bash
   git remote add upstream https://github.com/adamraziv/plus-one.git
   git remote -v
   ```

4. Fetch the latest upstream code:

   ```bash
   git fetch upstream
   ```

5. Create a focused branch from upstream `main`:

   ```bash
   git switch -c feat/short-description upstream/main
   ```

6. Push your branch to your fork:

   ```bash
   git push -u origin feat/short-description
   ```

7. Open a pull request from your fork to `adamraziv/plus-one:main`.

Keep your fork’s `main` branch synchronized with upstream before starting new work.

Use branch prefixes such as:

- `feat/` for new functionality
- `fix/` for bug fixes
- `docs/` for documentation
- `test/` for test-only changes
- `chore/` for maintenance

## What Contributions Are Welcome?

We welcome:

- bug fixes;
- tests and regression coverage;
- documentation improvements;
- performance and reliability improvements;
- database and migration improvements;
- new accounting, ingestion, planning, query, or reporting capabilities;
- channel and operator experience improvements.

For a bug fix or small documentation change, an existing issue or a concise new issue is usually sufficient.

For new features, public API changes, architecture changes, database-model changes, or changes affecting accounting behavior, open an issue first and wait for maintainer feedback before implementing the work. A design discussion helps prevent duplicated effort and gives maintainers an opportunity to confirm scope and compatibility.

## Development Setup

Requirements:

- Node.js `>=22.13.0`
- pnpm `10.20.0`
- Docker
- an `LLM_API_KEY` for live model-backed runs

Set up the project:

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:verify
```

Never commit `.env` files, API keys, credentials, database dumps, production logs, or private household or financial data.

## Repository Layout

- `apps/engine`: bootstrap, agents, workflows, channels, and runtime routes
- `packages/contracts`: shared Zod schemas and domain contracts
- `packages/runtime`: execution, policy, tools, artifacts, and scheduling
- `packages/database`: PostgreSQL configuration, migrations, and repositories
- `packages/accounting`: ledger posting and accounting mutations
- `packages/query`: governed financial queries and evidence handling
- `packages/ingestion`: imports, extraction, matching, and reconciliation
- `packages/planning`: budgets, obligations, savings goals, and debt plans
- `packages/reporting`: reporting projections and reporting services
- `database`: SQL migrations, bootstrap scripts, and repair scripts
- `test`: shared test helpers and database, integration, and acceptance coverage

## Project Boundaries

Please preserve these architectural rules:

- Agents analyze and propose work; deterministic services decide what is committed.
- Mutations pass through typed validation, policy checks, verification, idempotency, and readback.
- Accounting facts are append-only.
- Corrections must be represented as corrections rather than destructive edits.
- Governed query tools are the read boundary for financial data.
- PostgreSQL constraints remain part of the final enforcement layer.

## Validation

Run the checks relevant to your change:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:db
pnpm test:integration
pnpm test:acceptance
pnpm db:verify
```

For orchestrator changes, also consider:

```bash
pnpm smoke:orchestrator
```

Run test commands one at a time. Database-backed, integration, acceptance, and server-backed tests must never be run concurrently because they may contend for shared database or server resources.

For local Mastra development:

```bash
pnpm dev:mastra
```

If a test cannot be run locally, explain why in the pull request and identify what a maintainer should verify.

## Bug Reports and Minimal Reproductions

A useful bug report includes:

- a clear description of the problem;
- expected behavior;
- actual behavior;
- exact reproduction steps;
- Node.js, pnpm, Docker, and operating-system versions;
- relevant logs or error messages;
- a minimal test case or reproduction when possible.

Do not include real household data, credentials, tokens, or private production logs.

A minimal reproduction should contain only the code, configuration, and commands needed to demonstrate the problem.

## Database and Accounting Changes

Database changes must include:

- a forward migration;
- appropriate repository or integration tests;
- migration verification;
- consideration of existing data and upgrade behavior.

For accounting changes, explain:

- whether accounting facts, projections, or reports are affected;
- how idempotency is preserved;
- how duplicate posting is prevented;
- how readback verification works;
- whether repair or migration behavior is required.

Do not manually modify production-like data during development. Use migrations, repositories, and test helpers.

## Commits and Pull Requests

Use focused commits with clear Conventional Commit-style messages:

```text
feat: add transaction import validation
fix: preserve replay idempotency
test: cover duplicate journal posting
docs: clarify local database setup
chore: update dependencies
```

Pull request titles should use the same prefixes.

Every pull request should:

- link an issue where one exists;
- explain the problem and the solution;
- describe the scope and affected packages;
- list validation commands that were run;
- identify migrations and data-impacting changes;
- describe security, privacy, and operational impact;
- include screenshots or recordings for UI changes;
- include reproduction or verification steps for behavior changes;
- call out known limitations and follow-up work.

Keep pull requests small and focused. Avoid unrelated refactors and generated files.

AI assistance is welcome, but issue and pull request descriptions must be reviewed for accuracy, relevance, and unnecessary verbosity.

## Review and Merge Policy

Maintainers review:

- correctness and architectural fit;
- test coverage and validation evidence;
- database and accounting safety;
- security and privacy implications;
- migration quality;
- operational and upgrade impact;
- documentation quality.

Maintainers may request changes, narrow scope, or ask for additional evidence.

A pull request should be merged only after review feedback is resolved, relevant checks pass, database and migration changes are understood, documentation is updated where needed, and the branch is based on current upstream `main`.

Maintainers are responsible for deciding when a change is ready to merge.

## Release Process

Releases are maintainer-controlled.

Before a release, maintainers should:

1. Confirm the release scope and Semantic Version.
2. Ensure the release is based on an up-to-date `main`.
3. Confirm the working tree is clean.
4. Run the full relevant validation suite.
5. Review user-facing documentation and version references.
6. Prepare release notes covering features, fixes, migrations, compatibility changes, and known limitations.
7. Create an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   ```

8. Push the tag from the upstream repository:

   ```bash
   git push upstream vX.Y.Z
   ```

9. Publish the corresponding GitHub release.
10. Verify the documented installation and quick-start flow.

Do not publish a release with unverified migrations, unresolved data-integrity issues, or known security regressions.

## Security

Do not publicly disclose exploitable vulnerabilities, credentials, private household data, or production financial records.

For sensitive security reports, contact the project maintainers privately through GitHub rather than opening a public issue.

## Community Standards

Be respectful, specific, and collaborative.

Critique code and decisions without attacking people. Harassment, discrimination, doxxing, spam, and intentionally disruptive behavior are not acceptable.

## Further Reading

- [Project README](README.md)
- [Database migrations](database/migrations)
- [Engine tests](apps/engine/test)
- [Packages](packages)
