# Cadenza DB Architecture

## Scope

`@cadenza.io/cadenza-db` defines and boots the canonical CadenzaDB service schema using Cadenza service/database primitives.

The schema is declared in code in [`src/index.ts`](/Users/emilforsvall/WebstormProjects/cadenza-workspace/cadenza-db/src/index.ts).

## Architectural Role

- Authority for persistent graph metadata contracts.
- Authority for actor registry and actor-task mapping table shapes.
- Runtime service that can receive meta-signal-driven inserts/updates.

This repo is schema authority; service/runtime producers live in `cadenza-service`.

## Service Bootstrap Pattern

`CadenzaDB.createCadenzaDBService(...)`:

1. creates one meta database service (`createMetaDatabaseService`).
2. defines all schema tables and constraints.
3. sets custom signal triggers for insert/update flows.
4. starts sync orchestration tasks once runtime is ready.

A module-level `CREATED` guard prevents duplicate service creation in-process.

## Schema Domains

Current schema is organized around these domains:

- service registry: `service`, `service_instance`, dependencies/relationships
- graph primitives: `task`, `routine`, maps, signal registry, intent maps
- execution telemetry: traces, routine executions, task executions, directional edges
- actor metadata:
  - `actor`
  - `actor_task_map`
  - `actor_session_state`

## Actor Persistence Contract

### `actor`

Stores actor definitions and policies.

Key fields include:

- identity: `name`, `service_name`, `version`
- behavior: `load_policy`, `write_contract`, `runtime_read_guard`, `consistency_profile`
- structure: `key_definition`, `state_definition`
- policies: `retry_policy`, `idempotency_policy`, `session_policy`
- classification: `is_meta` (no `kind` column)

### `actor_task_map`

Associates actor and task identities and mode contract.

Key fields:

- `actor_name`, `actor_version`
- `task_name`, `task_version`
- `service_name`
- `mode`, `description`, `is_meta`

### `actor_session_state`

Stores durable session state snapshots per actor key.

Key fields:

- unique identity: `(actor_name, actor_version, actor_key, service_name)`
- payload: `durable_state`, `durable_version`
- lifecycle: `expires_at`, `updated`, `created`, `deleted`

## Signal Trigger Contracts (Actor)

- `global.meta.graph_metadata.actor_created` -> `actor` insert
- `global.meta.graph_metadata.actor_updated` -> `actor` update
- `global.meta.graph_metadata.actor_task_associated` -> `actor_task_map` insert
- `global.meta.graph_metadata.actor_session_state_created` -> `actor_session_state` insert
- `global.meta.graph_metadata.actor_session_state_updated` -> `actor_session_state` update

Strict write-through runtime path (v1):

- Core actor durable write calls inquiry intent `meta-actor-session-state-persist`.
- Service responder performs upsert into `actor_session_state`.
- Upsert stale-write guard uses durable version ordering:
  - `actor_session_state.durable_version <= excluded.durable_version`.
- Core write succeeds only when responder returns `__success: true` and `persisted: true`.

## Integration Boundary

- Producers of these signals: `cadenza-service` metadata controllers.
- Primitive-level actor/task metadata originates in `cadenza`.
- This repo validates and persists by table contract.

Contract drift between emitted fields and table fields will break insert/update flows.
