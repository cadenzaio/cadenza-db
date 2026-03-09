# Cadenza DB Product

## Product Definition

`@cadenza.io/cadenza-db` provides the canonical persistence layer for Cadenza graph metadata and related runtime records.

It packages a ready-to-run Cadenza database service schema built with Cadenza primitives.

## Product Capabilities

1. Persist core graph metadata (`task`, `routine`, maps, signals, intents).
2. Persist execution telemetry and relationships.
3. Persist actor registration and actor-task mappings.
4. Persist durable actor session state snapshots.
5. Receive metadata updates through global meta signal contracts.

## Actor MVP Coverage

Current actor persistence minimum includes:

- actor registry (`actor`)
- actor-task association (`actor_task_map`)
- durable state snapshot table (`actor_session_state`)

Runtime-only actor objects are not persisted.

## Intended Consumers

- `@cadenza.io/service` instances emitting metadata signals.
- UI/observability tooling reading persisted structure and runtime data.
- future DB-native engine materializers (`cadenza-engine`).

## Product Boundaries

This package does not:

- define core primitive runtime semantics (owned by `cadenza`)
- define distributed execution/transport behavior (owned by `cadenza-service`)
- materialize full DB-native engine behavior at runtime (future `cadenza-engine` scope)

## Operational Notes

- Schema is code-defined and versioned in this package.
- Metadata payloads must match field identity expected by target tables.
- Actor session strict write-through relies on service responder contract: `__success` + `persisted`.
- A single process should initialize this service once per runtime.
