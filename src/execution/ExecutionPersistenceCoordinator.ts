import Cadenza, {
  createExecutionPersistenceBundle,
  EXECUTION_PERSISTENCE_BUNDLE_SIGNAL,
  type ExecutionPersistenceBundle,
  type ExecutionPersistenceEnsureEntityType,
  type ExecutionPersistenceEnsureEvent,
  type ExecutionPersistenceEntityType,
  type ExecutionPersistenceEvent,
  type ExecutionPersistenceUpdateEntityType,
  type ExecutionPersistenceUpdateEvent,
} from "@cadenza.io/service";

export { EXECUTION_PERSISTENCE_BUNDLE_SIGNAL };

type PersistedEntityState = Record<
  ExecutionPersistenceEntityType,
  Record<string, true>
>;

type PendingEventState = Record<string, ExecutionPersistenceEvent>;

type ExecutionPersistenceCoordinatorRuntimeState = {
  persisted: PersistedEntityState;
  pending: PendingEventState;
  lastTouchedAt: string | null;
};

type ExecutionPersistenceCoordinatorStats = {
  actorKeyCount: number;
  totalPendingCount: number;
  totalPersistedCount: number;
  maxPendingPerKey: number;
  maxPersistedPerKey: number;
};

const COORDINATOR_ACTOR_IDLE_TTL_MS = 10 * 1000;
const COORDINATOR_ACTOR_ABSOLUTE_TTL_MS = 30 * 1000;
const CADENZA_DB_POSTGRES_ACTOR_TOKEN = "cadenza-db-postgres-actor";
const COORDINATOR_STATS_LOG_INTERVAL = 25;
const COORDINATOR_STATS_LOG_ACTOR_KEY_THRESHOLD = 25;
const COORDINATOR_STATS_LOG_PENDING_THRESHOLD = 50;
const COORDINATOR_STATS_LOG_PERSISTED_THRESHOLD = 250;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...(value as Record<string, any>) } as Record<string, any>)
    : null;
}

function splitContextAndMetaContext(
  contextValue: unknown,
  metaContextValue: unknown,
): {
  context: Record<string, any> | null;
  metaContext: Record<string, any> | null;
} {
  const context = readRecord(contextValue);
  const metaContext = readRecord(metaContextValue);

  if (!context) {
    return {
      context: null,
      metaContext,
    };
  }

  const nextContext: Record<string, any> = {};
  const nextMetaContext: Record<string, any> = metaContext ? { ...metaContext } : {};

  for (const [key, value] of Object.entries(context)) {
    if (key.startsWith("__")) {
      if (nextMetaContext[key] === undefined) {
        nextMetaContext[key] = value;
      }
      continue;
    }

    nextContext[key] = value;
  }

  return {
    context: nextContext,
    metaContext:
      Object.keys(nextMetaContext).length > 0 ? nextMetaContext : null,
  };
}

function normalizeExecutionPayloadContexts(
  data: Record<string, any>,
): Record<string, any> {
  const normalizedData = { ...data };
  const contextPairs: Array<{
    contextKey: "context" | "result_context";
    metaContextKey: "meta_context" | "meta_result_context";
    legacyMetaKey: "metaContext" | "metaResultContext";
  }> = [
    {
      contextKey: "context",
      metaContextKey: "meta_context",
      legacyMetaKey: "metaContext",
    },
    {
      contextKey: "result_context",
      metaContextKey: "meta_result_context",
      legacyMetaKey: "metaResultContext",
    },
  ];

  for (const { contextKey, metaContextKey, legacyMetaKey } of contextPairs) {
    const { context, metaContext } = splitContextAndMetaContext(
      normalizedData[contextKey],
      normalizedData[metaContextKey] ?? normalizedData[legacyMetaKey],
    );

    if (context) {
      normalizedData[contextKey] = context;
    }

    if (metaContext) {
      normalizedData[metaContextKey] = metaContext;
    } else {
      delete normalizedData[metaContextKey];
    }

    delete normalizedData[legacyMetaKey];
  }

  return normalizedData;
}

function createPersistedEntityState(): PersistedEntityState {
  return {
    execution_trace: {},
    routine_execution: {},
    signal_emission: {},
    inquiry: {},
    task_execution: {},
  };
}

function createRuntimeState(): ExecutionPersistenceCoordinatorRuntimeState {
  return {
    persisted: createPersistedEntityState(),
    pending: {},
    lastTouchedAt: null,
  };
}

function shouldCompactRuntimeStateAfterBundle(
  bundle: ExecutionPersistenceBundle,
  state: ExecutionPersistenceCoordinatorRuntimeState,
): boolean {
  return (
    Object.keys(state.pending).length === 0 &&
    bundle.updates.some(
      (event) =>
        event.entityType === "routine_execution" ||
        event.entityType === "task_execution",
    )
  );
}

function countPersistedEntries(state: PersistedEntityState): number {
  return Object.values(state).reduce(
    (total, bucket) => total + Object.keys(bucket).length,
    0,
  );
}

function summarizeCoordinatorRuntimeState(
  state: ExecutionPersistenceCoordinatorRuntimeState,
): {
  pendingCount: number;
  persistedCount: number;
} {
  return {
    pendingCount: Object.keys(state.pending).length,
    persistedCount: countPersistedEntries(state.persisted),
  };
}

function collectCoordinatorStats(
  actor: {
    listActorKeys?: () => string[];
    getRuntimeState?: (
      actorKey?: string,
    ) => ExecutionPersistenceCoordinatorRuntimeState;
  },
): ExecutionPersistenceCoordinatorStats {
  const actorKeys =
    typeof actor.listActorKeys === "function" ? actor.listActorKeys() : [];

  let totalPendingCount = 0;
  let totalPersistedCount = 0;
  let maxPendingPerKey = 0;
  let maxPersistedPerKey = 0;

  for (const actorKey of actorKeys) {
    const runtimeState =
      typeof actor.getRuntimeState === "function"
        ? actor.getRuntimeState(actorKey)
        : undefined;
    if (!runtimeState) {
      continue;
    }
    const { pendingCount, persistedCount } =
      summarizeCoordinatorRuntimeState(runtimeState);
    totalPendingCount += pendingCount;
    totalPersistedCount += persistedCount;
    maxPendingPerKey = Math.max(maxPendingPerKey, pendingCount);
    maxPersistedPerKey = Math.max(maxPersistedPerKey, persistedCount);
  }

  return {
    actorKeyCount: actorKeys.length,
    totalPendingCount,
    totalPersistedCount,
    maxPendingPerKey,
    maxPersistedPerKey,
  };
}

function resolveTraceIdFromData(data: Record<string, any> | null): string | null {
  if (!data) {
    return null;
  }

  return readString(
    data.traceId ??
      data.executionTraceId ??
      data.execution_trace_id ??
      data.metaContext?.__executionTraceId ??
      data.metaContext?.__metadata?.__executionTraceId ??
      data.meta_context?.__executionTraceId ??
      data.meta_context?.__metadata?.__executionTraceId,
  );
}

function normalizeExecutionPersistenceBundle(
  ctx: Record<string, any> | null | undefined,
): ExecutionPersistenceBundle | null {
  const directBundle = createExecutionPersistenceBundle({
    traceId: readString(ctx?.traceId),
    ensures: Array.isArray(ctx?.ensures)
      ? (ctx.ensures as Array<ExecutionPersistenceEnsureEvent | null | undefined>)
      : [],
    updates: Array.isArray(ctx?.updates)
      ? (ctx.updates as Array<ExecutionPersistenceUpdateEvent | null | undefined>)
      : [],
  });

  if (directBundle) {
    return directBundle;
  }

  const nestedData = readRecord(ctx?.data);
  if (!nestedData) {
    return null;
  }

  return createExecutionPersistenceBundle({
    traceId: readString(nestedData.traceId),
    ensures: Array.isArray(nestedData.ensures)
      ? (nestedData.ensures as Array<
          ExecutionPersistenceEnsureEvent | null | undefined
        >)
      : [],
    updates: Array.isArray(nestedData.updates)
      ? (nestedData.updates as Array<
          ExecutionPersistenceUpdateEvent | null | undefined
        >)
      : [],
  });
}

function buildPersistedEntityKey(
  entityType: ExecutionPersistenceEntityType,
  entityId: string,
): string {
  return `${entityType}:${entityId}`;
}

function buildPendingEventKey(event: ExecutionPersistenceEvent): string {
  if (event.kind === "ensure") {
    return `ensure:${buildPersistedEntityKey(event.entityType, event.entityId)}`;
  }

  return `update:${buildPersistedEntityKey(event.entityType, event.entityId)}`;
}

function isDependencySatisfied(
  state: ExecutionPersistenceCoordinatorRuntimeState,
  dependencyKey: string,
): boolean {
  const separatorIndex = dependencyKey.indexOf(":");
  if (separatorIndex <= 0) {
    return false;
  }

  const entityType = dependencyKey.slice(
    0,
    separatorIndex,
  ) as ExecutionPersistenceEntityType;
  const entityId = dependencyKey.slice(separatorIndex + 1);
  return state.persisted[entityType]?.[entityId] === true;
}

function eventReady(
  state: ExecutionPersistenceCoordinatorRuntimeState,
  event: ExecutionPersistenceEvent,
): boolean {
  return event.deps.every((dependencyKey: string) =>
    isDependencySatisfied(state, dependencyKey),
  );
}

function eventOrderWeight(event: ExecutionPersistenceEvent): number {
  const baseWeightMap: Record<ExecutionPersistenceEntityType, number> = {
    execution_trace: 0,
    routine_execution: 10,
    signal_emission: 20,
    inquiry: 20,
    task_execution: 30,
  };

  return baseWeightMap[event.entityType] + (event.kind === "update" ? 100 : 0);
}

function dedupeDependencies(values: string[]): string[] {
  return Array.from(new Set(values));
}

function mergePendingEvent(
  existing: ExecutionPersistenceEvent | undefined,
  incoming: ExecutionPersistenceEvent,
): ExecutionPersistenceEvent {
  if (!existing) {
    return incoming;
  }

  if (incoming.kind === "ensure" && existing.kind === "ensure") {
    return {
      ...incoming,
      deps: dedupeDependencies([...existing.deps, ...incoming.deps]),
      data: {
        ...existing.data,
        ...incoming.data,
      },
    };
  }

  if (incoming.kind === "update" && existing.kind === "update") {
    return {
      ...incoming,
      deps: dedupeDependencies([...existing.deps, ...incoming.deps]),
      data: {
        ...existing.data,
        ...incoming.data,
      },
      filter: {
        ...existing.filter,
        ...incoming.filter,
      },
    };
  }

  return incoming;
}

function enqueueEvent(
  state: ExecutionPersistenceCoordinatorRuntimeState,
  event: ExecutionPersistenceEvent,
): void {
  if (
    event.kind === "ensure" &&
    state.persisted[event.entityType]?.[event.entityId] === true
  ) {
    return;
  }

  const eventKey = buildPendingEventKey(event);
  state.pending[eventKey] = mergePendingEvent(state.pending[eventKey], event);
}

function enqueueBundle(
  state: ExecutionPersistenceCoordinatorRuntimeState,
  bundle: ExecutionPersistenceBundle,
): void {
  for (const event of bundle.ensures) {
    enqueueEvent(state, event);
  }

  for (const event of bundle.updates) {
    enqueueEvent(state, event);
  }
}

function buildExecutionObservabilityOnConflict(
  tableName: ExecutionPersistenceEnsureEntityType,
): { target: string[]; action: { do: "nothing" } } {
  return {
    target: ["uuid"],
    action: {
      do: "nothing",
    },
  };
}

function buildExecutionPersistenceIntentName(
  operation: "insert" | "update",
  tableName: ExecutionPersistenceEntityType,
): string {
  return `meta-${operation}-pg-${CADENZA_DB_POSTGRES_ACTOR_TOKEN}-${tableName}`;
}

function normalizeRoutineExecutionInsertData(
  data: Record<string, any>,
): Record<string, any> {
  const normalizedData = { ...data };

  const traceId = readString(
    normalizedData.execution_trace_id ?? normalizedData.executionTraceId,
  );
  const metaContext =
    readRecord(normalizedData.meta_context) ?? readRecord(normalizedData.metaContext);
  const isMeta =
    normalizedData.is_meta === true || normalizedData.isMeta === true;
  const serviceName = readString(
    normalizedData.service_name ?? normalizedData.serviceName,
  );
  const serviceInstanceId = readString(
    normalizedData.service_instance_id ?? normalizedData.serviceInstanceId,
  );

  if (traceId) {
    normalizedData.execution_trace_id = traceId;
  }
  if (metaContext) {
    normalizedData.meta_context = metaContext;
  }
  if (normalizedData.is_meta !== undefined || normalizedData.isMeta !== undefined) {
    normalizedData.is_meta = isMeta;
  }
  if (serviceName) {
    normalizedData.service_name = serviceName;
  }
  if (serviceInstanceId) {
    normalizedData.service_instance_id = serviceInstanceId;
  } else if (
    normalizedData.serviceInstanceId === null ||
    normalizedData.service_instance_id === null
  ) {
    normalizedData.service_instance_id = null;
  }

  delete normalizedData.executionTraceId;
  delete normalizedData.traceId;
  delete normalizedData.metaContext;
  delete normalizedData.isMeta;
  delete normalizedData.serviceName;
  delete normalizedData.serviceInstanceId;
  return normalizedData;
}

function normalizeEnsureInsertData(
  entityType: ExecutionPersistenceEnsureEntityType,
  data: Record<string, any>,
): Record<string, any> {
  switch (entityType) {
    case "routine_execution":
      return normalizeExecutionPayloadContexts(
        normalizeRoutineExecutionInsertData(data),
      );
    case "execution_trace":
    case "task_execution":
    case "inquiry":
      return normalizeExecutionPayloadContexts(data);
    case "signal_emission": {
      const normalizedData = normalizeExecutionPayloadContexts(data);
      delete normalizedData.meta_context;
      delete normalizedData.metaContext;
      return normalizedData;
    }
    default:
      return data;
  }
}

function normalizeUpdateData(
  entityType: ExecutionPersistenceUpdateEntityType,
  data: Record<string, any>,
): Record<string, any> {
  switch (entityType) {
    case "routine_execution":
    case "task_execution":
    case "inquiry":
      return normalizeExecutionPayloadContexts(data);
    default:
      return data;
  }
}

async function persistEvent(event: ExecutionPersistenceEvent): Promise<void> {
  if (event.kind === "ensure") {
    const result = await Cadenza.inquire(
      buildExecutionPersistenceIntentName("insert", event.entityType),
      {
        queryData: {
          data: normalizeEnsureInsertData(event.entityType, event.data),
          onConflict: buildExecutionObservabilityOnConflict(event.entityType),
        },
      },
    );

    if (result?.__success !== true) {
      throw new Error(
        String(
          result?.__error ??
            `Execution persistence insert failed for ${event.entityType}`,
        ),
      );
    }

    return;
  }

  const result = await Cadenza.inquire(
    buildExecutionPersistenceIntentName("update", event.entityType),
    {
      queryData: {
        data: normalizeUpdateData(event.entityType, event.data),
        filter: event.filter,
      },
    },
  );

  if (result?.__success !== true) {
    throw new Error(
      String(
        result?.__error ??
          `Execution persistence update failed for ${event.entityType}`,
      ),
    );
  }
}

async function drainReadyEvents(
  state: ExecutionPersistenceCoordinatorRuntimeState,
): Promise<void> {
  while (true) {
    const readyEvents = Object.values(state.pending)
      .filter((event) => eventReady(state, event))
      .sort((left, right) => {
        const weightDelta = eventOrderWeight(left) - eventOrderWeight(right);
        if (weightDelta !== 0) {
          return weightDelta;
        }

        return buildPendingEventKey(left).localeCompare(buildPendingEventKey(right));
      });

    if (readyEvents.length === 0) {
      return;
    }

    for (const event of readyEvents) {
      await persistEvent(event);
      delete state.pending[buildPendingEventKey(event)];

      if (event.kind === "ensure") {
        state.persisted[event.entityType][event.entityId] = true;
      }
    }
  }
}

function buildExecutionTraceBundleFromContext(
  ctx: Record<string, any>,
): ExecutionPersistenceBundle | null {
  const data = readRecord(ctx?.data);
  if (!data) {
    return null;
  }

  const entityId = readString(data.uuid);
  if (!entityId) {
    return null;
  }

  return createExecutionPersistenceBundle({
    ensures: [
      {
        kind: "ensure",
        entityType: "execution_trace",
        entityId,
        data,
        deps: [],
      },
    ],
  });
}

function buildRoutineExecutionUpdateBundleFromContext(
  ctx: Record<string, any>,
): ExecutionPersistenceBundle | null {
  const data = readRecord(ctx?.data);
  const filter = readRecord(ctx?.filter);
  const routineExecutionId = readString(
    filter?.uuid ??
      data?.uuid ??
      data?.routineExecutionId ??
      data?.routine_execution_id,
  );

  if (!data || !filter || !routineExecutionId) {
    return null;
  }

  return createExecutionPersistenceBundle({
    traceId: readString(data.executionTraceId ?? data.execution_trace_id),
    updates: [
      {
        kind: "update",
        entityType: "routine_execution",
        entityId: routineExecutionId,
        data,
        filter,
        deps: [`routine_execution:${routineExecutionId}`],
      },
    ],
  });
}

function buildTaskExecutionUpdateBundleFromContext(
  ctx: Record<string, any>,
): ExecutionPersistenceBundle | null {
  const data = readRecord(ctx?.data);
  const filter = readRecord(ctx?.filter);
  const taskExecutionId = readString(
    filter?.uuid ?? data?.uuid ?? data?.taskExecutionId ?? data?.task_execution_id,
  );

  if (!data || !filter || !taskExecutionId) {
    return null;
  }

  return createExecutionPersistenceBundle({
    traceId: readString(data.executionTraceId ?? data.execution_trace_id),
    updates: [
      {
        kind: "update",
        entityType: "task_execution",
        entityId: taskExecutionId,
        data,
        filter,
        deps: [`task_execution:${taskExecutionId}`],
      },
    ],
  });
}

export default class ExecutionPersistenceCoordinator {
  private static _instance: ExecutionPersistenceCoordinator;
  private static processedBundleCount = 0;

  public static get instance(): ExecutionPersistenceCoordinator {
    if (!this._instance) {
      this._instance = new ExecutionPersistenceCoordinator();
    }

    return this._instance;
  }

  private initialized = false;

  private constructor() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    const coordinatorActor = Cadenza.createActor<
      {},
      ExecutionPersistenceCoordinatorRuntimeState
    >(
      {
        name: "ExecutionPersistenceCoordinatorActor",
        description:
          "Coordinates ordered authority-side persistence for execution observability entities by execution trace.",
        defaultKey: "global",
        keyResolver: (input: Record<string, any>) =>
          readString(input.traceId) ?? undefined,
        initState: {},
        session: {
          persistDurableState: false,
          enabled: true,
          idleTtlMs: COORDINATOR_ACTOR_IDLE_TTL_MS,
          absoluteTtlMs: COORDINATOR_ACTOR_ABSOLUTE_TTL_MS,
        },
      },
      { isMeta: true },
    );

    const processExecutionPersistenceBundleTask = Cadenza.createMetaTask(
      "Process execution persistence bundle",
      coordinatorActor.task(async (actorContext) => {
        const input = normalizeExecutionPersistenceBundle(
          actorContext.input as Record<string, any>,
        );
        if (!input) {
          return false;
        }

        const runtimeState =
          actorContext.runtimeState as
            | ExecutionPersistenceCoordinatorRuntimeState
            | null
            | undefined;
        const state: ExecutionPersistenceCoordinatorRuntimeState = runtimeState
          ? {
              persisted: {
                execution_trace: {
                  ...runtimeState.persisted.execution_trace,
                },
                routine_execution: {
                  ...runtimeState.persisted.routine_execution,
                },
                signal_emission: {
                  ...runtimeState.persisted.signal_emission,
                },
                inquiry: {
                  ...runtimeState.persisted.inquiry,
                },
                task_execution: {
                  ...runtimeState.persisted.task_execution,
                },
              },
              pending: { ...runtimeState.pending },
              lastTouchedAt: runtimeState.lastTouchedAt,
            }
          : createRuntimeState();

        enqueueBundle(state, input);
        state.lastTouchedAt = new Date().toISOString();

        try {
          await drainReadyEvents(state);
        } catch (error) {
          Cadenza.log(
            "Execution persistence coordinator failed to flush a bundle.",
            {
              traceId: input.traceId,
              error:
                error instanceof Error
                  ? error.message
                  : String(error ?? "Unknown error"),
            },
            "error",
          );
        }

        ExecutionPersistenceCoordinator.processedBundleCount += 1;
        actorContext.setRuntimeState(
          shouldCompactRuntimeStateAfterBundle(input, state)
            ? {
                ...createRuntimeState(),
                lastTouchedAt: state.lastTouchedAt,
              }
            : state,
        );

        const currentSummary = summarizeCoordinatorRuntimeState(
          shouldCompactRuntimeStateAfterBundle(input, state)
            ? {
                ...createRuntimeState(),
                lastTouchedAt: state.lastTouchedAt,
              }
            : state,
        );
        const shouldLogStats =
          ExecutionPersistenceCoordinator.processedBundleCount %
            COORDINATOR_STATS_LOG_INTERVAL ===
            0 ||
          currentSummary.pendingCount >= COORDINATOR_STATS_LOG_PENDING_THRESHOLD ||
          currentSummary.persistedCount >=
            COORDINATOR_STATS_LOG_PERSISTED_THRESHOLD;

        if (shouldLogStats) {
          const stats = collectCoordinatorStats(coordinatorActor);
          Cadenza.log("Execution persistence coordinator stats", {
            traceId: input.traceId,
            currentPendingCount: currentSummary.pendingCount,
            currentPersistedCount: currentSummary.persistedCount,
            actorKeyCount: stats.actorKeyCount,
            totalPendingCount: stats.totalPendingCount,
            totalPersistedCount: stats.totalPersistedCount,
            maxPendingPerKey: stats.maxPendingPerKey,
            maxPersistedPerKey: stats.maxPersistedPerKey,
            processedBundleCount:
              ExecutionPersistenceCoordinator.processedBundleCount,
          });
        }

        return {
          __success: true,
          traceId: input.traceId,
          pendingCount: Object.keys(state.pending).length,
        };
      }, { mode: "write" }),
      "Processes one execution persistence bundle through the authority-side coordinator actor.",
    ).doOn(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL);

  }
}
