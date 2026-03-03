# Agents Notes: cadenza-db

## What I have learned

- `cadenza-db` defines the canonical meta-database service schema used by the framework ecosystem.
- New actor-related tables are currently added in `src/index.ts`:
  - `actor`
  - `actor_task_map`
  - `actor_session_state`
- These tables are designed to support actor definition registry, task-to-actor mapping, and persisted durable/session state.

## Alignment updates from discussion

- `actor.kind` is unnecessary because the platform standard is `is_meta: boolean`.
- Durable/session persistence should store serializable actor durable data only.
- Runtime object state (e.g. sockets, clients, live handles) should not be persisted.
- Actor/task/intents metadata and descriptions are important for future DB-native generation and operator understanding.
- Runtime-generated/ephemeral tasks remain part of execution behavior but should not be modeled as static durable definitions unless explicitly captured as primitives.

## Long-term direction (recorded)

- DB is intended to become the primary source of truth for business primitives, with engines materializing and executing that structure dynamically.
- Schema design should favor queryability, structured metadata, and clear separation of durable definition data vs runtime telemetry/state.

## What I will keep learning in this discussion

- Minimal DB schema needed now versus what should move later to `cadenza/engine`.
- Which actor fields are essential for bootstrap/materialization and which are optional.
- How to keep actor schema simple while preserving future extension points (sync profiles, lifecycle hooks, task binding metadata).
