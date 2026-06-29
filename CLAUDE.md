# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative Docs

`AGENTS.md` at the repo root is the canonical contributor guide and applies to Claude Code too. Read it before non-trivial work, together with these specs (in order):

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md` — V1 build contract (controls when in conflict with `doc/SPEC.md`)
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

## What Paperclip Is

A control plane for AI-agent companies: a Node.js + Express REST API plus a React/Vite board UI that orchestrates teams of AI agents (Claude Code, Codex, Cursor, Gemini, OpenClaw, HTTP bots, etc.) against company goals — with org charts, budgets, governance, atomic task checkout, heartbeat execution, and full audit. It is **not** a chatbot, agent framework, or workflow builder.

## Common Commands

```sh
pnpm install
pnpm dev              # API + UI in watch mode at http://localhost:3100 (UI served by API in dev middleware)
pnpm dev:once         # Same, no file watching; auto-applies pending local migrations
pnpm dev:server       # Server only
pnpm dev:ui           # UI only
pnpm dev:list         # Inspect current repo's managed dev runner
pnpm dev:stop         # Stop it

pnpm test             # Cheap default — Vitest only (alias for test:run)
pnpm test:watch       # Vitest watch mode
pnpm test:run:general # General (parallel-safe) Vitest projects
pnpm test:run:serialized # Server route/integration suites that must run serially
pnpm test:e2e         # Playwright (opt-in; only when touching browser flows)
pnpm test:release-smoke

pnpm typecheck        # pnpm -r typecheck across all workspaces
pnpm build            # pnpm -r build across all workspaces
pnpm check:tokens     # Forbidden-token guard

pnpm db:generate      # Generate Drizzle migration (compiles packages/db first)
pnpm db:migrate       # Apply migrations
pnpm db:backup        # One-off logical backup

pnpm storybook        # UI Storybook on :6006 (stories live in ui/storybook/)
```

Run a single Vitest test file from a workspace:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/issues-service.test.ts
pnpm --filter @paperclipai/ui exec vitest run src/pages/Agents.test.tsx
```

Quick health checks:

```sh
curl http://localhost:3100/api/health      # {"status":"ok"}
curl http://localhost:3100/api/companies   # JSON array
```

Reset local dev DB:

```sh
rm -rf ~/.paperclip/instances/default/db && pnpm dev
```

CLI client (commands against a running server):

```sh
pnpm paperclipai <subcommand>   # e.g. issue list, dashboard get, doctor, configure, worktree init, run
```

Pick the **smallest** verification that proves the change. Only run `pnpm -r typecheck && pnpm test:run && pnpm build` for PR-ready handoff or broad changes.

## Workspace Layout

pnpm monorepo (`pnpm-workspace.yaml`). Node 20+, pnpm 9.15+, TypeScript, ESM throughout.

- `server/` — `@paperclipai/server`: Express REST API, auth (better-auth), orchestration services, scheduler/worker, adapter dispatch
- `ui/` — `@paperclipai/ui`: React 19 + Vite + Tailwind board UI; pages under `ui/src/pages`, components under `ui/src/components`; Storybook under `ui/storybook/`
- `packages/db/` — `@paperclipai/db`: Drizzle schema (one file per table in `src/schema/*.ts`), migrations, embedded-postgres client; **drizzle.config.ts reads compiled `dist/schema/*.js`**, so `pnpm db:generate` builds the package first
- `packages/shared/` — `@paperclipai/shared`: cross-cutting types, validators, API path constants, config schema
- `packages/adapter-utils/` — shared adapter utilities
- `packages/adapters/*` — per-runtime adapters (`claude-local`, `codex-local`, `cursor-local`, `cursor-cloud`, `gemini-local`, `grok-local`, `opencode-local`, `acpx-local`, `pi-local`, `openclaw-gateway`)
- `packages/plugins/` — plugin SDK, examples, sandbox-providers (excluded from root lockfile by design), `create-paperclip-plugin`
- `cli/` — `paperclipai` CLI (esbuild-bundled binary): onboard, configure, doctor, worktree, client commands
- `scripts/` — repo automation (dev runner, releases, migrations, smoke tests)
- `tests/e2e/`, `tests/release-smoke/` — Playwright suites
- `doc/` — product/operational/spec docs; `docs/` — Mintlify user-facing docs site

## Big-Picture Architecture

**Control plane on a single Node process.** The server hosts REST under `/api`, an in-process scheduler/worker (heartbeat trigger, stuck-run recovery, budget threshold checks — no external queue in V1), an adapter registry, the plugin loader, and the UI in dev (vite middleware). Production builds serve prebuilt UI assets.

**Adapter system.** `server/src/adapters/registry.ts` keeps a mutable registry. Built-in adapters register on startup; external adapters load dynamically via `~/.paperclip/adapter-plugins.json` through `plugin-loader.ts`. UI parses runs via per-adapter `ui-parser.js` shipped from the adapter package — **no hardcoded adapter imports in the plugin loader, and no Hermes/external-adapter imports in `server/` or `ui/` source**. When externalizing a built-in adapter, also remove its built-in UI parser so it doesn't shadow the plugin's.

**Heartbeats.** DB-backed wakeup queue with coalescing. Each fire: budget check → workspace resolution (worktrees, operator branches) → secret injection → skill loading → adapter invocation. Runs emit structured logs, cost events, session state, activity log entries; orphaned runs are recovered per `doc/execution-semantics.md` (prefer preserving ownership / opening visible recovery actions over silent reassignment).

**Multi-company isolation.** Every domain entity is company-scoped. Routes and services must enforce company boundaries. Board access = full-control operator context; agent access = bearer API keys (`agent_api_keys`, hashed at rest) that must not reach other companies. Errors are consistent HTTP codes (`400/401/403/404/409/422/500`) and **mutating actions must write activity log entries**.

**Deployment modes** (`doc/DEPLOYMENT-MODES.md`): canonical model is `local_trusted` and `authenticated` with `private/public` exposure. Authenticated mode defaults secrets strict-mode on and disables company deletion.

**Local state lives under** `~/.paperclip/instances/<id>/` (db, secrets/master.key, storage, backups, workspaces, projects, company codex homes). `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` override roots.

**Worktree isolation.** Never point two Paperclip servers at the same embedded-postgres data dir. Use `paperclipai worktree init` (or `worktree:make`, `worktree repair`, `worktree reseed`) — it writes `.paperclip/config.json` + `.paperclip/.env`, creates an isolated instance under `~/.paperclip-worktrees/instances/<id>/`, and quarantines copied live execution. `pnpm dev` fails fast in a linked worktree when `.paperclip/.env` is missing.

## Core Engineering Rules

1. **Keep changes company-scoped.** Enforce boundaries in both routes and services.
2. **Keep contracts synchronized across all four layers in the same change**: `packages/db` schema + exports → `packages/shared` types/constants/validators → `server` routes/services → `ui` API clients and pages.
3. **Preserve control-plane invariants**: single-assignee task model, atomic issue checkout for `in_progress` transitions, approval gates for governed actions, budget hard-stop auto-pause, activity logging for every mutation.
4. **Database changes**: edit `packages/db/src/schema/*.ts`, export from `src/schema/index.ts`, then `pnpm db:generate`, then `pnpm -r typecheck`.
5. **Strategic docs are additive.** Don't replace `doc/SPEC.md` or `doc/SPEC-implementation.md` wholesale; keep them aligned.
6. **Repo plan documents** belong in `doc/plans/` as `YYYY-MM-DD-slug.md`. Paperclip-issue plans go in the issue's `plan` document via the `paperclip` skill, not as repo markdown.

## Pull Request Requirements

Every PR **must** fill in every section of `.github/PULL_REQUEST_TEMPLATE.md`: **Thinking Path** (trace reasoning from project context down to this change, 5–8 blockquote steps — see `CONTRIBUTING.md`), **What Changed**, **Verification**, **Risks**, **Model Used** (provider + exact model id + context window + capability details; or `None — human-authored`), and the **Checklist**. Greptile review must score 5/5 with all comments addressed before merge.

For feature work, check `ROADMAP.md` and discuss in `#dev` first — uncoordinated feature PRs against core may be closed regardless of quality.

## Definition of Done

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR template fully filled in (including Model Used)
