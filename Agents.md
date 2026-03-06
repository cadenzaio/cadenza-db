# Repo-Specific Agent Rules

This document defines repository-level execution rules.

Global workflow governance (WIP limits, clarification protocol,
assumptions policy, complexity gate, contract governance)
is defined in the workspace root AGENTS.md.

If conflict exists:
- Root AGENTS.md governs workflow and process.
- This file governs tooling, commands, and repo-specific constraints.

---

# 1. Repository Overview

Name: cadenza-db
Purpose: Canonical CadenzaDB schema/service definition and metadata persistence contracts.
Owner Domain: DB schema authority for graph/actor metadata persistence.

Boundaries:
- Do NOT modify other repos from here.
- Cross-repo changes must follow workspace multi-repo discipline.
- Keep service transport logic in `cadenza-service` and core execution semantics in `cadenza`.

---

# 2. Local Development Commands

Use these canonical commands. Do not invent alternatives.

## Install

```bash
yarn install
```

## Build

```bash
yarn build
```

## Test

```bash
yarn test
```

## Typecheck

```bash
yarn tsc --noEmit
```

## Format

```bash
yarn prettier --check .
```

If CI uses a specific command, prefer that command.

# 3. Pre-PR Checklist (Repo-Specific)

## Before opening PR:

- [ ] Install succeeds
- [ ] Typecheck passes
- [ ] Tests pass
- [ ] No console logs left
- [ ] No commented-out code
- [ ] No debug artifacts
- [ ] Migration files included (if applicable)

If this repo exposes contracts:

- [ ] Contract changes propagated per workspace rules

# 4. Environment & Configuration

Required environment variables (from source usage):

- `HTTP_PORT`: CadenzaDB service port.
- `NODE_ENV`: Runtime environment (`development`/`production`).

Local dev setup notes:

- This repo defines schema/service bootstrap for CadenzaDB.
- Validate schema changes with build + downstream consumer checks when contracts change.

Never hardcode secrets.

Never commit .env files.

# 5. Testing Rules

Test expectations:

- All new logic must include tests where test harness exists.
- Edge cases must be tested.
- Regression tests required for bug fixes.
- Snapshot tests updated intentionally, never blindly.

If integration tests exist:

- Ensure external services are mocked or containerized.

# 6. Contract Responsibilities (If This Repo Owns Contracts)

This repo is a contract authority for persisted metadata table shape.

- Update authority schema first.
- Ensure service-layer metadata payloads still map to DB field identities.
- Update consumers in same task OR create linked follow-up issue.
- Document schema contract changes in README/docs.

Breaking contract changes require:

- Explicit approval

  OR

- Design-required phase.

# 7. Logging & Observability

- Use structured logging where applicable.
- Avoid logging sensitive data.
- Log errors with context.
- No silent catches.

# 8. Performance & Safety Constraints

- Keep schema constraints/indexes aligned with query and sync paths.
- Avoid unconstrained operations that degrade metadata sync throughput.
- Validate external input to generated DB tasks.
- Fail fast on invalid schema states.

# 9. Repo-Specific Anti-Patterns

Do NOT:

- Introduce duplicate classification fields when one canonical field exists (`is_meta`).
- Persist runtime-only process objects in durable actor state tables.
- Break foreign-key identity contracts without approved migration strategy.
- Modify generated files manually.
- Disable tests to make builds pass.
- Introduce new dependencies without justification.

# 10. Documentation Discipline

If you modify:

- DB schema
- Metadata signal trigger mapping
- Build system
- Major module structure

Update:

- README.md
- This AGENTS.md (if command/process changes)
- Relevant repo docs

All documentation changes must be:

- Evidence-based
- Implemented via approved proposals from Queue Health process

# 11. Execution Principle

Within this repo:

- Prefer small, incremental changes.
- Prefer additive changes over breaking.
- If uncertain, trigger clarification per root policy.
- If complexity increases, trigger design-required per root policy.

When in doubt: stop and ask.

# Agents Notes: cadenza-db

## What I have learned

- `cadenza-db` defines the canonical metadata schema surface used by the ecosystem.
- Actor minimum currently includes:
  - `actor`
  - `actor_task_map`
  - `actor_session_state`
- These tables support actor definition registry, actor-task binding, and durable actor state storage.

## Alignment updates from discussion

- Actor classification is `is_meta` (no `kind`).
- `lifecycle_definition` is not part of the MVP actor schema.
- Durable persistence stores serializable durable actor data only.
- Runtime objects (sockets/clients/live handles) are never persisted.
- Metadata payload contracts must match DB field identities; naming style conversion is transport-level.

## Long-term direction (recorded)

- DB is a primary source of truth for primitives in the DB-native direction.
- Schema design should optimize queryability and clear separation between durable definition/state and runtime telemetry.

## What I will keep learning in this discussion

- Minimal DB schema needed now vs. what belongs later in `cadenza-engine`.
- Actor session state sync semantics and consistency policies.
- Migration patterns that preserve contract stability across service and UI consumers.
