import Cadenza, {
  AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT,
  AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT,
  AUTHORITY_SERVICE_INSTANCE_REGISTER_TASK_NAME,
  AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT,
  AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_TASK_NAME,
  AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL,
  explodeServiceManifestSnapshots,
  normalizeServiceManifestSnapshot,
  selectLatestServiceManifestSnapshots,
} from "@cadenza.io/service";
import v8 from "node:v8";
import ExecutionPersistenceCoordinator from "./execution/ExecutionPersistenceCoordinator";
import { registerAuthorityRuntimeStatusTasks } from "./runtimeStatusAuthority";
import {
  collectServiceInstanceOriginReconciliationPlans,
  normalizeServiceInstance,
  normalizeServiceTransport,
  planServiceInstanceOriginReconciliation,
  type ServiceInstanceDescriptor,
  type ServiceTransportRole,
} from "./serviceRegistrySync";

let CREATED = false;
let LOCAL_SYNC_INITIALIZED = false;
const SYNC_DEBUG_PREFIX = "[CADENZA_DB_SYNC_DEBUG]";
const LOCAL_SYNC_DEBUG_ENABLED =
  typeof process !== "undefined" &&
  typeof process.env === "object" &&
  process.env.CADENZA_DB_SYNC_DEBUG === "true";
const CANONICALIZATION_TRACE_ENABLED =
  typeof process !== "undefined" &&
  typeof process.env === "object" &&
  (process.env.CADENZA_DB_CANONICALIZATION_TRACE === "1" ||
    process.env.CADENZA_DB_CANONICALIZATION_TRACE === "true");
const META_SERVICE_INSTANCE_ORIGIN_RECONCILIATION_REQUESTED =
  "meta.cadenza_db.service_instance_origin_reconciliation_requested";
const META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_REQUESTED =
  "meta.cadenza_db.canonicalize_service_instance_origins_requested";
const META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_EXECUTE =
  "meta.cadenza_db.canonicalize_service_instance_origins_execute";
const META_AUTHORITY_REGISTRY_PROJECTION_REQUESTED =
  "meta.cadenza_db.authority_registry_projection_requested";
const META_AUTHORITY_REGISTRY_PROJECTION_EXECUTE =
  "meta.cadenza_db.authority_registry_projection_execute";
const META_MANIFEST_ENTITY_PROJECTION_REQUESTED =
  "meta.cadenza_db.manifest_entity_projection_requested";
const META_AUTHORITY_SERVICE_MANIFEST_PROJECTION_REQUESTED =
  "meta.cadenza_db.authority_service_manifest_projection_requested";
const META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED =
  "meta.cadenza_db.manifest_association_projection_requested";
const META_TOOL_DEPENDENCY_SNAPSHOT_REFRESH_REQUESTED =
  "meta.cadenza_db.tool_dependency_snapshot_refresh_requested";
const META_TOOL_DEPENDENCY_SNAPSHOT_REFRESH_EXECUTE =
  "meta.cadenza_db.tool_dependency_snapshot_refresh_execute";
const META_AUTHORITY_SERVICE_MANIFEST_REPORT_RETRY_REQUESTED =
  "meta.cadenza_db.authority_service_manifest_report_retry_requested";
const MANIFEST_ASSOCIATION_PROJECTION_DEBOUNCE_MS = 50;
const MANIFEST_ASSOCIATION_PROJECTION_ACCUMULATOR_TTL_MS = 60000;
const MANIFEST_ASSOCIATION_REPLAY_FLUSH_DELAYS_MS = [250, 1500, 5000] as const;
const TOOL_DEPENDENCY_SNAPSHOT_REFRESH_DEBOUNCE_MS = 50;
const STRUCTURAL_NAME_MAX_LENGTH = 255;
const SERVICE_INSTANCE_ORIGIN_CANONICALIZATION_STARTUP_DELAYS_MS = [
  250,
  1500,
  5000,
  15000,
  30000,
] as const;
const AUTHORITY_REGISTRY_PROJECTION_STARTUP_DELAYS_MS = [
  250,
  1500,
  5000,
] as const;
const AUTHORITY_REGISTRY_PROJECTION_ACCUMULATOR_TTL_MS = 60000;
const AUTHORITY_SERVICE_MANIFEST_ENSURE_DELAYS_MS = [
  25,
  250,
  1500,
  5000,
] as const;
const RUNTIME_DIAGNOSTICS_ENABLED =
  typeof process !== "undefined" &&
  typeof process.env === "object" &&
  (process.env.CADENZA_DB_RUNTIME_DIAGNOSTICS === "1" ||
    process.env.CADENZA_DB_RUNTIME_DIAGNOSTICS === "true");
const RUNTIME_DIAGNOSTICS_INTERVAL_MS = 15000;
const META_RETIRE_SUPERSEDED_SERVICE_INSTANCE =
  "meta.cadenza_db.retire_superseded_service_instance";
const META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_LEASE =
  "meta.cadenza_db.retire_superseded_service_instance_lease";
const META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_TRANSPORT =
  "meta.cadenza_db.retire_superseded_service_instance_transport";
const META_SERVICE_INSTANCE_LEASE_CONSISTENCY_SWEEP_REQUESTED =
  "meta.cadenza_db.service_instance_lease_consistency_sweep_requested";
const META_SERVICE_INSTANCE_LEASE_CONSISTENCY_UPDATES_READY =
  "meta.cadenza_db.service_instance_lease_consistency_updates_ready";
const META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE =
  "meta.cadenza_db.evaluate_transportless_service_instance";
const authorityRegistryProjectionAccumulator = new Map<
  string,
  {
    updatedAt: number;
    serviceInstances?: Array<Record<string, unknown>>;
    serviceInstanceLeases?: Array<Record<string, unknown>>;
    serviceInstanceTransports?: Array<Record<string, unknown>>;
    serviceManifests?: Array<Record<string, unknown>>;
  }
>();
const pendingAuthorityRegistryProjectionIds: string[] = [];
let activeAuthorityRegistryProjectionId: string | null = null;
const authorityRegistryProjectionPayloads = new Map<
  string,
  {
    updatedAt: number;
    serviceInstances: Array<Record<string, unknown>>;
    serviceInstanceLeases: Array<Record<string, unknown>>;
    serviceInstanceTransports: Array<Record<string, unknown>>;
    serviceManifests: Array<Record<string, unknown>>;
  }
>();
type ManifestAssociationEntityKind =
  | "task"
  | "signal"
  | "intent"
  | "actor"
  | "routine"
  | "helper"
  | "global";

type ToolDependencyKind = "helper" | "global";

type ToolDependencyGraph = {
  taskToHelperMaps: Array<Record<string, unknown>>;
  helperToHelperMaps: Array<Record<string, unknown>>;
  taskToGlobalMaps: Array<Record<string, unknown>>;
  helperToGlobalMaps: Array<Record<string, unknown>>;
};

type ToolDependencySnapshotRows = {
  taskSnapshots: Array<Record<string, unknown>>;
  helperSnapshots: Array<Record<string, unknown>>;
};
const manifestAssociationProjectionAccumulator = new Map<
  string,
  {
    updatedAt: number;
    payload: Record<string, unknown>;
    pendingEntityKinds: Set<ManifestAssociationEntityKind>;
  }
>();

function logLocalSyncDebug(event: string, payload: Record<string, unknown>) {
  if (!LOCAL_SYNC_DEBUG_ENABLED) {
    return;
  }

  console.log(`${SYNC_DEBUG_PREFIX} ${event}`, payload);
}

function estimateJsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? Buffer.byteLength(text, "utf8") : null;
  } catch {
    return null;
  }
}

function estimateArrayBytes<T>(
  values: T[] | undefined,
  valueMapper?: (value: T, index: number) => unknown,
): number | null {
  if (!values) {
    return null;
  }

  return estimateJsonBytes(
    values.map((value, index) => (valueMapper ? valueMapper(value, index) : value)),
  );
}

function estimateMapBytes<K, V>(
  map: Map<K, V> | undefined,
  valueMapper?: (value: V, key: K) => unknown,
): number | null {
  if (!map) {
    return null;
  }

  return estimateJsonBytes(
    Array.from(map.entries()).map(([key, value]) => [
      key,
      valueMapper ? valueMapper(value, key) : value,
    ]),
  );
}

function estimateSetMapBytes(
  map: Map<string, Set<string>> | undefined,
): number | null {
  if (!map) {
    return null;
  }

  return estimateJsonBytes(
    Array.from(map.entries()).map(([key, values]) => [key, Array.from(values)]),
  );
}

function estimateObserverTaskMapBytes(
  map:
    | Map<
        string,
        {
          tasks?: Set<{ name?: string }>;
          registered?: boolean;
        }
      >
    | undefined,
): number | null {
  if (!map) {
    return null;
  }

  return estimateJsonBytes(
    Array.from(map.entries()).map(([key, observer]) => ({
      key,
      registered: observer.registered ?? false,
      tasks: Array.from(observer.tasks ?? []).map((task) => task.name ?? null),
    })),
  );
}

function estimateProjectionAccumulatorBytes(
  accumulator: Map<string, { updatedAt: number; payload?: Record<string, unknown> } | Record<string, unknown>>,
): number | null {
  return estimateJsonBytes(
    Array.from(accumulator.entries()).map(([key, value]) => ({
      key,
      value,
    })),
  );
}

async function resolveAuthorityManifestParentPresence(
  serviceName: string,
  serviceInstanceId: string,
): Promise<{
  serviceExists: boolean;
  serviceInstanceExists: boolean;
}> {
  const actor = Cadenza.getActor("CadenzaDBPostgresActor");
  const runtimeState =
    typeof actor?.getRuntimeState === "function"
      ? (actor.getRuntimeState("cadenza_db") as { pool?: { query: Function } } | undefined)
      : undefined;
  const pool = runtimeState?.pool;

  if (!pool || typeof pool.query !== "function") {
    return {
      serviceExists: false,
      serviceInstanceExists: false,
    };
  }

  const result = await pool.query(
    `SELECT
      EXISTS(SELECT 1 FROM service WHERE name = $1) AS service_exists,
      EXISTS(SELECT 1 FROM service_instance WHERE uuid = $2) AS service_instance_exists`,
    [serviceName, serviceInstanceId],
  );

  const row =
    Array.isArray(result?.rows) && result.rows.length > 0
      ? (result.rows[0] as Record<string, unknown>)
      : {};

  return {
    serviceExists: row.service_exists === true,
    serviceInstanceExists: row.service_instance_exists === true,
  };
}

async function resolveAuthorityCurrentManifestSnapshot(
  serviceInstanceId: string,
): Promise<{
  revision: number | null;
  manifestHash: string | null;
}> {
  const actor = Cadenza.getActor("CadenzaDBPostgresActor");
  const runtimeState =
    typeof actor?.getRuntimeState === "function"
      ? (actor.getRuntimeState("cadenza_db") as { pool?: { query: Function } } | undefined)
      : undefined;
  const pool = runtimeState?.pool;

  if (!pool || typeof pool.query !== "function") {
    return {
      revision: null,
      manifestHash: null,
    };
  }

  const result = await pool.query(
    `SELECT revision, manifest_hash
       FROM service_manifest
      WHERE service_instance_id = $1
      LIMIT 1`,
    [serviceInstanceId],
  );

  const row =
    Array.isArray(result?.rows) && result.rows.length > 0
      ? (result.rows[0] as Record<string, unknown>)
      : {};

  const revision = Number(row.revision);

  return {
    revision: Number.isFinite(revision) ? revision : null,
    manifestHash:
      typeof row.manifest_hash === "string" && row.manifest_hash.trim().length > 0
        ? row.manifest_hash
        : null,
  };
}

function summarizeGraphLayerChain(layer: unknown) {
  const summary = {
    layerCount: 0,
    nodeCount: 0,
    unprocessedNodeCount: 0,
    waitingNodeCount: 0,
    processingNodeCount: 0,
    contextBytes: 0,
    metadataBytes: 0,
    topTaskNames: [] as Array<{ taskName: string | null; count: number }>,
    topUnprocessedTaskNames: [] as Array<{ taskName: string | null; count: number }>,
    processingTaskNames: [] as Array<{ taskName: string | null; count: number }>,
  };
  const taskNameCounts = new Map<string | null, number>();
  const unprocessedTaskNameCounts = new Map<string | null, number>();
  const processingTaskNameCounts = new Map<string | null, number>();

  const seenLayers = new Set<unknown>();
  let current = layer as
    | {
        nodes?: Array<{
          context?: {
            getFullContext?: () => unknown;
            getMetadata?: () => unknown;
          };
        }>;
        waitingNodes?: unknown[];
        processingNodes?: Set<unknown>;
        getNext?: () => unknown;
      }
    | undefined;

  while (current && !seenLayers.has(current)) {
    seenLayers.add(current);
    summary.layerCount += 1;
    summary.nodeCount += current.nodes?.length ?? 0;
    summary.waitingNodeCount += current.waitingNodes?.length ?? 0;
    summary.processingNodeCount += current.processingNodes?.size ?? 0;

    for (const node of current.nodes ?? []) {
      summary.contextBytes +=
        estimateJsonBytes(node.context?.getFullContext?.()) ?? 0;
      summary.metadataBytes += estimateJsonBytes(node.context?.getMetadata?.()) ?? 0;
      const taskName =
        (node as { task?: { name?: string } }).task?.name ?? null;
      taskNameCounts.set(taskName, (taskNameCounts.get(taskName) ?? 0) + 1);
      const processed =
        typeof (node as { isProcessed?: () => boolean }).isProcessed === "function"
          ? (node as { isProcessed: () => boolean }).isProcessed()
          : true;
      if (!processed) {
        summary.unprocessedNodeCount += 1;
        unprocessedTaskNameCounts.set(
          taskName,
          (unprocessedTaskNameCounts.get(taskName) ?? 0) + 1,
        );
      }
    }

    for (const processingNode of current.processingNodes ?? []) {
      const taskName =
        (processingNode as { task?: { name?: string } }).task?.name ?? null;
      processingTaskNameCounts.set(
        taskName,
        (processingTaskNameCounts.get(taskName) ?? 0) + 1,
      );
    }

    current = current.getNext?.() as typeof current;
  }

  summary.topTaskNames = Array.from(taskNameCounts.entries())
    .map(([taskName, count]) => ({ taskName, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 12);
  summary.topUnprocessedTaskNames = Array.from(unprocessedTaskNameCounts.entries())
    .map(([taskName, count]) => ({ taskName, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 12);
  summary.processingTaskNames = Array.from(processingTaskNameCounts.entries())
    .map(([taskName, count]) => ({ taskName, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 12);

  return summary;
}

function summarizeRunnerState(runner: unknown) {
  const graphRunner = runner as
    | {
        currentRun?: { graph?: unknown };
        strategy?: {
          graphBuilder?: {
            graph?: unknown;
            layers?: unknown[];
          };
        };
      }
    | undefined;

  const currentRunGraphSummary = summarizeGraphLayerChain(
    graphRunner?.currentRun?.graph,
  );
  const builderGraphSummary = summarizeGraphLayerChain(
    graphRunner?.strategy?.graphBuilder?.graph,
  );

  return {
    builderLayerCount: graphRunner?.strategy?.graphBuilder?.layers?.length ?? 0,
    currentRunGraph: currentRunGraphSummary,
    builderGraph: builderGraphSummary,
  };
}

function summarizeTaskForRuntimeDiagnostics(task: unknown) {
  const record = task as {
    name?: string;
    version?: number;
    description?: string;
    layerIndex?: number;
    concurrency?: number;
    timeout?: number;
    retryCount?: number;
    retryDelay?: number;
    retryDelayMax?: number;
    retryDelayFactor?: number;
    validateInputContext?: boolean;
    validateOutputContext?: boolean;
    inputContextSchema?: unknown;
    outputContextSchema?: unknown;
    isMeta?: boolean;
    isSubMeta?: boolean;
    isDeputy?: boolean;
    isSignal?: boolean;
    isUnique?: boolean;
    isHidden?: boolean;
    isEphemeral?: boolean;
    throttled?: boolean;
    nextTasks?: Set<{ name?: string }>;
    predecessorTasks?: Set<{ name?: string }>;
    observedSignals?: Set<string>;
    emitsSignals?: Set<string>;
    signalsToEmitAfter?: Set<string>;
    signalsToEmitOnFail?: Set<string>;
    handlesIntents?: Set<string>;
    inquiresIntents?: Set<string>;
    helperAliases?: Map<string, string>;
    globalAliases?: Map<string, string>;
  };

  return {
    name: record.name ?? null,
    version: record.version ?? 1,
    description: record.description ?? "",
    layerIndex: record.layerIndex ?? 0,
    concurrency: record.concurrency ?? 0,
    timeout: record.timeout ?? 0,
    retryCount: record.retryCount ?? 0,
    retryDelay: record.retryDelay ?? 0,
    retryDelayMax: record.retryDelayMax ?? 0,
    retryDelayFactor: record.retryDelayFactor ?? 1,
    validateInputContext: record.validateInputContext ?? false,
    validateOutputContext: record.validateOutputContext ?? false,
    inputContextSchema: record.inputContextSchema ?? null,
    outputContextSchema: record.outputContextSchema ?? null,
    isMeta: record.isMeta ?? false,
    isSubMeta: record.isSubMeta ?? false,
    isDeputy: record.isDeputy ?? false,
    isSignal: record.isSignal ?? false,
    isUnique: record.isUnique ?? false,
    isHidden: record.isHidden ?? false,
    isEphemeral: record.isEphemeral ?? false,
    throttled: record.throttled ?? false,
    nextTaskNames: Array.from(record.nextTasks ?? []).map(
      (nextTask) => nextTask.name ?? null,
    ),
    predecessorTaskNames: Array.from(record.predecessorTasks ?? []).map(
      (predecessorTask) => predecessorTask.name ?? null,
    ),
    signals: {
      observed: Array.from(record.observedSignals ?? []),
      emits: Array.from(record.emitsSignals ?? []),
      emitsAfter: Array.from(record.signalsToEmitAfter ?? []),
      emitsOnFail: Array.from(record.signalsToEmitOnFail ?? []),
    },
    intents: {
      handles: Array.from(record.handlesIntents ?? []),
      inquires: Array.from(record.inquiresIntents ?? []),
    },
    tools: {
      helpers: Object.fromEntries(record.helperAliases ?? []),
      globals: Object.fromEntries(record.globalAliases ?? []),
    },
  };
}

function logCanonicalizationTrace(
  event: string,
  payload: Record<string, unknown>,
) {
  if (!CANONICALIZATION_TRACE_ENABLED) {
    return;
  }

  console.log(`[CADENZA_DB_CANONICALIZATION] ${event}`, payload);
}

function scheduleLocalEnsureRetry(callback: () => void, delayMs: number) {
  if (typeof globalThis?.setTimeout !== "function") {
    return;
  }

  globalThis.setTimeout(() => {
    try {
      callback();
    } catch (error) {
      console.error("[CADENZA_DB_SYNC_DEBUG] ensure retry failed", {
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, delayMs);
}

function logRuntimeDiagnostics() {
  if (!RUNTIME_DIAGNOSTICS_ENABLED) {
    return;
  }

  try {
    const actors = Cadenza.getAllActors();
    const cadenzaStatics = Cadenza as unknown as {
      taskCache?: Map<string, unknown>;
      routineCache?: Map<string, unknown>;
      actorCache?: Map<string, unknown>;
      helperCache?: Map<string, unknown>;
      globalCache?: Map<string, unknown>;
    };
    const serviceRegistry = Cadenza.serviceRegistry as unknown as {
      instances?: Map<string, unknown[]>;
      remoteRoutesByKey?: Map<string, unknown>;
      remoteSignals?: Map<string, Set<string>>;
      remoteIntents?: Map<string, Set<string>>;
      deputies?: Map<string, unknown[]>;
      remoteIntentDeputiesByKey?: Map<
        string,
        {
          localTaskName?: string;
          localTask?: {
            name?: string;
            export?: () => unknown;
          };
        }
      >;
    };
    const graphRegistry = Cadenza.registry as unknown as {
      tasks?: Map<string, unknown>;
      routines?: Map<string, unknown>;
    };
    const signalBroker = Cadenza.signalBroker as unknown as {
      signalObservers?: Map<
        string,
        {
          tasks?: Set<{ name?: string }>;
          registered?: boolean;
        }
      >;
      emittedSignalsRegistry?: Set<string>;
      signalMetadataRegistry?: Map<string, unknown>;
      passiveSignalListeners?: Map<string, unknown>;
      throttleEmitters?: Map<string, unknown>;
      throttleQueues?: Map<string, unknown>;
      scheduledBuckets?: Map<string, unknown>;
      debouncedEmitters?: Map<string, unknown>;
      strategyData?: Map<string, Map<string, { signal: string; contexts: unknown[] }>>;
      strategyTimers?: Map<string, unknown>;
      isStrategyFlushing?: Map<string, boolean>;
    };
    const runnerState = summarizeRunnerState(Cadenza.runner);
    const metaRunnerState = summarizeRunnerState(Cadenza.metaRunner);
    const inquiryBroker = (Cadenza as unknown as {
      inquiryBroker?: {
        intents?: Map<string, unknown>;
        inquiryObservers?: Map<
          string,
          {
            tasks?: Set<{ name?: string }>;
            registered?: boolean;
          }
        >;
      };
    }).inquiryBroker;
    const actorSummaries = actors
      .map((actor) => {
        const actorWithKeys = actor as unknown as {
          listActorKeys?: () => string[];
          getRuntimeState?: (actorKey?: string) => unknown;
        };
        const actorKeys =
          typeof actorWithKeys.listActorKeys === "function"
            ? actorWithKeys.listActorKeys()
            : [];
        const runtimeStateBytes = actorKeys.reduce((total, actorKey) => {
          if (typeof actorWithKeys.getRuntimeState !== "function") {
            return total;
          }

          return (
            total + (estimateJsonBytes(actorWithKeys.getRuntimeState(actorKey)) ?? 0)
          );
        }, 0);
        return {
          actorName: actor.spec.name,
          actorKeyCount: actorKeys.length,
          runtimeStateBytes,
        };
      })
      .sort((left, right) =>
        right.runtimeStateBytes - left.runtimeStateBytes ||
        right.actorKeyCount - left.actorKeyCount,
      )
      .slice(0, 10);

    const totalActorKeys = actors.reduce(
      (total, actor) => {
        const actorWithKeys = actor as unknown as {
          listActorKeys?: () => string[];
        };
        return (
          total +
          (typeof actorWithKeys.listActorKeys === "function"
            ? actorWithKeys.listActorKeys().length
            : 0)
        );
      },
      0,
    );
    const memory = process.memoryUsage();
    const graphTaskSummaries = Array.from(graphRegistry.tasks?.values() ?? []).map(
      (task) => summarizeTaskForRuntimeDiagnostics(task),
    );
    const graphTaskBytes = estimateJsonBytes(graphTaskSummaries);
    const graphRoutineBytes = estimateJsonBytes(
      Array.from(graphRegistry.routines?.values() ?? []).map((routine) => {
        const record = routine as {
          name?: string;
          tasks?: Iterable<{ name?: string }>;
        };
        return {
          name: record.name ?? null,
          taskNames: Array.from(record.tasks ?? []).map(
            (task) => task.name ?? null,
          ),
        };
      }),
    );
    const topTaskExports = Array.from(graphRegistry.tasks?.values() ?? [])
      .map((task) => {
        const record = task as {
          name?: string;
          nextTasks?: Set<unknown>;
          predecessorTasks?: Set<unknown>;
          observedSignals?: Set<unknown>;
          emitsSignals?: Set<unknown>;
          signalsToEmitAfter?: Set<unknown>;
          signalsToEmitOnFail?: Set<unknown>;
          handlesIntents?: Set<unknown>;
          inquiresIntents?: Set<unknown>;
        };
        const summarized = summarizeTaskForRuntimeDiagnostics(task);
        return {
          taskName: record.name ?? null,
          exportBytes: estimateJsonBytes(summarized) ?? 0,
          nextTaskCount: record.nextTasks?.size ?? 0,
          predecessorTaskCount: record.predecessorTasks?.size ?? 0,
          observedSignalCount: record.observedSignals?.size ?? 0,
          emitsSignalCount: record.emitsSignals?.size ?? 0,
          emitsAfterCount: record.signalsToEmitAfter?.size ?? 0,
          emitsOnFailCount: record.signalsToEmitOnFail?.size ?? 0,
          handlesIntentCount: record.handlesIntents?.size ?? 0,
          inquiresIntentCount: record.inquiresIntents?.size ?? 0,
        };
      })
      .sort((left, right) => right.exportBytes - left.exportBytes)
      .slice(0, 12);
    const serviceInstanceHealthBytes = estimateJsonBytes(
      serviceRegistry.instances
        ? Array.from(serviceRegistry.instances.entries()).flatMap(
            ([serviceName, instances]) =>
              (instances ?? []).map((instance) => {
                const record = instance as Record<string, unknown>;
                return {
                  serviceName,
                  uuid:
                    typeof record.uuid === "string" ? record.uuid : null,
                  health:
                    record.health && typeof record.health === "object"
                      ? record.health
                      : {},
                };
              }),
          )
        : [],
    );
    const remoteIntentDeputyTaskBytes = estimateJsonBytes(
      Array.from(serviceRegistry.remoteIntentDeputiesByKey?.values() ?? []).map(
        (descriptor) => {
          const task = descriptor.localTask;
          return task
            ? summarizeTaskForRuntimeDiagnostics(task)
            : {
                localTaskName: descriptor.localTaskName ?? null,
              };
        },
      ),
    );
    const heapSpaceBreakdown = v8.getHeapSpaceStatistics().map((space) => ({
      spaceName: space.space_name,
      spaceUsedSize: space.space_used_size,
      spaceAvailableSize: space.space_available_size,
      spaceSize: space.space_size,
      physicalSpaceSize: space.physical_space_size,
    }));
    const heapStatistics = v8.getHeapStatistics();

    console.log("[CADENZA_DB_RUNTIME_DIAGNOSTICS]", {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      taskCount: graphRegistry.tasks?.size ?? 0,
      routineCount: graphRegistry.routines?.size ?? 0,
      intentCount: inquiryBroker?.intents?.size ?? 0,
      serviceInstanceGroupCount: serviceRegistry.instances?.size ?? 0,
      totalServiceInstances:
        Array.from(serviceRegistry.instances?.values() ?? []).reduce(
          (total, instances) => total + instances.length,
          0,
        ) ?? 0,
      remoteRouteCount: serviceRegistry.remoteRoutesByKey?.size ?? 0,
      remoteSignalCount:
        Array.from(serviceRegistry.remoteSignals?.values() ?? []).reduce(
          (total, signals) => total + signals.size,
          0,
        ) ?? 0,
      remoteIntentCount:
        Array.from(serviceRegistry.remoteIntents?.values() ?? []).reduce(
          (total, intents) => total + intents.size,
          0,
        ) ?? 0,
      deputyGroupCount: serviceRegistry.deputies?.size ?? 0,
      cadenzaCacheCounts: {
        taskCache: cadenzaStatics.taskCache?.size ?? 0,
        routineCache: cadenzaStatics.routineCache?.size ?? 0,
        actorCache: cadenzaStatics.actorCache?.size ?? 0,
        helperCache: cadenzaStatics.helperCache?.size ?? 0,
        globalCache: cadenzaStatics.globalCache?.size ?? 0,
      },
      cadenzaCacheBytes: {
        taskCache: estimateMapBytes(cadenzaStatics.taskCache, (task) =>
          summarizeTaskForRuntimeDiagnostics(task),
        ),
        routineCache: estimateMapBytes(cadenzaStatics.routineCache),
        actorCache: estimateMapBytes(cadenzaStatics.actorCache),
        helperCache: estimateMapBytes(cadenzaStatics.helperCache),
        globalCache: estimateMapBytes(cadenzaStatics.globalCache),
      },
      graphRegistryBytes: {
        tasks: graphTaskBytes,
        routines: graphRoutineBytes,
        remoteIntentDeputyTasks: remoteIntentDeputyTaskBytes,
        topTaskExports,
      },
      inquiryBrokerBytes: {
        intents: estimateMapBytes(inquiryBroker?.intents),
        observers: estimateObserverTaskMapBytes(inquiryBroker?.inquiryObservers),
      },
      signalBrokerBytes: {
        signalObservers: estimateObserverTaskMapBytes(signalBroker?.signalObservers),
        emittedSignals: estimateArrayBytes(
          Array.from(signalBroker?.emittedSignalsRegistry ?? []),
        ),
        signalMetadata: estimateMapBytes(signalBroker?.signalMetadataRegistry),
        passiveSignalListeners: estimateMapBytes(signalBroker?.passiveSignalListeners),
        throttleEmitters: estimateMapBytes(signalBroker?.throttleEmitters),
        throttleQueues: estimateMapBytes(signalBroker?.throttleQueues),
        scheduledBuckets: estimateMapBytes(signalBroker?.scheduledBuckets),
        debouncedEmitters: estimateMapBytes(signalBroker?.debouncedEmitters),
        strategyData: estimateMapBytes(signalBroker?.strategyData, (strategyMap) =>
          Array.from(strategyMap.entries()).map(([bucketKey, bucket]) => ({
            bucketKey,
            signal: bucket.signal,
            contextCount: bucket.contexts.length,
          })),
        ),
        strategyTimers: estimateMapBytes(signalBroker?.strategyTimers),
        strategyFlushing: estimateMapBytes(signalBroker?.isStrategyFlushing),
      },
      serviceRegistryBytes: {
        instances: estimateMapBytes(serviceRegistry.instances),
        instanceHealth: serviceInstanceHealthBytes,
        remoteRoutes: estimateMapBytes(serviceRegistry.remoteRoutesByKey),
        remoteSignals: estimateSetMapBytes(serviceRegistry.remoteSignals),
        remoteIntents: estimateSetMapBytes(serviceRegistry.remoteIntents),
        deputies: estimateMapBytes(serviceRegistry.deputies),
        remoteIntentDeputies:
          serviceRegistry.remoteIntentDeputiesByKey?.size ?? 0,
      },
      projectionState: {
        pendingAuthorityRegistryProjectionIds:
          pendingAuthorityRegistryProjectionIds.length,
        activeAuthorityRegistryProjectionId,
        authorityRegistryProjectionAccumulatorSize:
          authorityRegistryProjectionAccumulator.size,
        authorityRegistryProjectionAccumulatorBytes:
          estimateProjectionAccumulatorBytes(
            authorityRegistryProjectionAccumulator as Map<
              string,
              { updatedAt: number; payload?: Record<string, unknown> } | Record<string, unknown>
            >,
          ),
        authorityRegistryProjectionPayloadsSize:
          authorityRegistryProjectionPayloads.size,
        authorityRegistryProjectionPayloadsBytes:
          estimateProjectionAccumulatorBytes(
            authorityRegistryProjectionPayloads as Map<
              string,
              { updatedAt: number; payload?: Record<string, unknown> } | Record<string, unknown>
            >,
          ),
        manifestAssociationProjectionAccumulatorSize:
          manifestAssociationProjectionAccumulator.size,
        manifestAssociationProjectionAccumulatorBytes:
          estimateProjectionAccumulatorBytes(
            manifestAssociationProjectionAccumulator as Map<
              string,
              { updatedAt: number; payload?: Record<string, unknown> } | Record<string, unknown>
            >,
          ),
      },
      runnerState: {
        runner: runnerState,
        metaRunner: metaRunnerState,
      },
      actorCount: actors.length,
      totalActorKeys,
      topActors: actorSummaries,
      v8: {
        totalHeapSize: heapStatistics.total_heap_size,
        totalPhysicalSize: heapStatistics.total_physical_size,
        totalAvailableSize: heapStatistics.total_available_size,
        usedHeapSize: heapStatistics.used_heap_size,
        heapSizeLimit: heapStatistics.heap_size_limit,
        mallocedMemory: heapStatistics.malloced_memory,
        externalMemory: heapStatistics.external_memory,
        nativeContexts: heapStatistics.number_of_native_contexts,
        detachedContexts: heapStatistics.number_of_detached_contexts,
        heapSpaces: heapSpaceBreakdown,
      },
    });
    console.log(
      "[CADENZA_DB_RUNTIME_DIAGNOSTICS_TOP_TASK_EXPORTS]",
      JSON.stringify(topTaskExports),
    );
    console.log(
      "[CADENZA_DB_RUNTIME_DIAGNOSTICS_RUNNER_STATE]",
      JSON.stringify({
        runner: runnerState,
        metaRunner: metaRunnerState,
      }),
    );

    Cadenza.signalBroker?.logMemoryFootprint("cadenza-db");
  } catch (error) {
    console.error("[CADENZA_DB_RUNTIME_DIAGNOSTICS] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function startRuntimeDiagnosticsLoop() {
  if (
    !RUNTIME_DIAGNOSTICS_ENABLED ||
    typeof globalThis?.setInterval !== "function"
  ) {
    return;
  }

  globalThis.setInterval(() => {
    logRuntimeDiagnostics();
  }, RUNTIME_DIAGNOSTICS_INTERVAL_MS);
}

function pruneAuthorityRegistryProjectionAccumulator(now: number) {
  for (const [projectionId, entry] of authorityRegistryProjectionAccumulator) {
    if (
      now - entry.updatedAt >
      AUTHORITY_REGISTRY_PROJECTION_ACCUMULATOR_TTL_MS
    ) {
      authorityRegistryProjectionAccumulator.delete(projectionId);
    }
  }
}

function pruneAuthorityRegistryProjectionPayloads(now: number) {
  for (const [projectionId, entry] of authorityRegistryProjectionPayloads) {
    if (
      now - entry.updatedAt >
      AUTHORITY_REGISTRY_PROJECTION_ACCUMULATOR_TTL_MS
    ) {
      authorityRegistryProjectionPayloads.delete(projectionId);
    }
  }
}

function registerPendingAuthorityRegistryProjectionId(projectionId: string) {
  pendingAuthorityRegistryProjectionIds.push(projectionId);
}

function resolveAuthorityRegistryProjectionId(
  value: unknown,
  options?: {
    consumePending?: boolean;
  },
): string | null {
  const ctx = readRecord(value);
  const directProjectionId = readString(
    ctx?.__projectionId ?? ctx?.projectionId,
  );
  if (directProjectionId) {
    if (pendingAuthorityRegistryProjectionIds[0] === directProjectionId) {
      pendingAuthorityRegistryProjectionIds.shift();
    }
    activeAuthorityRegistryProjectionId = directProjectionId;
    return directProjectionId;
  }

  if (options?.consumePending !== false) {
    const pendingProjectionId = pendingAuthorityRegistryProjectionIds.shift();
    if (pendingProjectionId) {
      activeAuthorityRegistryProjectionId = pendingProjectionId;
      return pendingProjectionId;
    }
  }

  return activeAuthorityRegistryProjectionId;
}

function pruneManifestAssociationProjectionAccumulator(now: number) {
  for (const [key, entry] of manifestAssociationProjectionAccumulator) {
    if (
      now - entry.updatedAt >
      MANIFEST_ASSOCIATION_PROJECTION_ACCUMULATOR_TTL_MS
    ) {
      manifestAssociationProjectionAccumulator.delete(key);
    }
  }
}

function buildManifestAssociationProjectionKey(
  payload: Record<string, unknown>,
): string {
  const explicitKey = readString(payload.__manifestProjectionKey);
  if (explicitKey) {
    return explicitKey;
  }

  const serviceName = readString(
    payload.serviceName ?? payload.__projectedServiceName,
  );
  if (serviceName) {
    return serviceName;
  }

  return `manifest-association-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function collectManifestAssociationPendingEntityKinds(
  payload: Record<string, unknown>,
): Set<ManifestAssociationEntityKind> {
  const kinds = new Set<ManifestAssociationEntityKind>();

  if (normalizeRowArray(payload.__projectedTasks).length > 0) {
    kinds.add("task");
  }
  if (normalizeRowArray(payload.__projectedSignals).length > 0) {
    kinds.add("signal");
  }
  if (normalizeRowArray(payload.__projectedIntents).length > 0) {
    kinds.add("intent");
  }
  if (normalizeRowArray(payload.__projectedActors).length > 0) {
    kinds.add("actor");
  }
  if (normalizeRowArray(payload.__projectedRoutines).length > 0) {
    kinds.add("routine");
  }
  if (normalizeRowArray(payload.__projectedHelpers).length > 0) {
    kinds.add("helper");
  }
  if (normalizeRowArray(payload.__projectedGlobals).length > 0) {
    kinds.add("global");
  }

  return kinds;
}

function queueManifestAssociationProjection(
  payload: Record<string, unknown>,
): boolean {
  const hasAssociations =
    normalizeRowArray(payload.__projectedDirectionalTaskMaps).length > 0 ||
    normalizeRowArray(payload.__projectedSignalToTaskMaps).length > 0 ||
    normalizeRowArray(payload.__projectedIntentToTaskMaps).length > 0 ||
    normalizeRowArray(payload.__projectedActorTaskMaps).length > 0 ||
    normalizeRowArray(payload.__projectedTaskToRoutineMaps).length > 0 ||
    normalizeRowArray(payload.__projectedTaskToHelperMaps).length > 0 ||
    normalizeRowArray(payload.__projectedHelperToHelperMaps).length > 0 ||
    normalizeRowArray(payload.__projectedTaskToGlobalMaps).length > 0 ||
    normalizeRowArray(payload.__projectedHelperToGlobalMaps).length > 0;

  if (!hasAssociations) {
    return false;
  }

  const now = Date.now();
  pruneManifestAssociationProjectionAccumulator(now);
  const key = buildManifestAssociationProjectionKey(payload);
  manifestAssociationProjectionAccumulator.set(
    key,
    {
      updatedAt: now,
      payload: {
        ...payload,
        __manifestProjectionKey: key,
      },
      pendingEntityKinds: collectManifestAssociationPendingEntityKinds(payload),
    },
  );

  return true;
}

function flushPendingManifestAssociationProjections(key?: string) {
  const now = Date.now();
  pruneManifestAssociationProjectionAccumulator(now);

  let flushed = 0;
  for (const [entryKey, entry] of manifestAssociationProjectionAccumulator) {
    if (key && entryKey !== key) {
      continue;
    }
    Cadenza.debounce(
      META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED,
      entry.payload,
      MANIFEST_ASSOCIATION_PROJECTION_DEBOUNCE_MS,
    );
    manifestAssociationProjectionAccumulator.delete(entryKey);
    flushed += 1;
  }

  return flushed;
}

function flushReadyManifestAssociationProjections(key?: string) {
  const now = Date.now();
  pruneManifestAssociationProjectionAccumulator(now);

  let flushed = 0;
  for (const [entryKey, entry] of manifestAssociationProjectionAccumulator) {
    if (key && entryKey !== key) {
      continue;
    }
    if (entry.pendingEntityKinds.size > 0) {
      continue;
    }
    Cadenza.debounce(
      META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED,
      entry.payload,
      MANIFEST_ASSOCIATION_PROJECTION_DEBOUNCE_MS,
    );
    manifestAssociationProjectionAccumulator.delete(entryKey);
    flushed += 1;
  }

  return flushed;
}

function markManifestAssociationProjectionEntityPersisted(
  ctx: Record<string, unknown> | null,
) {
  const projectionKey = readString(ctx?.__manifestProjectionKey);
  const entityKind = readString(ctx?.__manifestEntityKind) as
    | ManifestAssociationEntityKind
    | "";
  if (!projectionKey || !entityKind) {
    return 0;
  }

  const entry = manifestAssociationProjectionAccumulator.get(projectionKey);
  if (!entry) {
    return 0;
  }

  entry.updatedAt = Date.now();
  entry.pendingEntityKinds.delete(entityKind);

  if (entry.pendingEntityKinds.size > 0) {
    manifestAssociationProjectionAccumulator.set(projectionKey, entry);
    return 0;
  }

  return flushPendingManifestAssociationProjections(projectionKey);
}

function buildLegacyLocalSyncQueryTaskName(tableName: string): string {
  const suffix = String(tableName ?? "")
    .trim()
    .split("_")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");

  return `dbQuery${suffix}`;
}

function resolveLocalSyncQueryTask(tableName: string) {
  return (
    Cadenza.get(`Query ${tableName}`) ??
    Cadenza.get(buildLegacyLocalSyncQueryTaskName(tableName))
  );
}

export function resolveDefaultLocalCadenzaDBQueryIntent(task: {
  name?: string;
  handlesIntents?: Iterable<string>;
}) {
  const intentNames = Array.from(task?.handlesIntents ?? []);
  const metaDefaultQueryIntentNames = intentNames.filter((intentName) =>
    intentName.startsWith("meta-query-pg-"),
  );
  const defaultQueryIntentNames = intentNames.filter((intentName) =>
    intentName.startsWith("query-pg-"),
  );

  if (metaDefaultQueryIntentNames.length === 1) {
    return metaDefaultQueryIntentNames[0];
  }

  if (defaultQueryIntentNames.length === 1) {
    return defaultQueryIntentNames[0];
  }

  if (defaultQueryIntentNames.length === 0 && intentNames.length === 1) {
    return intentNames[0];
  }

  throw new Error(
    `Unable to resolve default local CadenzaDB query intent for '${task?.name ?? "unknown query task"}'.`,
  );
}

function createLocalCadenzaDBQueryInquiryTask(
  name: string,
  queryTask: {
    name?: string;
    handlesIntents?: Iterable<string>;
  },
  description: string,
) {
  const inquiryIntent = resolveDefaultLocalCadenzaDBQueryIntent(queryTask);

  return Cadenza.createMetaTask(
    name,
    async (ctx: any, _emit: any, inquire: any) => {
      const result = await inquire(inquiryIntent, ctx, {
        requireComplete: true,
      });

      if (result === false) {
        return false;
      }

      return result && typeof result === "object"
        ? {
            ...ctx,
            ...result,
          }
        : ctx;
    },
    description,
    {
      register: false,
      isHidden: true,
    },
  );
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPersistedUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  );
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function normalizeRowArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function readNumber(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function readInteger(value: unknown): number | null {
  const numeric = readNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function pickManifestTaskProjectionRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const version = readInteger(row.version);
  const layerIndex = readInteger(row.layer_index ?? row.layerIndex);
  const timeout = readInteger(row.timeout);
  const concurrency = readInteger(row.concurrency);
  const retryCount = readInteger(row.retry_count ?? row.retryCount);
  const retryDelay = readInteger(row.retry_delay ?? row.retryDelay);
  const retryDelayMax = readInteger(row.retry_delay_max ?? row.retryDelayMax);
  const retryDelayFactor = readNumber(
    row.retry_delay_factor ?? row.retryDelayFactor,
  );
  const generatedBy = readString(row.generated_by ?? row.generatedBy);

  return {
    name: readString(row.name),
    description: readString(row.description),
    function_string:
      readString(row.function_string) || readString(row.functionString) || "",
    tag_id_getter:
      readString(row.tag_id_getter) || readString(row.tagIdGetter) || null,
    layer_index: layerIndex ?? 0,
    service_name:
      readString(row.service_name) || readString(row.serviceName) || null,
    timeout: timeout ?? 0,
    is_unique: readBoolean(row.is_unique ?? row.isUnique),
    is_meta: readBoolean(row.is_meta ?? row.isMeta),
    is_sub_meta: readBoolean(row.is_sub_meta ?? row.isSubMeta),
    is_deputy: readBoolean(row.is_deputy ?? row.isDeputy),
    is_ephemeral: readBoolean(row.is_ephemeral ?? row.isEphemeral),
    is_signal: readBoolean(row.is_signal ?? row.isSignal),
    is_throttled: readBoolean(row.is_throttled ?? row.isThrottled),
    is_debounce: readBoolean(row.is_debounce ?? row.isDebounce),
    is_hidden: readBoolean(row.is_hidden ?? row.isHidden),
    concurrency: concurrency ?? 0,
    retry_count: retryCount ?? 0,
    retry_delay: retryDelay ?? 0,
    retry_delay_max: retryDelayMax ?? 0,
    retry_delay_factor: retryDelayFactor ?? 1,
    input_context_schema:
      readRecord(row.input_context_schema ?? row.inputContextSchema) ?? null,
    output_context_schema:
      readRecord(row.output_context_schema ?? row.outputContextSchema) ?? null,
    validate_input_context: readBoolean(
      row.validate_input_context ?? row.validateInputContext,
    ),
    validate_output_context: readBoolean(
      row.validate_output_context ?? row.validateOutputContext,
    ),
    signals: readRecord(row.signals) ?? {},
    intents: readRecord(row.intents) ?? {},
    flags: readRecord(row.flags) ?? {},
    generated_by: generatedBy || null,
    version: version ?? 1,
    deleted: false,
  };
}

function pickManifestHelperProjectionRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const version = readInteger(row.version);
  return {
    name: readString(row.name),
    description: readString(row.description),
    service_name:
      readString(row.service_name) || readString(row.serviceName) || null,
    is_meta: readBoolean(row.is_meta ?? row.isMeta),
    handler_source:
      readString(row.handler_source) || readString(row.handlerSource) || "",
    language: readString(row.language) || "js",
    version: version ?? 1,
    deleted: false,
  };
}

function pickManifestGlobalProjectionRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const version = readInteger(row.version);
  return {
    name: readString(row.name),
    description: readString(row.description),
    service_name:
      readString(row.service_name) || readString(row.serviceName) || null,
    is_meta: readBoolean(row.is_meta ?? row.isMeta),
    value: row.value ?? null,
    version: version ?? 1,
    deleted: false,
  };
}

function buildToolDependencyGraph(input: {
  taskToHelperMaps?: unknown;
  helperToHelperMaps?: unknown;
  taskToGlobalMaps?: unknown;
  helperToGlobalMaps?: unknown;
}): ToolDependencyGraph {
  return {
    taskToHelperMaps: normalizeRowArray(input.taskToHelperMaps).map((row) => ({
      task_name: readString(row.task_name) || readString(row.taskName),
      task_version: readInteger(row.task_version ?? row.taskVersion) ?? 1,
      service_name:
        readString(row.service_name) || readString(row.serviceName) || null,
      alias: readString(row.alias),
      helper_name: readString(row.helper_name) || readString(row.helperName),
      helper_version: readInteger(row.helper_version ?? row.helperVersion) ?? 1,
      deleted: readBoolean(row.deleted),
    })),
    helperToHelperMaps: normalizeRowArray(input.helperToHelperMaps).map((row) => ({
      helper_name: readString(row.helper_name) || readString(row.helperName),
      helper_version: readInteger(row.helper_version ?? row.helperVersion) ?? 1,
      service_name:
        readString(row.service_name) || readString(row.serviceName) || null,
      alias: readString(row.alias),
      dependency_helper_name:
        readString(row.dependency_helper_name) ||
        readString(row.dependencyHelperName),
      dependency_helper_version:
        readInteger(
          row.dependency_helper_version ?? row.dependencyHelperVersion,
        ) ?? 1,
      deleted: readBoolean(row.deleted),
    })),
    taskToGlobalMaps: normalizeRowArray(input.taskToGlobalMaps).map((row) => ({
      task_name: readString(row.task_name) || readString(row.taskName),
      task_version: readInteger(row.task_version ?? row.taskVersion) ?? 1,
      service_name:
        readString(row.service_name) || readString(row.serviceName) || null,
      alias: readString(row.alias),
      global_name: readString(row.global_name) || readString(row.globalName),
      global_version: readInteger(row.global_version ?? row.globalVersion) ?? 1,
      deleted: readBoolean(row.deleted),
    })),
    helperToGlobalMaps: normalizeRowArray(input.helperToGlobalMaps).map((row) => ({
      helper_name: readString(row.helper_name) || readString(row.helperName),
      helper_version: readInteger(row.helper_version ?? row.helperVersion) ?? 1,
      service_name:
        readString(row.service_name) || readString(row.serviceName) || null,
      alias: readString(row.alias),
      global_name: readString(row.global_name) || readString(row.globalName),
      global_version: readInteger(row.global_version ?? row.globalVersion) ?? 1,
      deleted: readBoolean(row.deleted),
    })),
  };
}

function computeToolDependencySnapshotRows(
  input: ToolDependencyGraph,
): ToolDependencySnapshotRows {
  const taskSnapshots: Array<Record<string, unknown>> = [];
  const helperSnapshots: Array<Record<string, unknown>> = [];

  const activeTaskToHelperMaps = input.taskToHelperMaps.filter(
    (row) => row.deleted !== true,
  );
  const activeHelperToHelperMaps = input.helperToHelperMaps.filter(
    (row) => row.deleted !== true,
  );
  const activeTaskToGlobalMaps = input.taskToGlobalMaps.filter(
    (row) => row.deleted !== true,
  );
  const activeHelperToGlobalMaps = input.helperToGlobalMaps.filter(
    (row) => row.deleted !== true,
  );

  const helperToHelperByOwner = new Map<string, Array<Record<string, unknown>>>();
  const helperToGlobalByOwner = new Map<string, Array<Record<string, unknown>>>();

  const buildHelperOwnerKey = (
    serviceName: string,
    helperName: string,
    helperVersion: number,
  ) => `${serviceName}|${helperName}|${helperVersion}`;

  for (const row of activeHelperToHelperMaps) {
    const key = buildHelperOwnerKey(
      readString(row.service_name),
      readString(row.helper_name),
      readInteger(row.helper_version) ?? 1,
    );
    const current = helperToHelperByOwner.get(key) ?? [];
    current.push(row);
    helperToHelperByOwner.set(key, current);
  }

  for (const row of activeHelperToGlobalMaps) {
    const key = buildHelperOwnerKey(
      readString(row.service_name),
      readString(row.helper_name),
      readInteger(row.helper_version) ?? 1,
    );
    const current = helperToGlobalByOwner.get(key) ?? [];
    current.push(row);
    helperToGlobalByOwner.set(key, current);
  }

  const appendHelperSnapshots = (
    owner: {
      serviceName: string;
      helperName: string;
      helperVersion: number;
    },
    into: Array<Record<string, unknown>>,
    options?: {
      aliasPrefix?: string;
      startingDepth?: number;
      visited?: Set<string>;
    },
  ) => {
    const ownerKey = buildHelperOwnerKey(
      owner.serviceName,
      owner.helperName,
      owner.helperVersion,
    );
    const aliasPrefix = readString(options?.aliasPrefix);
    const startingDepth = options?.startingDepth ?? 1;
    const visited = new Set(options?.visited ?? []);
    if (visited.has(ownerKey)) {
      return;
    }
    visited.add(ownerKey);

    const helperChildren = helperToHelperByOwner.get(ownerKey) ?? [];
    for (const child of helperChildren) {
      const alias = readString(child.alias);
      const dependencyHelperName = readString(child.dependency_helper_name);
      const dependencyHelperVersion =
        readInteger(child.dependency_helper_version) ?? 1;
      const fullAlias = aliasPrefix ? `${aliasPrefix}.${alias}` : alias;
      if (!fullAlias || !dependencyHelperName) {
        continue;
      }

      into.push({
        helper_name: owner.helperName,
        helper_version: owner.helperVersion,
        service_name: owner.serviceName,
        alias: fullAlias,
        dependency_kind: "helper",
        dependency_name: dependencyHelperName,
        dependency_version: dependencyHelperVersion,
        depth: startingDepth,
        deleted: false,
      });

      appendHelperSnapshots(
        {
          serviceName: owner.serviceName,
          helperName: dependencyHelperName,
          helperVersion: dependencyHelperVersion,
        },
        into,
        {
          aliasPrefix: fullAlias,
          startingDepth: startingDepth + 1,
          visited,
        },
      );
    }

    const globalChildren = helperToGlobalByOwner.get(ownerKey) ?? [];
    for (const child of globalChildren) {
      const alias = readString(child.alias);
      const globalName = readString(child.global_name);
      const globalVersion = readInteger(child.global_version) ?? 1;
      const fullAlias = aliasPrefix ? `${aliasPrefix}.${alias}` : alias;
      if (!fullAlias || !globalName) {
        continue;
      }

      into.push({
        helper_name: owner.helperName,
        helper_version: owner.helperVersion,
        service_name: owner.serviceName,
        alias: fullAlias,
        dependency_kind: "global",
        dependency_name: globalName,
        dependency_version: globalVersion,
        depth: startingDepth,
        deleted: false,
      });
    }
  };

  for (const row of activeTaskToHelperMaps) {
    const taskName = readString(row.task_name);
    const taskVersion = readInteger(row.task_version) ?? 1;
    const serviceName = readString(row.service_name);
    const alias = readString(row.alias);
    const helperName = readString(row.helper_name);
    const helperVersion = readInteger(row.helper_version) ?? 1;
    if (!taskName || !serviceName || !alias || !helperName) {
      continue;
    }

    taskSnapshots.push({
      task_name: taskName,
      task_version: taskVersion,
      service_name: serviceName,
      alias,
      dependency_kind: "helper",
      dependency_name: helperName,
      dependency_version: helperVersion,
      depth: 1,
      deleted: false,
    });

    const helperClosureRows: Array<Record<string, unknown>> = [];
    appendHelperSnapshots(
      {
        serviceName,
        helperName,
        helperVersion,
      },
      helperClosureRows,
      {
        aliasPrefix: alias,
        startingDepth: 2,
      },
    );

    for (const snapshotRow of helperClosureRows) {
      taskSnapshots.push({
        task_name: taskName,
        task_version: taskVersion,
        service_name: serviceName,
        alias: readString(snapshotRow.alias),
        dependency_kind: readString(snapshotRow.dependency_kind),
        dependency_name: readString(snapshotRow.dependency_name),
        dependency_version: readInteger(snapshotRow.dependency_version) ?? 1,
        depth: readInteger(snapshotRow.depth) ?? 2,
        deleted: false,
      });
    }
  }

  for (const row of activeTaskToGlobalMaps) {
    const taskName = readString(row.task_name);
    const taskVersion = readInteger(row.task_version) ?? 1;
    const serviceName = readString(row.service_name);
    const alias = readString(row.alias);
    const globalName = readString(row.global_name);
    const globalVersion = readInteger(row.global_version) ?? 1;
    if (!taskName || !serviceName || !alias || !globalName) {
      continue;
    }

    taskSnapshots.push({
      task_name: taskName,
      task_version: taskVersion,
      service_name: serviceName,
      alias,
      dependency_kind: "global",
      dependency_name: globalName,
      dependency_version: globalVersion,
      depth: 1,
      deleted: false,
    });
  }

  const helperOwners = new Map<
    string,
    {
      serviceName: string;
      helperName: string;
      helperVersion: number;
    }
  >();

  for (const row of [...activeHelperToHelperMaps, ...activeHelperToGlobalMaps]) {
    const serviceName = readString(row.service_name);
    const helperName = readString(row.helper_name);
    const helperVersion = readInteger(row.helper_version) ?? 1;
    if (!serviceName || !helperName) {
      continue;
    }
    helperOwners.set(
      buildHelperOwnerKey(serviceName, helperName, helperVersion),
      {
        serviceName,
        helperName,
        helperVersion,
      },
    );
  }

  for (const owner of helperOwners.values()) {
    appendHelperSnapshots(owner, helperSnapshots);
  }

  const dedupeRows = (
    rows: Array<Record<string, unknown>>,
    keyBuilder: (row: Record<string, unknown>) => string,
  ) => {
    const deduped = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      deduped.set(keyBuilder(row), row);
    }
    return Array.from(deduped.values());
  };

  return {
    taskSnapshots: dedupeRows(
      taskSnapshots,
      (row) =>
        [
          readString(row.task_name),
          readInteger(row.task_version) ?? 1,
          readString(row.service_name),
          readString(row.alias),
          readString(row.dependency_kind),
          readString(row.dependency_name),
          readInteger(row.dependency_version) ?? 1,
          readInteger(row.depth) ?? 1,
        ].join("|"),
    ),
    helperSnapshots: dedupeRows(
      helperSnapshots,
      (row) =>
        [
          readString(row.helper_name),
          readInteger(row.helper_version) ?? 1,
          readString(row.service_name),
          readString(row.alias),
          readString(row.dependency_kind),
          readString(row.dependency_name),
          readInteger(row.dependency_version) ?? 1,
          readInteger(row.depth) ?? 1,
        ].join("|"),
    ),
  };
}

function resolveServiceManifestSnapshotFromContext(
  value: unknown,
): ReturnType<typeof normalizeServiceManifestSnapshot> {
  const ctx = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!ctx) {
    return null;
  }

  const directCandidates = [
    ctx.__serviceManifestSnapshot,
    ctx.serviceManifest,
    ctx.service_manifest,
    ctx.manifest,
    ctx.data,
  ];

  for (const candidate of directCandidates) {
    const record =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : null;
    if (!record) {
      continue;
    }

    const normalized = normalizeServiceManifestSnapshot(
      record.manifest && typeof record.manifest === "object"
        ? record.manifest
        : record,
    );
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function scheduleAuthorityManifestProjection(
  snapshot: NonNullable<ReturnType<typeof normalizeServiceManifestSnapshot>>,
) {
  Cadenza.schedule(
    META_AUTHORITY_SERVICE_MANIFEST_PROJECTION_REQUESTED,
    {
      __serviceManifestSnapshot: snapshot,
      serviceManifest: snapshot,
    },
    0,
  );
}

type ProjectedManifestStructuralRows = {
  tasks: Array<Record<string, unknown>>;
  signals: Array<Record<string, unknown>>;
  intents: Array<Record<string, unknown>>;
  actors: Array<Record<string, unknown>>;
  routines: Array<Record<string, unknown>>;
  helpers: Array<Record<string, unknown>>;
  globals: Array<Record<string, unknown>>;
  directionalTaskMaps: Array<Record<string, unknown>>;
  signalToTaskMaps: Array<Record<string, unknown>>;
  intentToTaskMaps: Array<Record<string, unknown>>;
  actorTaskMaps: Array<Record<string, unknown>>;
  taskToRoutineMaps: Array<Record<string, unknown>>;
  taskToHelperMaps: Array<Record<string, unknown>>;
  helperToHelperMaps: Array<Record<string, unknown>>;
  taskToGlobalMaps: Array<Record<string, unknown>>;
  helperToGlobalMaps: Array<Record<string, unknown>>;
};

function emitManifestStructuralProjectionRequests(
  emit: (signal: string, ctx: Record<string, unknown>) => void,
  input: {
    serviceManifests: Array<Record<string, unknown>>;
    serviceName?: string | null;
  },
): ProjectedManifestStructuralRows {
  const projectedRows = collectProjectedManifestStructuralRowsFromManifestRows(input);
  const associationPayload = buildManifestAssociationProjectionPayload({
    serviceName: input.serviceName,
    projectedRows,
  });
  const projectionKey = readString(associationPayload.__manifestProjectionKey);
  const queuedAssociationProjection =
    queueManifestAssociationProjection(associationPayload);
  const hasEntityRows =
    projectedRows.tasks.length > 0 ||
    projectedRows.signals.length > 0 ||
    projectedRows.intents.length > 0 ||
    projectedRows.actors.length > 0 ||
    projectedRows.routines.length > 0 ||
    projectedRows.helpers.length > 0 ||
    projectedRows.globals.length > 0;

  logLocalSyncDebug("manifest_structural_projection_requested", {
    serviceName: input.serviceName ?? null,
    taskCount: projectedRows.tasks.length,
    signalCount: projectedRows.signals.length,
    intentCount: projectedRows.intents.length,
    actorCount: projectedRows.actors.length,
    routineCount: projectedRows.routines.length,
    helperCount: projectedRows.helpers.length,
    globalCount: projectedRows.globals.length,
    directionalTaskMapCount: projectedRows.directionalTaskMaps.length,
    signalToTaskMapCount: projectedRows.signalToTaskMaps.length,
    intentToTaskMapCount: projectedRows.intentToTaskMaps.length,
    actorTaskMapCount: projectedRows.actorTaskMaps.length,
    taskToRoutineMapCount: projectedRows.taskToRoutineMaps.length,
    taskToHelperMapCount: projectedRows.taskToHelperMaps.length,
    helperToHelperMapCount: projectedRows.helperToHelperMaps.length,
    taskToGlobalMapCount: projectedRows.taskToGlobalMaps.length,
    helperToGlobalMapCount: projectedRows.helperToGlobalMaps.length,
    queuedAssociationProjection,
  });

  emit(META_MANIFEST_ENTITY_PROJECTION_REQUESTED, {
    __projectedTasks: projectedRows.tasks,
    __projectedSignals: projectedRows.signals,
    __projectedIntents: projectedRows.intents,
    __projectedActors: projectedRows.actors,
    __projectedRoutines: projectedRows.routines,
    __projectedHelpers: projectedRows.helpers,
    __projectedGlobals: projectedRows.globals,
    ...associationPayload,
  });

  if (queuedAssociationProjection && !hasEntityRows) {
    flushPendingManifestAssociationProjections(projectionKey);
  }

  if (!input.serviceName && queuedAssociationProjection && hasEntityRows) {
    for (const delayMs of MANIFEST_ASSOCIATION_REPLAY_FLUSH_DELAYS_MS) {
      scheduleLocalEnsureRetry(() => {
        const flushed = flushReadyManifestAssociationProjections(projectionKey);
        logLocalSyncDebug("manifest_association_replay_flush_attempt", {
          projectionKey,
          delayMs,
          flushed,
          blockedByPendingEntities:
            manifestAssociationProjectionAccumulator.get(projectionKey)
              ?.pendingEntityKinds.size ?? 0,
        });
      }, delayMs);
    }
  }

  return projectedRows;
}

export function collectProjectedManifestStructuralRowsFromManifestRows(input: {
  serviceManifests: Array<Record<string, unknown>>;
  serviceName?: string | null;
}): ProjectedManifestStructuralRows {
  const targetServiceName =
    typeof input.serviceName === "string" ? input.serviceName.trim() : "";
  const snapshots = normalizeRowArray(input.serviceManifests)
    .map((row) =>
      normalizeServiceManifestSnapshot(
        row.manifest && typeof row.manifest === "object" ? row.manifest : row,
      ),
    )
    .filter((snapshot): snapshot is NonNullable<typeof snapshot> => !!snapshot);

  const latestSnapshots = selectLatestServiceManifestSnapshots(snapshots).filter(
    (snapshot) =>
      targetServiceName.length === 0 || snapshot.serviceName === targetServiceName,
  );
  const latestSnapshotsByService = new Map<
    string,
    (typeof latestSnapshots)[number]
  >();

  for (const snapshot of latestSnapshots) {
    const current = latestSnapshotsByService.get(snapshot.serviceName);
    if (!current) {
      latestSnapshotsByService.set(snapshot.serviceName, snapshot);
      continue;
    }

    if (snapshot.revision > current.revision) {
      latestSnapshotsByService.set(snapshot.serviceName, snapshot);
      continue;
    }

    if (
      snapshot.revision === current.revision &&
      snapshot.publishedAt.localeCompare(current.publishedAt) > 0
    ) {
      latestSnapshotsByService.set(snapshot.serviceName, snapshot);
    }
  }

  const exploded = explodeServiceManifestSnapshots(
    Array.from(latestSnapshotsByService.values()).sort((left, right) =>
      left.serviceName.localeCompare(right.serviceName),
    ),
  ) as Record<string, Array<Record<string, unknown>>>;

  return {
    tasks: (exploded.tasks ?? []).map((row) =>
      pickManifestTaskProjectionRow(row),
    ),
    signals: (exploded.signals ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    intents: (exploded.intents ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    actors: (exploded.actors ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    routines: (exploded.routines ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    helpers: (exploded.helpers ?? []).map((row) =>
      pickManifestHelperProjectionRow(row),
    ),
    globals: (exploded.globals ?? []).map((row) =>
      pickManifestGlobalProjectionRow(row),
    ),
    directionalTaskMaps: (exploded.directionalTaskMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    signalToTaskMaps: (exploded.signalToTaskMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    intentToTaskMaps: (exploded.intentToTaskMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    actorTaskMaps: (exploded.actorTaskMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    taskToRoutineMaps: (exploded.taskToRoutineMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    taskToHelperMaps: (exploded.taskToHelperMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    helperToHelperMaps: (exploded.helperToHelperMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    taskToGlobalMaps: (exploded.taskToGlobalMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
    helperToGlobalMaps: (exploded.helperToGlobalMaps ?? []).map((row) => ({
      ...row,
      deleted: false,
    })),
  };
}

function buildManifestAssociationProjectionPayload(input: {
  serviceName?: string | null;
  projectedRows: ProjectedManifestStructuralRows;
}) {
  const serviceName =
    typeof input.serviceName === "string" ? input.serviceName.trim() : "";
  const projectionKey = buildManifestAssociationProjectionKey({
    serviceName,
    __projectedServiceName: serviceName || undefined,
  });

  return {
    serviceName: serviceName || null,
    __projectedServiceName: serviceName || undefined,
    __manifestProjectionKey: projectionKey,
    __projectedDirectionalTaskMaps: input.projectedRows.directionalTaskMaps,
    __projectedSignalToTaskMaps: input.projectedRows.signalToTaskMaps,
    __projectedIntentToTaskMaps: input.projectedRows.intentToTaskMaps,
    __projectedActorTaskMaps: input.projectedRows.actorTaskMaps,
    __projectedTaskToRoutineMaps: input.projectedRows.taskToRoutineMaps,
    __projectedTaskToHelperMaps: input.projectedRows.taskToHelperMaps,
    __projectedHelperToHelperMaps: input.projectedRows.helperToHelperMaps,
    __projectedTaskToGlobalMaps: input.projectedRows.taskToGlobalMaps,
    __projectedHelperToGlobalMaps: input.projectedRows.helperToGlobalMaps,
  } satisfies Record<string, unknown>;
}

function resolveServiceInstanceTransportTriggerDescriptor(ctx: any): {
  transportId: string;
  serviceInstanceId: string;
  role: ServiceTransportRole | null;
  origin: string;
  deleted: boolean;
} | null {
  const data = readRecord(ctx?.data);
  const filter = readRecord(ctx?.queryData?.filter) ?? readRecord(ctx?.filter);
  const transportId = readString(
    data?.uuid ?? filter?.uuid ?? ctx?.uuid ?? ctx?.__transportId,
  );
  const serviceInstanceId = readString(
    data?.service_instance_id ??
      data?.serviceInstanceId ??
      ctx?.service_instance_id ??
      ctx?.serviceInstanceId ??
      ctx?.__serviceInstanceId,
  );
  const roleValue = readString(data?.role ?? ctx?.role);
  const origin = readString(data?.origin ?? ctx?.origin);
  const deleted = readBoolean(data?.deleted ?? ctx?.deleted);
  const role =
    roleValue === "internal" || roleValue === "public"
      ? (roleValue as ServiceTransportRole)
      : null;

  if (!isPersistedUuid(transportId)) {
    return null;
  }

  return {
    transportId,
    serviceInstanceId,
    role,
    origin,
    deleted,
  };
}

function buildInsertTriggerWithOnConflictDoNothing(
  signal: string,
  target: string[],
) {
  return {
    signal,
    queryData: {
      onConflict: {
        target,
        action: {
          do: "nothing" as const,
        },
      },
    },
  };
}

export function resolveLocalServiceRegistrySyncTasks() {
  const queryServiceInstanceTask = resolveLocalSyncQueryTask("service_instance");
  const queryServiceInstanceLeaseTask = resolveLocalSyncQueryTask(
    "service_instance_lease",
  );
  const queryServiceInstanceTransportTask = resolveLocalSyncQueryTask(
    "service_instance_transport",
  );
  const queryServiceManifestTask = resolveLocalSyncQueryTask("service_manifest");

  if (
    !queryServiceInstanceTask ||
    !queryServiceInstanceTransportTask ||
    !queryServiceManifestTask
  ) {
    throw new Error(
      "CadenzaDB local sync query tasks are not available. Expected generated local query tasks for service_instance, service_instance_transport, and service_manifest.",
    );
  }

  return {
    queryServiceInstanceTask,
    queryServiceInstanceLeaseTask,
    queryServiceInstanceTransportTask,
    queryServiceManifestTask,
  };
}

function normalizeServiceInstanceLeaseStatus(
  value: unknown,
): "active" | "non_responsive" | "inactive" | "deleted" | null {
  const status = readString(value);
  if (
    status === "active" ||
    status === "non_responsive" ||
    status === "inactive" ||
    status === "deleted"
  ) {
    return status;
  }

  return null;
}

function overlayServiceInstanceRowsWithLeases(
  serviceInstanceRows: Array<Record<string, unknown>>,
  serviceInstanceLeaseRows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (serviceInstanceLeaseRows.length === 0) {
    return serviceInstanceRows;
  }

  const leasesByInstanceId = new Map<string, Record<string, unknown>>();
  for (const row of serviceInstanceLeaseRows) {
    const serviceInstanceId = readString(
      row.service_instance_id ?? row.serviceInstanceId,
    );
    if (!serviceInstanceId) {
      continue;
    }

    leasesByInstanceId.set(serviceInstanceId, row);
  }

  return serviceInstanceRows.map((row) => {
    const serviceInstanceId = readString(row.uuid);
    const leaseRow = serviceInstanceId
      ? leasesByInstanceId.get(serviceInstanceId)
      : undefined;
    if (!leaseRow) {
      return row;
    }

    const leaseStatus = normalizeServiceInstanceLeaseStatus(
      leaseRow.status ?? leaseRow.lease_status ?? leaseRow.leaseStatus,
    );

    return {
      ...row,
      lease_status: leaseStatus ?? undefined,
      is_ready: readBoolean(leaseRow.is_ready ?? leaseRow.isReady),
      readiness_reason:
        readString(
          leaseRow.readiness_reason ?? leaseRow.readinessReason,
        ) || null,
      lease_expires_at:
        readString(
          leaseRow.lease_expires_at ?? leaseRow.leaseExpiresAt,
        ) || null,
      last_lease_renewed_at:
        readString(
          leaseRow.last_lease_renewed_at ?? leaseRow.lastLeaseRenewedAt,
        ) || null,
      last_ready_at:
        readString(leaseRow.last_ready_at ?? leaseRow.lastReadyAt) || null,
      last_observed_transport_at:
        readString(
          leaseRow.last_observed_transport_at ??
            leaseRow.lastObservedTransportAt,
        ) || null,
      shutdown_requested_at:
        readString(
          leaseRow.shutdown_requested_at ?? leaseRow.shutdownRequestedAt,
        ) || null,
      is_active:
        leaseStatus === "active"
          ? true
          : leaseStatus === "non_responsive" ||
              leaseStatus === "inactive" ||
              leaseStatus === "deleted"
            ? false
            : row.is_active,
      is_non_responsive:
        leaseStatus === "non_responsive"
          ? true
          : leaseStatus === "active" ||
              leaseStatus === "inactive" ||
              leaseStatus === "deleted"
            ? false
            : row.is_non_responsive,
      deleted:
        leaseStatus === "deleted"
          ? true
          : Boolean(row.deleted ?? false),
    };
  });
}

export function buildServiceInstanceLeaseConsistencyUpdates(
  serviceInstanceRows: Array<Record<string, unknown>>,
  serviceInstanceLeaseRows: Array<Record<string, unknown>>,
  baseContext: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  if (serviceInstanceRows.length === 0 || serviceInstanceLeaseRows.length === 0) {
    return [];
  }

  const instancesById = new Map<string, Record<string, unknown>>();
  for (const row of serviceInstanceRows) {
    const serviceInstanceId = readString(row.uuid);
    if (!serviceInstanceId) {
      continue;
    }

    instancesById.set(serviceInstanceId, row);
  }

  const leaseUpdates: Array<Record<string, unknown>> = [];
  for (const leaseRow of serviceInstanceLeaseRows) {
    const serviceInstanceId = readString(
      leaseRow.service_instance_id ?? leaseRow.serviceInstanceId,
    );
    if (!serviceInstanceId) {
      continue;
    }

    const instanceRow = instancesById.get(serviceInstanceId);
    if (!instanceRow) {
      continue;
    }

    const expectedStatus = Boolean(instanceRow.deleted)
      ? "deleted"
      : Boolean(instanceRow.is_non_responsive)
        ? "non_responsive"
        : Boolean(instanceRow.is_active)
          ? "active"
          : "inactive";
    const currentStatus = normalizeServiceInstanceLeaseStatus(
      leaseRow.status ?? leaseRow.lease_status ?? leaseRow.leaseStatus,
    );
    if (
      currentStatus === expectedStatus ||
      (currentStatus === null && expectedStatus === "active") ||
      expectedStatus === "active"
    ) {
      continue;
    }

    const modifiedAt =
      readString(instanceRow.modified) ||
      readString(leaseRow.modified) ||
      new Date().toISOString();

    leaseUpdates.push({
      ...baseContext,
      filter: {
        service_instance_id: serviceInstanceId,
      },
      data: {
        status: expectedStatus,
        is_ready: false,
        readiness_reason: expectedStatus,
        lease_expires_at: modifiedAt,
        last_ready_at: null,
        deleted: expectedStatus === "deleted",
        modified: modifiedAt,
      },
      queryData: {
        filter: {
          service_instance_id: serviceInstanceId,
        },
        data: {
          status: expectedStatus,
          is_ready: false,
          readiness_reason: expectedStatus,
          lease_expires_at: modifiedAt,
          last_ready_at: null,
          deleted: expectedStatus === "deleted",
          modified: modifiedAt,
        },
      },
    });
  }

  return leaseUpdates;
}

export function buildServiceNotRespondingAuthorityUpdates(
  input: Record<string, unknown> | null | undefined,
  baseContext: Record<string, unknown> = {},
): {
  serviceInstanceUpdate: Record<string, unknown>;
  serviceInstanceLeaseUpdate: Record<string, unknown>;
} | null {
  const filter = readRecord(input?.filter) ?? readRecord(input?.queryData);
  const queryData = readRecord(input?.queryData);
  const queryFilter = readRecord(queryData?.filter);
  const data = readRecord(input?.data);
  const queryDataData = readRecord(queryData?.data);
  const serviceInstanceId = readString(
    filter?.uuid ??
      queryFilter?.uuid ??
      input?.serviceInstanceId ??
      input?.__serviceInstanceId,
  );
  if (!serviceInstanceId) {
    return null;
  }

  const modifiedAt =
    readString(
      data?.last_active ??
        queryDataData?.last_active ??
        input?.reportedAt ??
        input?.modified,
    ) || new Date().toISOString();

  const serviceInstanceUpdate = {
    ...baseContext,
    filter: {
      uuid: serviceInstanceId,
    },
    data: {
      is_active: false,
      is_non_responsive: true,
      deleted: false,
      last_active: modifiedAt,
      modified: modifiedAt,
    },
    queryData: {
      filter: {
        uuid: serviceInstanceId,
      },
      data: {
        is_active: false,
        is_non_responsive: true,
        deleted: false,
        last_active: modifiedAt,
        modified: modifiedAt,
      },
    },
  };

  const serviceInstanceLeaseUpdate = {
    ...baseContext,
    filter: {
      service_instance_id: serviceInstanceId,
    },
    data: {
      status: "non_responsive",
      is_ready: false,
      readiness_reason: "non_responsive",
      lease_expires_at: modifiedAt,
      last_ready_at: null,
      deleted: false,
      modified: modifiedAt,
    },
    queryData: {
      filter: {
        service_instance_id: serviceInstanceId,
      },
      data: {
        status: "non_responsive",
        is_ready: false,
        readiness_reason: "non_responsive",
        lease_expires_at: modifiedAt,
        last_ready_at: null,
        deleted: false,
        modified: modifiedAt,
      },
    },
  };

  return {
    serviceInstanceUpdate,
    serviceInstanceLeaseUpdate,
  };
}

export default class CadenzaDB {
  static createCadenzaDBService(options?: {
    dropExisting?: boolean;
    port?: number | undefined;
  }) {
    if (CREATED) {
      return;
    }

    CREATED = true;
    Cadenza.createEphemeralMetaTask("Start throttle sync", () => {
      if (LOCAL_SYNC_INITIALIZED) {
        return false;
      }

      LOCAL_SYNC_INITIALIZED = true;
      Cadenza.log("Starting throttle sync...");
      const {
        queryServiceInstanceTask,
        queryServiceInstanceLeaseTask,
        queryServiceInstanceTransportTask,
        queryServiceManifestTask,
      } = resolveLocalServiceRegistrySyncTasks();

      logLocalSyncDebug("start_throttle_sync", {
        queryServiceInstanceTask: queryServiceInstanceTask.name,
        queryServiceInstanceLeaseTask:
          queryServiceInstanceLeaseTask?.name ?? null,
        queryServiceInstanceTransportTask: queryServiceInstanceTransportTask.name,
        queryServiceManifestTask: queryServiceManifestTask.name,
      });

      Cadenza.emit("meta.sync_requested", {
        __syncing: true,
        __reason: "cadenza_db_local_sync_tasks_created",
      });
      logLocalSyncDebug("requested_follow_up_sync", {
        reason: "cadenza_db_local_sync_tasks_created",
      });

      return true;
    }).doOn("global.meta.sync_controller.synced");

    console.log("Creating CadenzaDB service");

    Cadenza.createMetaDatabaseService(
      "CadenzaDB",
      {
        version: 7,
        migrationPolicy: {
          adoptExistingVersion: 1,
          allowDestructive: true,
          transactionalMode: "per_migration",
        },
        migrations: [
          {
            version: 1,
            name: "initial-schema",
            steps: [{ kind: "sql", sql: "SELECT 1;" }],
          },
          {
            version: 2,
            name: "drop-routine-execution-routine-version",
            steps: [
              {
                kind: "dropColumn",
                table: "routine_execution",
                column: "routine_version",
                ifExists: true,
              },
            ],
          },
          {
            version: 3,
            name: "service-manifests-and-inline-task-execution-edges",
            steps: [
              {
                kind: "createTable",
                table: "service_manifest",
                definition: {
                  fields: {
                    service_instance_id: {
                      type: "uuid",
                      primary: true,
                      references: "service_instance(uuid)",
                      onDelete: "cascade",
                      required: true,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                      constraints: {
                        maxLength: 100,
                      },
                    },
                    revision: {
                      type: "int",
                      required: true,
                      default: 1,
                    },
                    manifest_hash: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: 255,
                      },
                    },
                    published_at: {
                      type: "timestamp",
                      required: true,
                      default: "now()",
                    },
                    manifest: {
                      type: "jsonb",
                      required: true,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    modified: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  indexes: [["service_name", "published_at"]],
                },
              },
              {
                kind: "dropConstraint",
                table: "signal_emission",
                name: "signal_emission_signal_name_fkey",
                ifExists: true,
              },
              {
                kind: "renameColumn",
                table: "task_execution",
                from: "previous_execution_ids",
                to: "previous_task_execution_ids",
              },
              {
                kind: "dropTable",
                table: "task_execution_map",
                ifExists: true,
                cascade: true,
              },
            ],
          },
          {
            version: 4,
            name: "drop-service-manifest-service-instance-fk",
            steps: [
              {
                kind: "dropConstraint",
                table: "service_manifest",
                name: "service_manifest_service_instance_id_fkey",
                ifExists: true,
              },
            ],
          },
          {
            version: 5,
            name: "widen-structural-name-columns",
            steps: [
              {
                kind: "sql",
                sql: `ALTER TABLE task ALTER COLUMN name TYPE VARCHAR(${STRUCTURAL_NAME_MAX_LENGTH});`,
              },
              {
                kind: "sql",
                sql: `ALTER TABLE actor ALTER COLUMN name TYPE VARCHAR(${STRUCTURAL_NAME_MAX_LENGTH});`,
              },
              {
                kind: "sql",
                sql: `ALTER TABLE routine ALTER COLUMN name TYPE VARCHAR(${STRUCTURAL_NAME_MAX_LENGTH});`,
              },
            ],
          },
          {
            version: 6,
            name: "tool-definitions-and-dependency-snapshots",
            steps: [
              {
                kind: "createTable",
                table: "helper",
                definition: {
                  fields: {
                    name: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    description: {
                      type: "text",
                      default: "",
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    is_meta: {
                      type: "boolean",
                      default: false,
                    },
                    handler_source: {
                      type: "text",
                      required: true,
                    },
                    language: {
                      type: "varchar",
                      default: "js",
                      constraints: {
                        maxLength: 16,
                      },
                    },
                    version: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: ["name", "service_name", "version"],
                  indexes: [["is_meta"]],
                },
              },
              {
                kind: "createTable",
                table: "global_registry",
                definition: {
                  fields: {
                    name: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    description: {
                      type: "text",
                      default: "",
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    is_meta: {
                      type: "boolean",
                      default: false,
                    },
                    value: {
                      type: "jsonb",
                      default: null,
                    },
                    version: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: ["name", "service_name", "version"],
                  indexes: [["is_meta"]],
                },
              },
              {
                kind: "createTable",
                table: "task_to_helper_map",
                definition: {
                  fields: {
                    task_name: {
                      type: "varchar",
                      required: true,
                    },
                    task_version: {
                      type: "int",
                      default: 1,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    alias: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    helper_name: {
                      type: "varchar",
                      required: true,
                    },
                    helper_version: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: [
                    "task_name",
                    "task_version",
                    "service_name",
                    "alias",
                    "helper_name",
                    "helper_version",
                  ],
                  foreignKeys: [
                    {
                      tableName: "task",
                      fields: ["task_name", "task_version", "service_name"],
                      referenceFields: ["name", "version", "service_name"],
                    },
                    {
                      tableName: "helper",
                      fields: ["helper_name", "helper_version", "service_name"],
                      referenceFields: ["name", "version", "service_name"],
                    },
                  ],
                },
              },
              {
                kind: "createTable",
                table: "helper_to_helper_map",
                definition: {
                  fields: {
                    helper_name: {
                      type: "varchar",
                      required: true,
                    },
                    helper_version: {
                      type: "int",
                      default: 1,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    alias: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    dependency_helper_name: {
                      type: "varchar",
                      required: true,
                    },
                    dependency_helper_version: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: [
                    "helper_name",
                    "helper_version",
                    "service_name",
                    "alias",
                    "dependency_helper_name",
                    "dependency_helper_version",
                  ],
                  foreignKeys: [
                    {
                      tableName: "helper",
                      fields: ["helper_name", "helper_version", "service_name"],
                      referenceFields: ["name", "version", "service_name"],
                    },
                    {
                      tableName: "helper",
                      fields: [
                        "dependency_helper_name",
                        "dependency_helper_version",
                        "service_name",
                      ],
                      referenceFields: ["name", "version", "service_name"],
                    },
                  ],
                },
              },
              {
                kind: "createTable",
                table: "task_to_global_map",
                definition: {
                  fields: {
                    task_name: {
                      type: "varchar",
                      required: true,
                    },
                    task_version: {
                      type: "int",
                      default: 1,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    alias: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    global_name: {
                      type: "varchar",
                      required: true,
                    },
                    global_version: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: [
                    "task_name",
                    "task_version",
                    "service_name",
                    "alias",
                    "global_name",
                    "global_version",
                  ],
                  foreignKeys: [
                    {
                      tableName: "task",
                      fields: ["task_name", "task_version", "service_name"],
                      referenceFields: ["name", "version", "service_name"],
                    },
                    {
                      tableName: "global_registry",
                      fields: ["global_name", "global_version", "service_name"],
                      referenceFields: ["name", "version", "service_name"],
                    },
                  ],
                },
              },
              {
                kind: "createTable",
                table: "helper_to_global_map",
                definition: {
                  fields: {
                    helper_name: {
                      type: "varchar",
                      required: true,
                    },
                    helper_version: {
                      type: "int",
                      default: 1,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    alias: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    global_name: {
                      type: "varchar",
                      required: true,
                    },
                    global_version: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: [
                    "helper_name",
                    "helper_version",
                    "service_name",
                    "alias",
                    "global_name",
                    "global_version",
                  ],
                  foreignKeys: [
                    {
                      tableName: "helper",
                      fields: ["helper_name", "helper_version", "service_name"],
                      referenceFields: ["name", "version", "service_name"],
                    },
                    {
                      tableName: "global_registry",
                      fields: ["global_name", "global_version", "service_name"],
                      referenceFields: ["name", "version", "service_name"],
                    },
                  ],
                },
              },
              {
                kind: "createTable",
                table: "task_tool_dependency_snapshot",
                definition: {
                  fields: {
                    task_name: {
                      type: "varchar",
                      required: true,
                    },
                    task_version: {
                      type: "int",
                      default: 1,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    alias: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    dependency_kind: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: 16,
                      },
                    },
                    dependency_name: {
                      type: "varchar",
                      required: true,
                    },
                    dependency_version: {
                      type: "int",
                      default: 1,
                    },
                    depth: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: [
                    "task_name",
                    "task_version",
                    "service_name",
                    "alias",
                    "dependency_kind",
                    "dependency_name",
                    "dependency_version",
                    "depth",
                  ],
                  indexes: [["service_name", "dependency_kind", "depth"]],
                },
              },
              {
                kind: "createTable",
                table: "helper_tool_dependency_snapshot",
                definition: {
                  fields: {
                    helper_name: {
                      type: "varchar",
                      required: true,
                    },
                    helper_version: {
                      type: "int",
                      default: 1,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                    },
                    alias: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                      },
                    },
                    dependency_kind: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: 16,
                      },
                    },
                    dependency_name: {
                      type: "varchar",
                      required: true,
                    },
                    dependency_version: {
                      type: "int",
                      default: 1,
                    },
                    depth: {
                      type: "int",
                      default: 1,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  primaryKey: [
                    "helper_name",
                    "helper_version",
                    "service_name",
                    "alias",
                    "dependency_kind",
                    "dependency_name",
                    "dependency_version",
                    "depth",
                  ],
                  indexes: [["service_name", "dependency_kind", "depth"]],
                },
              },
            ],
          },
          {
            version: 7,
            name: "service-instance-leases",
            steps: [
              {
                kind: "createTable",
                table: "service_instance_lease",
                definition: {
                  fields: {
                    service_instance_id: {
                      type: "uuid",
                      primary: true,
                      references: "service_instance(uuid)",
                      onDelete: "cascade",
                      required: true,
                    },
                    status: {
                      type: "varchar",
                      required: true,
                      default: "active",
                      constraints: {
                        oneOf: [
                          "active",
                          "non_responsive",
                          "inactive",
                          "deleted",
                        ],
                        maxLength: 32,
                      },
                    },
                    is_ready: {
                      type: "boolean",
                      default: false,
                    },
                    readiness_reason: {
                      type: "text",
                      default: null,
                    },
                    lease_expires_at: {
                      type: "timestamp",
                      default: null,
                    },
                    last_lease_renewed_at: {
                      type: "timestamp",
                      default: null,
                    },
                    last_ready_at: {
                      type: "timestamp",
                      default: null,
                    },
                    last_observed_transport_at: {
                      type: "timestamp",
                      default: null,
                    },
                    shutdown_requested_at: {
                      type: "timestamp",
                      default: null,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    modified: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  indexes: [
                    ["status", "is_ready", "lease_expires_at"],
                    ["lease_expires_at"],
                  ],
                },
              },
              {
                kind: "sql",
                sql: `
                  INSERT INTO service_instance_lease (
                    service_instance_id,
                    status,
                    is_ready,
                    readiness_reason,
                    lease_expires_at,
                    last_lease_renewed_at,
                    last_ready_at,
                    last_observed_transport_at,
                    shutdown_requested_at,
                    created,
                    modified,
                    deleted
                  )
                  SELECT
                    uuid,
                    CASE
                      WHEN deleted = true THEN 'deleted'
                      WHEN is_non_responsive = true THEN 'non_responsive'
                      WHEN is_active = true THEN 'active'
                      ELSE 'inactive'
                    END,
                    CASE
                      WHEN deleted = true OR is_blocked = true THEN false
                      WHEN is_non_responsive = true THEN false
                      WHEN is_active = true THEN true
                      ELSE false
                    END,
                    CASE
                      WHEN deleted = true THEN 'deleted'
                      WHEN is_blocked = true THEN 'blocked'
                      WHEN is_non_responsive = true THEN 'non_responsive'
                      WHEN is_active = true THEN 'accepting_work'
                      ELSE 'inactive'
                    END,
                    CASE
                      WHEN last_active IS NOT NULL THEN last_active + INTERVAL '45 seconds'
                      ELSE NULL
                    END,
                    last_active,
                    CASE
                      WHEN is_active = true AND deleted = false AND is_non_responsive = false AND is_blocked = false
                        THEN last_active
                      ELSE NULL
                    END,
                    last_active,
                    NULL,
                    created,
                    modified,
                    deleted
                  FROM service_instance
                  ON CONFLICT (service_instance_id) DO NOTHING;
                `,
              },
            ],
          },
        ],
        tables: {
          service: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 100,
                },
              },
              display_name: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [["is_meta"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "meta.create_service_requested",
                    ["name"],
                  ),
                ],
              },
            },
          },

          database_service: {
            fields: {
              id: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              schema: {
                type: "jsonb",
                required: true,
              },
              description: {
                type: "text",
                default: "",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            uniqueConstraints: [["service_name"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.created_database_service",
                    ["service_name"],
                  ),
                ],
              },
            },
          },

          generated_by_type: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            initialData: {
              fields: ["name", "description"],
              data: [
                ["user", "Task generated by a human user."],
                ["system", "Task generated by the system."],
                ["ai", "Task generated by an AI agent."],
                [
                  "auto-generated from schema",
                  "Task auto-generated from a database schema.",
                ],
                [
                  "auto-generated from UI",
                  "Task auto-generated from UI metadata.",
                ],
              ],
            },
          },

          task: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              description: {
                type: "text",
                default: "''",
              },
              function_string: {
                type: "text",
                required: true,
              },
              tag_id_getter: {
                type: "text",
                default: null,
              },
              layer_index: {
                type: "int",
                default: 0,
                required: true,
                constraints: {
                  check: "layer_index > -1",
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              timeout: {
                type: "int",
                default: 0,
              },
              is_unique: {
                type: "boolean",
                default: false,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              is_sub_meta: {
                type: "boolean",
                default: false,
              },
              is_deputy: {
                type: "boolean",
                default: false,
              },
              is_ephemeral: {
                type: "boolean",
                default: false,
              },
              is_signal: {
                type: "boolean",
                default: false,
              },
              is_throttled: {
                type: "boolean",
                default: false,
              },
              is_debounce: {
                type: "boolean",
                default: false,
              },
              is_hidden: {
                type: "boolean",
                default: false,
              },
              concurrency: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 10000,
                },
                default: 0,
              },
              retry_count: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              retry_delay: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              retry_delay_max: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              retry_delay_factor: {
                type: "decimal",
                constraints: {
                  min: 0.01,
                  max: 100.0,
                  precision: 3,
                  scale: 2,
                },
                default: 1.0,
              },
              input_context_schema: {
                type: "jsonb",
                default: null,
              },
              output_context_schema: {
                type: "jsonb",
                default: null,
              },
              validate_input_context: {
                type: "boolean",
                default: false,
              },
              validate_output_context: {
                type: "boolean",
                default: false,
              },
              signals: {
                type: "jsonb",
                default: "'{}'",
              },
              intents: {
                type: "jsonb",
                default: "'{}'",
              },
              flags: {
                type: "jsonb",
                default: "'{}'",
              },
              generated_by: {
                type: "varchar",
                default: null,
                references: "generated_by_type(name)",
                onDelete: "set default",
                constraints: {
                  maxLength: 50,
                },
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: ["name", "service_name", "version"],
            indexes: [["is_meta", "is_deputy", "generated_by"]],
          },

          actor: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              default_key: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 255,
                },
              },
              load_policy: {
                type: "varchar",
                default: "eager",
                constraints: {
                  maxLength: 25,
                },
              },
              write_contract: {
                type: "varchar",
                default: "overwrite",
                constraints: {
                  maxLength: 25,
                },
              },
              runtime_read_guard: {
                type: "varchar",
                default: "none",
                constraints: {
                  maxLength: 25,
                },
              },
              consistency_profile: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 25,
                },
              },
              key_definition: {
                type: "jsonb",
                default: null,
              },
              state_definition: {
                type: "jsonb",
                default: "'{}'",
              },
              retry_policy: {
                type: "jsonb",
                default: "'{}'",
              },
              idempotency_policy: {
                type: "jsonb",
                default: "'{}'",
              },
              session_policy: {
                type: "jsonb",
                default: "'{}'",
              },
              generated_by: {
                type: "varchar",
                default: null,
                references: "generated_by_type(name)",
                onDelete: "set default",
                constraints: {
                  maxLength: 50,
                },
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: ["name", "service_name", "version"],
            indexes: [["service_name", "is_meta"], ["generated_by"]],
          },

          actor_task_map: {
            fields: {
              actor_name: {
                type: "varchar",
                required: true,
              },
              actor_version: {
                type: "int",
                default: 1,
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              mode: {
                type: "varchar",
                default: "read",
                constraints: {
                  maxLength: 25,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "actor_name",
              "actor_version",
              "task_name",
              "task_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "actor",
                fields: ["actor_name", "service_name", "actor_version"],
                referenceFields: ["name", "service_name", "version"],
              },
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            indexes: [["service_name", "mode", "is_meta"]],
          },

          actor_session_state: {
            fields: {
              id: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              actor_name: {
                type: "varchar",
                required: true,
              },
              actor_version: {
                type: "int",
                default: 1,
              },
              actor_key: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 255,
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              durable_state: {
                type: "jsonb",
                default: "'{}'",
                required: true,
              },
              durable_version: {
                type: "int",
                default: 0,
              },
              expires_at: {
                type: "timestamp",
                default: null,
              },
              updated: {
                type: "timestamp",
                default: "now()",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            uniqueConstraints: [["actor_name", "actor_version", "actor_key", "service_name"]],
            foreignKeys: [
              {
                tableName: "actor",
                fields: ["actor_name", "service_name", "actor_version"],
                referenceFields: ["name", "service_name", "version"],
              },
            ],
            indexes: [
              ["actor_name", "actor_key", "service_name"],
              ["updated"],
              ["expires_at"],
            ],
          },

          directional_task_graph_map: {
            fields: {
              task_name: {
                type: "varchar",
                required: true,
              },
              predecessor_task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              predecessor_task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              predecessor_service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              execution_count: {
                type: "int",
                required: true,
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              last_executed: {
                type: "timestamp",
                default: null,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "task_name",
              "predecessor_task_name",
              "task_version",
              "predecessor_task_version",
              "service_name",
              "predecessor_service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "task",
                fields: [
                  "predecessor_task_name",
                  "predecessor_task_version",
                  "predecessor_service_name",
                ],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          routine: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["is_meta"]],
            primaryKey: ["name", "service_name", "version"],
          },

          task_to_routine_map: {
            fields: {
              task_name: {
                type: "varchar",
                required: true,
              },
              routine_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              routine_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "task_name",
              "routine_name",
              "task_version",
              "routine_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "routine",
                fields: ["routine_name", "routine_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          helper: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              handler_source: {
                type: "text",
                required: true,
              },
              language: {
                type: "varchar",
                default: "js",
                constraints: {
                  maxLength: 16,
                },
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: ["name", "service_name", "version"],
            indexes: [["is_meta"]],
          },

          global_registry: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              value: {
                type: "jsonb",
                default: null,
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: ["name", "service_name", "version"],
            indexes: [["is_meta"]],
          },

          task_to_helper_map: {
            fields: {
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              alias: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              helper_name: {
                type: "varchar",
                required: true,
              },
              helper_version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "task_name",
              "task_version",
              "service_name",
              "alias",
              "helper_name",
              "helper_version",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "helper",
                fields: ["helper_name", "helper_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          helper_to_helper_map: {
            fields: {
              helper_name: {
                type: "varchar",
                required: true,
              },
              helper_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              alias: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              dependency_helper_name: {
                type: "varchar",
                required: true,
              },
              dependency_helper_version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "helper_name",
              "helper_version",
              "service_name",
              "alias",
              "dependency_helper_name",
              "dependency_helper_version",
            ],
            foreignKeys: [
              {
                tableName: "helper",
                fields: ["helper_name", "helper_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "helper",
                fields: [
                  "dependency_helper_name",
                  "dependency_helper_version",
                  "service_name",
                ],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          task_to_global_map: {
            fields: {
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              alias: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              global_name: {
                type: "varchar",
                required: true,
              },
              global_version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "task_name",
              "task_version",
              "service_name",
              "alias",
              "global_name",
              "global_version",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "global_registry",
                fields: ["global_name", "global_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          helper_to_global_map: {
            fields: {
              helper_name: {
                type: "varchar",
                required: true,
              },
              helper_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              alias: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              global_name: {
                type: "varchar",
                required: true,
              },
              global_version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "helper_name",
              "helper_version",
              "service_name",
              "alias",
              "global_name",
              "global_version",
            ],
            foreignKeys: [
              {
                tableName: "helper",
                fields: ["helper_name", "helper_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "global_registry",
                fields: ["global_name", "global_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          task_tool_dependency_snapshot: {
            fields: {
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              alias: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              dependency_kind: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 16,
                },
              },
              dependency_name: {
                type: "varchar",
                required: true,
              },
              dependency_version: {
                type: "int",
                default: 1,
              },
              depth: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "task_name",
              "task_version",
              "service_name",
              "alias",
              "dependency_kind",
              "dependency_name",
              "dependency_version",
              "depth",
            ],
            indexes: [["service_name", "dependency_kind", "depth"]],
          },

          helper_tool_dependency_snapshot: {
            fields: {
              helper_name: {
                type: "varchar",
                required: true,
              },
              helper_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              alias: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: STRUCTURAL_NAME_MAX_LENGTH,
                },
              },
              dependency_kind: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 16,
                },
              },
              dependency_name: {
                type: "varchar",
                required: true,
              },
              dependency_version: {
                type: "int",
                default: 1,
              },
              depth: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "helper_name",
              "helper_version",
              "service_name",
              "alias",
              "dependency_kind",
              "dependency_name",
              "dependency_version",
              "depth",
            ],
            indexes: [["service_name", "dependency_kind", "depth"]],
          },

          field_type: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              default_constraints: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            initialData: {
              fields: ["name", "description", "default_constraints"],
              data: [
                [
                  "string",
                  "Text data type",
                  '\'{"minLength": 0, "maxLength": 255}\'::jsonb',
                ],
                [
                  "int",
                  "Integer data type",
                  '\'{"min": -2147483648, "max": 2147483647}\'::jsonb',
                ],
                ["jsonb", "JSON binary data type", "'{\"schema\": {}}'::jsonb"],
                ["boolean", "Boolean data type", "'{}'::jsonb"],
                [
                  "decimal",
                  "Decimal number data type",
                  '\'{"min": -9999999999.99, "max": 9999999999.99}\'::jsonb',
                ],
                [
                  "timestamp",
                  "Timestamp data type",
                  '\'{"min": "1970-01-01T00:00:00Z", "max": "9999-12-31T23:59:59Z"}\'::jsonb',
                ],
                ["array", "Array data type", "'{\"items\": {}}'::jsonb"],
                ["object", "Object data type", "'{\"properties\": {}}'::jsonb"],
                [
                  "uuid",
                  "UUID data type",
                  '\'{"pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"}\'::jsonb',
                ],
                [
                  "date",
                  "Date data type",
                  '\'{"min": "1970-01-01", "max": "9999-12-31"}\'::jsonb',
                ],
                [
                  "geo_point",
                  "Geospatial point data type",
                  '\'{"type": "array", "items": [{"type": "number"}, {"type": "number"}]}\'::jsonb',
                ],
                ["bytea", "Binary data type", "'{}'::jsonb"],
                ["any", "Any data type", "'{}'::jsonb"],
              ],
            },
          },

          context_schema: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              version: {
                type: "int",
                required: true,
                default: 1,
              },
              description: {
                type: "text",
                default: "",
              },
              definition: {
                type: "jsonb",
                required: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["service_name"]],
            uniqueConstraints: [["name", "version"]],
          },

          context_schema_field: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              context_schema_id: {
                type: "uuid",
                references: "context_schema(uuid)",
                onDelete: "cascade",
                required: true,
              },
              field_name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              field_type: {
                type: "varchar",
                references: "field_type(name)",
                onDelete: "set null",
                required: true,
                constraints: {
                  maxLength: 50,
                },
              },
              required: {
                type: "boolean",
                default: false,
              },
              description: {
                type: "text",
                default: "",
              },
              constraints: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            uniqueConstraints: [["context_schema_id", "field_name"]],
            indexes: [["field_type"]],
          },

          routine_execution: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              name: {
                type: "text",
                default: "",
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              meta_context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              result_context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              meta_result_context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              is_scheduled: {
                type: "boolean",
                default: true,
              },
              is_running: {
                type: "boolean",
                default: false,
              },
              is_complete: {
                type: "boolean",
                default: false,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              errored: {
                type: "boolean",
                default: false,
              },
              failed: {
                type: "boolean",
                default: false,
              },
              reached_timeout: {
                type: "boolean",
                default: false,
              },
              progress: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              started: {
                type: "timestamp",
                default: null,
              },
              ended: {
                type: "timestamp",
                default: null,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "service_instance_id",
                "service_name",
                "execution_trace_id",
                "is_meta",
                "errored",
                "failed",
                "is_running",
                "is_complete",
              ],
            ],
          },

          task_execution: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              meta_context: {
                type: "jsonb",
                default: "'{}'",
              },
              result_context: {
                type: "jsonb",
                default: "'{}'",
              },
              meta_result_context: {
                type: "jsonb",
                default: "'{}'",
              },
              split_group_id: {
                type: "uuid",
                default: null,
                description: "For grouping splits for visualization",
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                required: true,
              },
              previous_task_execution_ids: {
                type: "jsonb",
                default: "'[]'",
              },
              is_scheduled: {
                type: "boolean",
                default: true,
              },
              is_running: {
                type: "boolean",
                default: false,
              },
              is_complete: {
                type: "boolean",
                default: false,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              errored: {
                type: "boolean",
                default: false,
              },
              failed: {
                type: "boolean",
                default: false,
              },
              reached_timeout: {
                type: "boolean",
                default: false,
              },
              error_message: {
                type: "text",
                default: null,
              },
              progress: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              signal_emission_id: {
                type: "uuid",
                references: "signal_emission(uuid)",
                onDelete: "cascade",
                default: null,
              },
              inquiry_id: {
                type: "uuid",
                references: "inquiry(uuid)",
                onDelete: "cascade",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              started: {
                type: "timestamp",
                default: null,
              },
              ended: {
                type: "timestamp",
                default: null,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "routine_execution_id",
                "service_instance_id",
                "execution_trace_id",
                "is_meta",
                "errored",
                "failed",
                "is_running",
                "is_complete",
              ],
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          service_manifest: {
            fields: {
              service_instance_id: {
                type: "uuid",
                primary: true,
                required: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              revision: {
                type: "int",
                required: true,
                default: 1,
              },
              manifest_hash: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 255,
                },
              },
              published_at: {
                type: "timestamp",
                required: true,
                default: "now()",
              },
              manifest: {
                type: "jsonb",
                required: true,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["service_name", "published_at"]],
          },

          issuer_type: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            initialData: {
              fields: ["name", "description"],
              data: [
                ["browser_service", "Issuer from a browser-based service"],
                ["service", "Issuer from a Cadenza service"],
                ["ai_agent", "Issuer from an AI agent"],
                ["tool", "Issuer from a tool or automation"],
                ["dynamic_task", "Issuer from a dynamically generated task"],
              ],
            },
          },

          execution_trace: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              issuer_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                },
                references: "issuer_type(name)",
                onDelete: "restrict",
              },
              issuer_id: {
                type: "uuid",
                required: false,
                default: null,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              meta_context: {
                type: "jsonb",
                default: "'{}'",
              },
              intent: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 255,
                },
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "set null",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              issued_at: {
                type: "timestamp",
                default: "now()",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "issuer_type",
                "issuer_id",
                "service_instance_id",
                "is_meta",
                "deleted",
              ],
            ],
            meta: {
              appendOnly: true,
            },
          },

          service_instance: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              process_pid: {
                type: "int",
                required: true,
              },
              is_primary: {
                type: "boolean",
                default: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              is_database: {
                type: "boolean",
                default: false,
              },
              is_frontend: {
                type: "boolean",
                default: false,
              },
              is_blocked: {
                type: "boolean",
                default: false,
              },
              is_non_responsive: {
                type: "boolean",
                default: false,
              },
              is_active: {
                type: "boolean",
                default: true,
              },
              last_active: {
                // TODO
                type: "timestamp",
                default: null,
              },
              health: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "is_non_responsive",
                "is_active",
                "is_blocked",
                "is_primary",
                "service_name",
              ],
            ],
            customSignals: {
              triggers: {
                insert: [
                  "global.meta.service_registry.instance_registered",
                  "meta.service_registry.instance_registered",
                ],
                update: [
                  "global.meta.service_registry.service_handshake",
                  "global.meta.service_registry.service_not_responding",
                  "global.meta.sync_controller.synced",
                  "global.meta.service_registry.deleted",
                ],
              },
            },
          },

          service_instance_lease: {
            fields: {
              service_instance_id: {
                type: "uuid",
                primary: true,
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              status: {
                type: "varchar",
                required: true,
                default: "active",
                constraints: {
                  oneOf: ["active", "non_responsive", "inactive", "deleted"],
                  maxLength: 32,
                },
              },
              is_ready: {
                type: "boolean",
                default: false,
              },
              readiness_reason: {
                type: "text",
                default: null,
              },
              lease_expires_at: {
                type: "timestamp",
                default: null,
              },
              last_lease_renewed_at: {
                type: "timestamp",
                default: null,
              },
              last_ready_at: {
                type: "timestamp",
                default: null,
              },
              last_observed_transport_at: {
                type: "timestamp",
                default: null,
              },
              shutdown_requested_at: {
                type: "timestamp",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              ["status", "is_ready", "lease_expires_at"],
              ["lease_expires_at"],
            ],
          },

          service_instance_transport: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              role: {
                type: "varchar",
                required: true,
                constraints: {
                  oneOf: ["internal", "public"],
                  maxLength: 32,
                },
              },
              origin: {
                type: "text",
                required: true,
              },
              protocols: {
                type: "jsonb",
                default: "'[\"rest\",\"socket\"]'",
              },
              security_profile: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 32,
                },
              },
              auth_strategy: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 64,
                },
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["service_instance_id", "role"], ["role", "origin"]],
            uniqueConstraints: [["service_instance_id", "role", "origin"]],
            customSignals: {
              triggers: {
                insert: [
                  "global.meta.service_registry.transport_registered",
                  "meta.service_registry.transport_registered",
                ],
                update: [
                  "global.meta.service_registry.transport_updated",
                  "meta.service_registry.transport_updated",
                ],
              },
            },
          },

          service_instance_health_snapshot: {
            fields: {
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              cpu: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              memory: {
                type: "bigint",
                default: 0,
              },
              disk: {
                type: "bigint",
                default: 0,
              },
              network_io: {
                type: "bigint",
                default: 0,
              },
              gpu: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              uptime: {
                type: "bigint",
                default: 0,
              },
              latency: {
                type: "bigint",
                default: 0,
              },
              custom_metrics: {
                type: "jsonb",
                default: "'{}'",
              },
              snapshot_time: {
                type: "timestamp",
                default: "now()",
              },
            },
            primaryKey: ["service_instance_id", "snapshot_time"],
          },

          service_to_service_communication_map: {
            fields: {
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              service_instance_client_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              communication_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check: "communication_type IN ('delegation', 'signal')",
                },
              },
              last_executed: {
                // TODO
                type: "timestamp",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                // TODO
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "service_instance_id",
              "service_instance_client_id",
              "communication_type",
            ],
          },

          signal_registry: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 150,
                },
              },
              is_global: {
                type: "boolean",
                default: false,
              },
              domain: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 120,
                },
              },
              action: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 120,
                },
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              delivery_mode: {
                type: "varchar",
                default: "single",
                constraints: {
                  maxLength: 25,
                },
              },
              broadcast_filter: {
                type: "jsonb",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["is_meta", "domain", "action", "is_global"]],
          },

          signal_to_task_map: {
            fields: {
              signal_name: {
                type: "varchar",
                required: true,
              },
              is_global: {
                type: "boolean",
                default: false,
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "signal_name",
              "task_name",
              "task_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          signal_emission: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              signal_name: {
                type: "varchar",
                required: true,
              },
              signal_tag: {
                type: "varchar",
                default: null,
              },
              task_name: {
                type: "varchar",
                default: null,
              },
              task_version: {
                type: "int",
                default: null,
              },
              task_execution_id: {
                // circular reference
                // DEFERRABLE INITIALLY IMMEDIATE
                type: "uuid",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                default: null,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              metadata: {
                type: "jsonb",
                default: "'{}'",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              is_metric: {
                type: "boolean",
                default: false,
              },
              emitted_at: {
                type: "timestamp",
                default: "now()",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [
              [
                "signal_name",
                "service_name",
                "task_execution_id",
                "service_instance_id",
                "execution_trace_id",
                "is_meta",
                "emitted_at",
              ],
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            meta: {
              appendOnly: true,
            },
          },

          intent_registry: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 100,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              input: {
                type: "jsonb",
                default: '\'{"type": "object"}\'',
              },
              output: {
                type: "jsonb",
                default: '\'{"type": "object"}\'',
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["is_meta"]],
          },

          intent_to_task_map: {
            fields: {
              intent_name: {
                type: "varchar",
                required: true,
                references: "intent_registry(name)",
                onDelete: "cascade",
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "intent_name",
              "task_name",
              "task_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          inquiry: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              name: {
                type: "varchar",
                required: true,
                references: "intent_registry(name)",
                onDelete: "cascade",
              },
              task_name: {
                type: "varchar",
                default: null,
              },
              task_version: {
                type: "int",
                default: null,
              },
              task_execution_id: {
                // circular reference
                // DEFERRABLE INITIALLY IMMEDIATE
                type: "uuid",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                default: null,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              metadata: {
                type: "jsonb",
                default: "'{}'",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              sent_at: {
                type: "timestamp",
                default: "now()",
              },
              fulfilled_at: {
                type: "timestamp",
                default: null,
              },
              duration: {
                type: "int",
                default: 0,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [["is_meta", "task_execution_id"]],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          schedule_registry: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              routine_name: {
                type: "varchar",
                default: null,
              },
              task_name: {
                type: "uuid",
                default: null,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              routine_version: {
                type: "int",
                default: 1,
              },
              context_schema_id: {
                type: "uuid",
                references: "context_schema(uuid)",
                onDelete: "cascade",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              // TODO service_instance_id? we need to know the service instance to schedule on
              schedule_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check:
                    "schedule_type IN ('interval', 'delay', 'timestamp', 'custom')",
                },
              },
              schedule_data: {
                type: "jsonb",
                default: "'{}'",
              },
              is_active: {
                type: "boolean",
                default: true,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "is_meta",
                "routine_name",
                "task_name",
                "service_name",
                "schedule_type",
                "is_active",
              ],
            ],
            foreignKeys: [
              // { tableName: "task", fields: ["task_name", "task_version", "service_name"], referenceFields: ["name", "version", "service_name"] },
              // { tableName: "routine", fields: ["routine_name", "routine_version", "service_name"], referenceFields: ["name", "version", "service_name"] },
            ],
          },

          execution_tags: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              tag: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              task_execution_id: {
                type: "uuid",
                references: "task_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            uniqueConstraints: [
              ["tag", "routine_execution_id", "task_execution_id"],
            ],
            indexes: [["service_instance_id", "execution_trace_id"]],
          },

          firewall_rule: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              rule_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check:
                    "rule_type IN ('allow', 'deny', 'throttle', 'transform')",
                },
              },
              applies_to: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check: "applies_to IN ('task', 'routine', 'service')",
                },
              },
              applies_to_id: {
                type: "uuid",
                required: true,
              },
              rule: {
                type: "jsonb",
                default: "'{}'",
                constraints: {
                  check: "rule IS NULL OR jsonb_typeof(rule) = 'object'",
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "is_meta",
                "applies_to",
                "applies_to_id",
                "rule_type",
                "service_name",
              ],
            ],
          },

          system_log: {
            fields: {
              uuid: {
                type: "uuid",
                primary: true,
                default: "gen_random_uuid()",
              },
              message: {
                type: "text",
                default: "",
              },
              level: {
                type: "varchar",
                constraints: {
                  check: "level IN ('info', 'warning', 'error', 'critical')",
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              subject_service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                default: null,
              },
              subject_service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                default: null,
              },
              data: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [
              [
                "created",
                "level",
                "service_name",
                "service_instance_id",
                "subject_service_name",
                "subject_service_instance_id",
              ],
            ],
            customSignals: {
              triggers: {
                insert: ["global.meta.system_log.log"],
              },
            },
          },
        },
        meta: {
          dropExisting: options?.dropExisting ?? false,
        },
      } as any,
      "This is the official CadenzaDB database service. It is used to store metadata and execution data from the Cadenza framework.",
      {
        cadenzaDB: { connect: false },
        displayName: "Cadenza DB",
        databaseType: "postgres",
        databaseName: "cadenza_db",
        poolSize: 50,
        port: options?.port ?? parseInt(process.env.HTTP_PORT ?? "8080"),
      },
    );

    ExecutionPersistenceCoordinator.instance;
    registerAuthorityRuntimeStatusTasks();
    startRuntimeDiagnosticsLoop();
    const ensureServiceManifestAuthorityTasks = () => {
      if (Cadenza.get("Report service manifest to authority")) {
        return true;
      }

      const localServiceManifestInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_manifest");
      if (!localServiceManifestInsertTask) {
        return false;
      }

      const reportServiceManifestTask = Cadenza.createMetaTask(
        "Report service manifest to authority",
        async (ctx) => {
          const snapshot = normalizeServiceManifestSnapshot(ctx);
          if (!snapshot) {
            return false;
          }

          const parentPresence = await resolveAuthorityManifestParentPresence(
            snapshot.serviceName,
            snapshot.serviceInstanceId,
          );

          if (!parentPresence.serviceExists || !parentPresence.serviceInstanceExists) {
            Cadenza.schedule(
              META_AUTHORITY_SERVICE_MANIFEST_REPORT_RETRY_REQUESTED,
              {
                ...ctx,
                __serviceManifestRetryCount:
                  Number(ctx?.__serviceManifestRetryCount ?? 0) + 1,
              },
              250,
            );
            return {
              ...ctx,
              __serviceManifestSnapshot: snapshot,
              __serviceManifestDeferred: true,
              __serviceManifestParentPresence: parentPresence,
            };
          }

          const currentManifest = await resolveAuthorityCurrentManifestSnapshot(
            snapshot.serviceInstanceId,
          );
          const manifestUnchanged =
            currentManifest.revision === snapshot.revision &&
            currentManifest.manifestHash === snapshot.manifestHash;

          if (manifestUnchanged) {
            return {
              ...ctx,
              __serviceManifestSnapshot: snapshot,
              __serviceManifestUnchanged: true,
            };
          }

          const manifestRow = {
            service_instance_id: snapshot.serviceInstanceId,
            service_name: snapshot.serviceName,
            revision: snapshot.revision,
            manifest_hash: snapshot.manifestHash,
            published_at: snapshot.publishedAt,
            manifest: snapshot,
            modified: snapshot.publishedAt,
            deleted: false,
          };

          return {
            ...ctx,
            __serviceManifestSnapshot: snapshot,
            data: manifestRow,
            queryData: {
              data: manifestRow,
              onConflict: {
                target: ["service_instance_id"],
                action: {
                  do: "update",
                  set: {
                    service_name: "excluded",
                    revision: "excluded",
                    manifest_hash: "excluded",
                    published_at: "excluded",
                    manifest: "excluded",
                    modified: "excluded",
                    deleted: "false",
                  },
                  where: "service_manifest.revision <= excluded.revision",
                },
              },
            },
          };
        },
        "Accepts full static service-manifest snapshots from remote services and routes them into the authority manifest store.",
      )
        .respondsTo(AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT)
        .doOn(META_AUTHORITY_SERVICE_MANIFEST_REPORT_RETRY_REQUESTED);

      const finalizeServiceManifestInsertTask = Cadenza.createMetaTask(
        "Finalize service manifest insert",
        (ctx) => {
          const snapshot = resolveServiceManifestSnapshotFromContext(ctx);
          if (!snapshot) {
            return {};
          }

          if (ctx.__serviceManifestUnchanged === true) {
            return {
              applied: false,
              unchanged: true,
              serviceName: snapshot.serviceName,
              serviceInstanceId: snapshot.serviceInstanceId,
              revision: snapshot.revision,
            };
          }

          if (ctx.__serviceManifestDeferred === true) {
            return {
              applied: false,
              deferred: true,
              serviceName: snapshot.serviceName,
              serviceInstanceId: snapshot.serviceInstanceId,
              revision: snapshot.revision,
            };
          }

          scheduleAuthorityManifestProjection(snapshot);

          return {
            applied: true,
            serviceName: snapshot.serviceName,
            serviceInstanceId: snapshot.serviceInstanceId,
            revision: snapshot.revision,
          };
        },
        "Emits the manifest-derived sync payload after authority upserts a service manifest.",
        {
          isHidden: true,
        },
      );

      const prepareServiceManifestInsertTask = Cadenza.createMetaTask(
        "Prepare service manifest insert",
        (ctx) => {
          if (
            ctx?.__serviceManifestDeferred === true ||
            ctx?.__serviceManifestUnchanged === true
          ) {
            return false;
          }

          if (!ctx?.data || !ctx?.queryData) {
            return false;
          }

          return ctx;
        },
        "Prevents deferred or unchanged authority service-manifest reports from falling through into the local insert task.",
        {
          isHidden: true,
          register: false,
        },
      );

      reportServiceManifestTask.then(prepareServiceManifestInsertTask);
      prepareServiceManifestInsertTask.then(localServiceManifestInsertTask);
      localServiceManifestInsertTask.then(finalizeServiceManifestInsertTask);

      return true;
    };

    ensureServiceManifestAuthorityTasks();

    Cadenza.createMetaTask(
      "Project authority service manifest",
      (ctx, emit) => {
        const snapshot = resolveServiceManifestSnapshotFromContext(ctx);
        if (!snapshot) {
          return false;
        }

        emit(AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL, {
          serviceName: snapshot.serviceName,
          serviceInstanceId: snapshot.serviceInstanceId,
          revision: snapshot.revision,
          manifestHash: snapshot.manifestHash,
          publishedAt: snapshot.publishedAt,
        });
        emitManifestStructuralProjectionRequests(emit, {
          serviceName: snapshot.serviceName,
          serviceManifests: [
            {
              service_instance_id: snapshot.serviceInstanceId,
              service_name: snapshot.serviceName,
              revision: snapshot.revision,
              manifest_hash: snapshot.manifestHash,
              published_at: snapshot.publishedAt,
              manifest: snapshot,
            },
          ],
        });

        return {
          projected: true,
          serviceName: snapshot.serviceName,
          serviceInstanceId: snapshot.serviceInstanceId,
          revision: snapshot.revision,
        };
      },
      "Projects an acknowledged authority service-manifest snapshot into structural registry rows in a detached follow-up graph.",
      {
        isHidden: true,
        register: false,
      },
    ).doOn(META_AUTHORITY_SERVICE_MANIFEST_PROJECTION_REQUESTED);

    Cadenza.createMetaTask(
      "Ensure authority service manifest flow is registered",
      () => {
        const ensured = ensureServiceManifestAuthorityTasks();

        if (!ensured) {
          scheduleLocalEnsureRetry(ensureServiceManifestAuthorityTasks, 25);
        }

        return ensured;
      },
      "Registers the authority manifest-report responder once generated local manifest insert tasks are available.",
      {
        isHidden: true,
      },
    ).doOn(
      "meta.service_registry.instance_inserted",
      "global.meta.sync_controller.synced",
      "meta.task.created",
    );

    for (const delayMs of AUTHORITY_SERVICE_MANIFEST_ENSURE_DELAYS_MS) {
      Cadenza.schedule(
        "meta.service_registry.instance_inserted",
        {
          serviceInstance: {
            uuid: Cadenza.serviceRegistry.serviceInstanceId,
            serviceName: Cadenza.serviceRegistry.serviceName,
          },
          __reason: "authority_manifest_flow_startup_ensure",
        },
        delayMs,
      );
      scheduleLocalEnsureRetry(ensureServiceManifestAuthorityTasks, delayMs);
    }

    const ensureAuthorityManifestStructuralProjectionTasks = () => {
      if (Cadenza.get("Prepare manifest task projection insert")) {
        return true;
      }

      const localTaskInsertTask = Cadenza.getLocalCadenzaDBInsertTask("task");
      const localSignalRegistryInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("signal_registry");
      const localIntentRegistryInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("intent_registry");
      const localActorInsertTask = Cadenza.getLocalCadenzaDBInsertTask("actor");
      const localRoutineInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("routine");
      const localHelperInsertTask = Cadenza.getLocalCadenzaDBInsertTask("helper");
      const localGlobalRegistryInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("global_registry");
      const localTaskRelationshipInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("directional_task_graph_map");
      const localSignalToTaskMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("signal_to_task_map");
      const localIntentToTaskMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("intent_to_task_map");
      const localActorTaskMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("actor_task_map");
      const localTaskToRoutineMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("task_to_routine_map");
      const localTaskToHelperMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("task_to_helper_map");
      const localHelperToHelperMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("helper_to_helper_map");
      const localTaskToGlobalMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("task_to_global_map");
      const localHelperToGlobalMapInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("helper_to_global_map");
      if (
        !localTaskInsertTask ||
        !localSignalRegistryInsertTask ||
        !localIntentRegistryInsertTask ||
        !localActorInsertTask ||
        !localRoutineInsertTask ||
        !localTaskRelationshipInsertTask ||
        !localSignalToTaskMapInsertTask ||
        !localIntentToTaskMapInsertTask ||
        !localActorTaskMapInsertTask ||
        !localTaskToRoutineMapInsertTask
      ) {
        return false;
      }

      const prepareManifestTaskInsertTask = Cadenza.createMetaTask(
        "Prepare manifest task projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedTasks);
          if (rows.length === 0) {
            return false;
          }

          logLocalSyncDebug("prepared_manifest_task_projection_insert", {
            rowCount: rows.length,
          });

          return {
            ...ctx,
            __manifestEntityKind: "task",
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["name", "service_name", "version"],
                action: {
                  do: "update",
                  set: {
                    is_deputy: "excluded",
                    is_meta: "excluded",
                    description: "excluded",
                    function_string: "excluded",
                    tag_id_getter: "excluded",
                    layer_index: "excluded",
                    timeout: "excluded",
                    is_unique: "excluded",
                    is_sub_meta: "excluded",
                    is_ephemeral: "excluded",
                    is_signal: "excluded",
                    is_throttled: "excluded",
                    is_debounce: "excluded",
                    is_hidden: "excluded",
                    concurrency: "excluded",
                    generated_by: "excluded",
                    input_context_schema: "excluded",
                    output_context_schema: "excluded",
                    validate_input_context: "excluded",
                    validate_output_context: "excluded",
                    retry_count: "excluded",
                    retry_delay: "excluded",
                    retry_delay_max: "excluded",
                    retry_delay_factor: "excluded",
                    signals: "excluded",
                    intents: "excluded",
                    flags: "excluded",
                    deleted: "false",
                  },
                },
              },
            },
          };
        },
        "Builds durable task upserts from manifest-derived task rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ENTITY_PROJECTION_REQUESTED);

      const prepareManifestSignalInsertTask = Cadenza.createMetaTask(
        "Prepare manifest signal projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedSignals);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            __manifestEntityKind: "signal",
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["name"],
                action: {
                  do: "update",
                  set: {
                    is_global: "excluded",
                    domain: "excluded",
                    action: "excluded",
                    is_meta: "excluded",
                    delivery_mode: "excluded",
                    broadcast_filter: "excluded",
                    deleted: "false",
                  },
                },
              },
            },
          };
        },
        "Builds durable signal_registry upserts from manifest-derived signal rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ENTITY_PROJECTION_REQUESTED);

      const prepareManifestIntentInsertTask = Cadenza.createMetaTask(
        "Prepare manifest intent projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedIntents);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            __manifestEntityKind: "intent",
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["name"],
                action: {
                  do: "update",
                  set: {
                    description: "excluded",
                    input: "excluded",
                    output: "excluded",
                    is_meta: "excluded",
                    deleted: "false",
                  },
                },
              },
            },
          };
        },
        "Builds durable intent_registry upserts from manifest-derived intent rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ENTITY_PROJECTION_REQUESTED);

      const prepareManifestActorInsertTask = Cadenza.createMetaTask(
        "Prepare manifest actor projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedActors);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            __manifestEntityKind: "actor",
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["name", "service_name", "version"],
                action: {
                  do: "update",
                  set: {
                    description: "excluded",
                    default_key: "excluded",
                    load_policy: "excluded",
                    write_contract: "excluded",
                    runtime_read_guard: "excluded",
                    consistency_profile: "excluded",
                    key_definition: "excluded",
                    state_definition: "excluded",
                    retry_policy: "excluded",
                    idempotency_policy: "excluded",
                    session_policy: "excluded",
                    is_meta: "excluded",
                    deleted: "false",
                  },
                },
              },
            },
          };
        },
        "Builds durable actor upserts from manifest-derived actor rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ENTITY_PROJECTION_REQUESTED);

      const prepareManifestRoutineInsertTask = Cadenza.createMetaTask(
        "Prepare manifest routine projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedRoutines);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            __manifestEntityKind: "routine",
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["name", "service_name", "version"],
                action: {
                  do: "update",
                  set: {
                    description: "excluded",
                    is_meta: "excluded",
                    deleted: "false",
                  },
                },
              },
            },
          };
        },
        "Builds durable routine upserts from manifest-derived routine rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ENTITY_PROJECTION_REQUESTED);

      const prepareManifestHelperInsertTask = Cadenza.createMetaTask(
        "Prepare manifest helper projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedHelpers);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            __manifestEntityKind: "helper",
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["name", "service_name", "version"],
                action: {
                  do: "update",
                  set: {
                    description: "excluded",
                    is_meta: "excluded",
                    handler_source: "excluded",
                    language: "excluded",
                    deleted: "false",
                  },
                },
              },
            },
          };
        },
        "Builds durable helper upserts from manifest-derived helper rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ENTITY_PROJECTION_REQUESTED);

      const prepareManifestGlobalInsertTask = Cadenza.createMetaTask(
        "Prepare manifest global projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedGlobals);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            __manifestEntityKind: "global",
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["name", "service_name", "version"],
                action: {
                  do: "update",
                  set: {
                    description: "excluded",
                    is_meta: "excluded",
                    value: "excluded",
                    deleted: "false",
                  },
                },
              },
            },
          };
        },
        "Builds durable global_registry upserts from manifest-derived global rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ENTITY_PROJECTION_REQUESTED);

      const prepareManifestTaskRelationshipInsertTask = Cadenza.createMetaTask(
        "Prepare manifest task relationship projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedDirectionalTaskMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: [
                  "task_name",
                  "predecessor_task_name",
                  "task_version",
                  "predecessor_task_version",
                  "service_name",
                  "predecessor_service_name",
                ],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable directional_task_graph_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestSignalTaskMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest signal task map projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedSignalToTaskMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["signal_name", "task_name", "task_version", "service_name"],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable signal_to_task_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestIntentTaskMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest intent task map projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedIntentToTaskMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: ["intent_name", "task_name", "task_version", "service_name"],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable intent_to_task_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestActorTaskMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest actor task map projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedActorTaskMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: [
                  "actor_name",
                  "actor_version",
                  "task_name",
                  "task_version",
                  "service_name",
                ],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable actor_task_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestTaskToRoutineMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest task-to-routine projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedTaskToRoutineMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: [
                  "task_name",
                  "routine_name",
                  "task_version",
                  "routine_version",
                  "service_name",
                ],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable task_to_routine_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestTaskToHelperMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest task-to-helper projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedTaskToHelperMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: [
                  "task_name",
                  "task_version",
                  "service_name",
                  "alias",
                  "helper_name",
                  "helper_version",
                ],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable task_to_helper_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestHelperToHelperMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest helper-to-helper projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedHelperToHelperMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: [
                  "helper_name",
                  "helper_version",
                  "service_name",
                  "alias",
                  "dependency_helper_name",
                  "dependency_helper_version",
                ],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable helper_to_helper_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestTaskToGlobalMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest task-to-global projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedTaskToGlobalMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: [
                  "task_name",
                  "task_version",
                  "service_name",
                  "alias",
                  "global_name",
                  "global_version",
                ],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable task_to_global_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const prepareManifestHelperToGlobalMapInsertTask = Cadenza.createMetaTask(
        "Prepare manifest helper-to-global projection insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__projectedHelperToGlobalMaps);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: {
                target: [
                  "helper_name",
                  "helper_version",
                  "service_name",
                  "alias",
                  "global_name",
                  "global_version",
                ],
                action: {
                  do: "nothing",
                },
              },
            },
          };
        },
        "Builds durable helper_to_global_map inserts from manifest-derived structural rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_MANIFEST_ASSOCIATION_PROJECTION_REQUESTED);

      const collectManifestEntityPersistenceCompletionTask =
        Cadenza.createMetaTask(
          "Collect manifest entity persistence completion",
          (ctx) => {
            const flushed = markManifestAssociationProjectionEntityPersisted(
              readRecord(ctx),
            );
            logLocalSyncDebug("manifest_entity_persistence_completion", {
              entityKind: readString(ctx?.__manifestEntityKind) || null,
              projectionKey: readString(ctx?.__manifestProjectionKey) || null,
              flushedAssociationProjections: flushed,
            });
            return flushed > 0
              ? {
                  flushedAssociationProjections: flushed,
                }
              : false;
          },
          "Flushes queued manifest association inserts only after all projected primitive entity inserts for the same manifest batch have completed.",
          {
            register: false,
            isHidden: true,
          },
        );

      prepareManifestTaskInsertTask.then(localTaskInsertTask);
      prepareManifestSignalInsertTask.then(localSignalRegistryInsertTask);
      prepareManifestIntentInsertTask.then(localIntentRegistryInsertTask);
      prepareManifestActorInsertTask.then(localActorInsertTask);
      prepareManifestRoutineInsertTask.then(localRoutineInsertTask);
      if (localHelperInsertTask) {
        prepareManifestHelperInsertTask.then(localHelperInsertTask);
      }
      if (localGlobalRegistryInsertTask) {
        prepareManifestGlobalInsertTask.then(localGlobalRegistryInsertTask);
      }
      localTaskInsertTask.then(collectManifestEntityPersistenceCompletionTask);
      localSignalRegistryInsertTask.then(
        collectManifestEntityPersistenceCompletionTask,
      );
      localIntentRegistryInsertTask.then(
        collectManifestEntityPersistenceCompletionTask,
      );
      localActorInsertTask.then(collectManifestEntityPersistenceCompletionTask);
      localRoutineInsertTask.then(collectManifestEntityPersistenceCompletionTask);
      if (localHelperInsertTask) {
        localHelperInsertTask.then(collectManifestEntityPersistenceCompletionTask);
      }
      if (localGlobalRegistryInsertTask) {
        localGlobalRegistryInsertTask.then(
          collectManifestEntityPersistenceCompletionTask,
        );
      }
      prepareManifestTaskRelationshipInsertTask.then(
        localTaskRelationshipInsertTask,
      );
      prepareManifestSignalTaskMapInsertTask.then(localSignalToTaskMapInsertTask);
      prepareManifestIntentTaskMapInsertTask.then(localIntentToTaskMapInsertTask);
      prepareManifestActorTaskMapInsertTask.then(localActorTaskMapInsertTask);
      prepareManifestTaskToRoutineMapInsertTask.then(
        localTaskToRoutineMapInsertTask,
      );
      if (localTaskToHelperMapInsertTask) {
        prepareManifestTaskToHelperMapInsertTask.then(
          localTaskToHelperMapInsertTask,
        );
      }
      if (localHelperToHelperMapInsertTask) {
        prepareManifestHelperToHelperMapInsertTask.then(
          localHelperToHelperMapInsertTask,
        );
      }
      if (localTaskToGlobalMapInsertTask) {
        prepareManifestTaskToGlobalMapInsertTask.then(
          localTaskToGlobalMapInsertTask,
        );
      }
      if (localHelperToGlobalMapInsertTask) {
        prepareManifestHelperToGlobalMapInsertTask.then(
          localHelperToGlobalMapInsertTask,
        );
      }

      void collectManifestEntityPersistenceCompletionTask;

      logLocalSyncDebug("authority_manifest_structural_projection_registered", {
        hasLocalTaskInsertTask: !!localTaskInsertTask,
        hasLocalSignalRegistryInsertTask: !!localSignalRegistryInsertTask,
        hasLocalIntentRegistryInsertTask: !!localIntentRegistryInsertTask,
        hasLocalActorInsertTask: !!localActorInsertTask,
        hasLocalRoutineInsertTask: !!localRoutineInsertTask,
        hasLocalHelperInsertTask: !!localHelperInsertTask,
        hasLocalGlobalRegistryInsertTask: !!localGlobalRegistryInsertTask,
        hasLocalTaskRelationshipInsertTask: !!localTaskRelationshipInsertTask,
        hasLocalSignalToTaskMapInsertTask: !!localSignalToTaskMapInsertTask,
        hasLocalIntentToTaskMapInsertTask: !!localIntentToTaskMapInsertTask,
        hasLocalActorTaskMapInsertTask: !!localActorTaskMapInsertTask,
        hasLocalTaskToRoutineMapInsertTask: !!localTaskToRoutineMapInsertTask,
        hasLocalTaskToHelperMapInsertTask: !!localTaskToHelperMapInsertTask,
        hasLocalHelperToHelperMapInsertTask: !!localHelperToHelperMapInsertTask,
        hasLocalTaskToGlobalMapInsertTask: !!localTaskToGlobalMapInsertTask,
        hasLocalHelperToGlobalMapInsertTask: !!localHelperToGlobalMapInsertTask,
      });

      return true;
    };

    ensureAuthorityManifestStructuralProjectionTasks();

    Cadenza.createMetaTask(
      "Ensure authority manifest structural projection flow is registered",
      () => {
        const ensured = ensureAuthorityManifestStructuralProjectionTasks();

        if (!ensured) {
          scheduleLocalEnsureRetry(
            ensureAuthorityManifestStructuralProjectionTasks,
            25,
          );
        }

        return ensured;
      },
      "Registers manifest-derived structural projection once local manifest query and insert tasks are available.",
      {
        isHidden: true,
      },
    ).doOn(
      "meta.service_registry.instance_inserted",
      "global.meta.sync_controller.synced",
      "meta.task.created",
    );

    for (const delayMs of AUTHORITY_SERVICE_MANIFEST_ENSURE_DELAYS_MS) {
      Cadenza.schedule(
        "meta.service_registry.instance_inserted",
        {
          serviceInstance: {
            uuid: Cadenza.serviceRegistry.serviceInstanceId,
            serviceName: Cadenza.serviceRegistry.serviceName,
          },
          __reason: "authority_manifest_structural_projection_startup_ensure",
        },
        delayMs,
      );
      scheduleLocalEnsureRetry(
        ensureAuthorityManifestStructuralProjectionTasks,
        delayMs,
      );
    }

    const ensureAuthorityRegistryProjectionTasks = () => {
      if (Cadenza.get("Project persisted authority registry state")) {
        logLocalSyncDebug("authority_registry_projection_already_registered", {});
        return true;
      }

      let queryServiceInstanceTask;
      let queryServiceInstanceLeaseTask;
      let queryServiceInstanceTransportTask;
      let queryServiceManifestTask;
      try {
        ({
          queryServiceInstanceTask,
          queryServiceInstanceLeaseTask,
          queryServiceInstanceTransportTask,
          queryServiceManifestTask,
        } = resolveLocalServiceRegistrySyncTasks());
      } catch {
        logLocalSyncDebug("authority_registry_projection_tasks_unavailable", {
          hasQueryServiceInstanceTask: !!resolveLocalSyncQueryTask("service_instance"),
          hasQueryServiceInstanceLeaseTask: !!resolveLocalSyncQueryTask(
            "service_instance_lease",
          ),
          hasQueryServiceInstanceTransportTask: !!resolveLocalSyncQueryTask(
            "service_instance_transport",
          ),
          hasQueryServiceManifestTask: !!resolveLocalSyncQueryTask("service_manifest"),
        });
        return false;
      }

      const normalizeProjectedServiceInstancesTask = Cadenza.createMetaTask(
        "Normalize projected authority service instances",
        (ctx) => {
          const projectionId = resolveAuthorityRegistryProjectionId(ctx, {
            consumePending: false,
          });
          const serviceInstances = normalizeRowArray(
            ctx.rows ?? ctx.serviceInstances,
          );
          logLocalSyncDebug("normalized_authority_service_instances", {
            rowCount: serviceInstances.length,
            projectionId,
          });
          return {
            ...ctx,
            ...(projectionId
              ? { __projectionId: projectionId, projectionId }
              : {}),
            serviceInstances,
          };
        },
        "Normalizes persisted service-instance query rows for authority runtime projection.",
        {
          register: false,
          isHidden: true,
        },
      );

      const normalizeProjectedServiceInstanceTransportsTask = Cadenza.createMetaTask(
        "Normalize projected authority service instance transports",
        (ctx) => {
          const projectionId = resolveAuthorityRegistryProjectionId(ctx, {
            consumePending: false,
          });
          const serviceInstanceTransports = normalizeRowArray(
            ctx.rows ?? ctx.serviceInstanceTransports,
          );
          logLocalSyncDebug("normalized_authority_service_instance_transports", {
            rowCount: serviceInstanceTransports.length,
            projectionId,
          });
          return {
            ...ctx,
            ...(projectionId
              ? { __projectionId: projectionId, projectionId }
              : {}),
            serviceInstanceTransports,
          };
        },
        "Normalizes persisted service-instance transport query rows for authority runtime projection.",
        {
          register: false,
          isHidden: true,
        },
      );

      const normalizeProjectedServiceInstanceLeasesTask = Cadenza.createMetaTask(
        "Normalize projected authority service instance leases",
        (ctx) => {
          const projectionId = resolveAuthorityRegistryProjectionId(ctx, {
            consumePending: false,
          });
          const serviceInstanceLeases = normalizeRowArray(
            ctx.rows ?? ctx.serviceInstanceLeases,
          );
          logLocalSyncDebug("normalized_authority_service_instance_leases", {
            rowCount: serviceInstanceLeases.length,
            projectionId,
          });
          return {
            ...ctx,
            ...(projectionId
              ? { __projectionId: projectionId, projectionId }
              : {}),
            serviceInstanceLeases,
          };
        },
        "Normalizes persisted service-instance lease query rows for authority runtime projection.",
        {
          register: false,
          isHidden: true,
        },
      );

      const normalizeProjectedServiceManifestsTask = Cadenza.createMetaTask(
        "Normalize projected authority service manifests",
        (ctx) => {
          const projectionId = resolveAuthorityRegistryProjectionId(ctx, {
            consumePending: false,
          });
          const serviceManifests = normalizeRowArray(
            ctx.rows ?? ctx.serviceManifests,
          );
          logLocalSyncDebug("normalized_authority_service_manifests", {
            rowCount: serviceManifests.length,
            projectionId,
          });
          return {
            ...ctx,
            ...(projectionId
              ? { __projectionId: projectionId, projectionId }
              : {}),
            serviceManifests,
          };
        },
        "Normalizes persisted service-manifest query rows for authority runtime projection.",
        {
          register: false,
          isHidden: true,
        },
      );

      const requestAuthorityRegistryProjectionTask = Cadenza.createMetaTask(
        "Request authority registry projection replay",
        (ctx) => {
          const reason =
            readString(ctx?.__reason) ||
            readString(ctx?.signal) ||
            "authority_registry_projection";
          const projectionId = `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;
          registerPendingAuthorityRegistryProjectionId(projectionId);
          logLocalSyncDebug("authority_registry_projection_requested", {
            reason,
            projectionId,
          });
          return {
            ...ctx,
            requested: true,
            reason,
            projectionId,
            __reason: reason,
            __projectionId: projectionId,
          };
        },
        "Requests a replay of persisted authority registry rows into runtime state.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(
        "global.meta.sync_controller.synced",
        META_AUTHORITY_REGISTRY_PROJECTION_REQUESTED,
      );

      const executeAuthorityRegistryProjectionTask = Cadenza.createMetaTask(
        "Execute authority registry projection replay",
        (ctx) => {
          const projectionId = resolveAuthorityRegistryProjectionId(ctx);
          const reason =
            readString(ctx?.__reason ?? ctx?.reason) || null;
          logLocalSyncDebug("authority_registry_projection_execute", {
            reason,
            projectionId,
          });
          return {
            ...ctx,
            ...(projectionId
              ? { __projectionId: projectionId, projectionId }
              : {}),
            ...(reason ? { __reason: reason, reason } : {}),
          };
        },
        "Executes the persisted authority registry replay fan-out/fan-in graph.",
        {
          register: false,
          isHidden: true,
          isUnique: true,
        },
      );

      const collectAuthorityRegistryProjectionTask = Cadenza.createMetaTask(
        "Collect authority registry projection replay",
        (ctx) => {
          const projectionId =
            resolveAuthorityRegistryProjectionId(ctx, {
              consumePending: false,
            }) || "authority-registry-projection";

          const now = Date.now();
          pruneAuthorityRegistryProjectionAccumulator(now);

          const entry = authorityRegistryProjectionAccumulator.get(projectionId) ?? {
            updatedAt: now,
          };

          if (Array.isArray(ctx?.serviceInstances)) {
            entry.serviceInstances = normalizeRowArray(ctx.serviceInstances);
          }
          if (Array.isArray(ctx?.serviceInstanceLeases)) {
            entry.serviceInstanceLeases = normalizeRowArray(
              ctx.serviceInstanceLeases,
            );
          }
          if (Array.isArray(ctx?.serviceInstanceTransports)) {
            entry.serviceInstanceTransports = normalizeRowArray(
              ctx.serviceInstanceTransports,
            );
          }
          if (Array.isArray(ctx?.serviceManifests)) {
            entry.serviceManifests = normalizeRowArray(ctx.serviceManifests);
          }

          entry.updatedAt = now;
          authorityRegistryProjectionAccumulator.set(projectionId, entry);

          if (
            !entry.serviceInstances ||
            !entry.serviceInstanceTransports ||
            !entry.serviceManifests
          ) {
            logLocalSyncDebug("authority_registry_projection_waiting_for_branches", {
              projectionId,
              hasServiceInstances: !!entry.serviceInstances,
              hasServiceInstanceLeases:
                queryServiceInstanceLeaseTask === undefined
                  ? true
                  : !!entry.serviceInstanceLeases,
              hasServiceInstanceTransports: !!entry.serviceInstanceTransports,
              hasServiceManifests: !!entry.serviceManifests,
            });
            return false;
          }

          const serviceInstanceLeases = entry.serviceInstanceLeases ?? [];

          authorityRegistryProjectionAccumulator.delete(projectionId);
          authorityRegistryProjectionPayloads.set(projectionId, {
            updatedAt: now,
            serviceInstances: entry.serviceInstances,
            serviceInstanceLeases,
            serviceInstanceTransports: entry.serviceInstanceTransports,
            serviceManifests: entry.serviceManifests,
          });
          if (activeAuthorityRegistryProjectionId === projectionId) {
            activeAuthorityRegistryProjectionId = null;
          }
          logLocalSyncDebug("authority_registry_projection_collected", {
            projectionId,
            serviceInstances: entry.serviceInstances.length,
            serviceInstanceLeases: serviceInstanceLeases.length,
            serviceInstanceTransports: entry.serviceInstanceTransports.length,
            serviceManifests: entry.serviceManifests.length,
          });

          return {
            ...ctx,
            __projectionId: projectionId,
            serviceInstances: entry.serviceInstances,
            serviceInstanceLeases,
            serviceInstanceTransports: entry.serviceInstanceTransports,
            serviceManifests: entry.serviceManifests,
          };
        },
        "Collects normalized authority registry replay branches before projecting them into runtime state.",
        {
          register: false,
          isHidden: true,
        },
      );

      const projectAuthorityRegistryStateTask = Cadenza.createMetaTask(
        "Project persisted authority registry state",
        (ctx, emit) => {
          const now = Date.now();
          pruneAuthorityRegistryProjectionPayloads(now);
          const projectionId =
            resolveAuthorityRegistryProjectionId(ctx, {
              consumePending: false,
            }) || "authority-registry-projection";
          const cachedPayload = authorityRegistryProjectionPayloads.get(projectionId);
          const serviceInstanceRows =
            normalizeRowArray(ctx.serviceInstances).length > 0
              ? normalizeRowArray(ctx.serviceInstances)
              : normalizeRowArray(cachedPayload?.serviceInstances);
          const serviceInstanceLeaseRows =
            normalizeRowArray(ctx.serviceInstanceLeases).length > 0
              ? normalizeRowArray(ctx.serviceInstanceLeases)
              : normalizeRowArray(cachedPayload?.serviceInstanceLeases);
          const transportRows =
            normalizeRowArray(ctx.serviceInstanceTransports).length > 0
              ? normalizeRowArray(ctx.serviceInstanceTransports)
              : normalizeRowArray(cachedPayload?.serviceInstanceTransports);
          const manifestRows =
            normalizeRowArray(ctx.serviceManifests).length > 0
              ? normalizeRowArray(ctx.serviceManifests)
              : normalizeRowArray(cachedPayload?.serviceManifests);
          authorityRegistryProjectionPayloads.delete(projectionId);
          const mergedServiceInstanceRows = overlayServiceInstanceRowsWithLeases(
            serviceInstanceRows,
            serviceInstanceLeaseRows,
          );
          const leaseConsistencyUpdates = buildServiceInstanceLeaseConsistencyUpdates(
            serviceInstanceRows,
            serviceInstanceLeaseRows,
            ctx,
          );
          const transportsByInstance = new Map<string, Array<Record<string, unknown>>>();

          for (const row of transportRows) {
            const serviceInstanceId = readString(
              row.service_instance_id ?? row.serviceInstanceId,
            );
            if (!serviceInstanceId) {
              continue;
            }

            const existing = transportsByInstance.get(serviceInstanceId) ?? [];
            existing.push(row);
            transportsByInstance.set(serviceInstanceId, existing);
          }

          for (const row of mergedServiceInstanceRows) {
            const uuid = readString(row.uuid);
            if (!uuid) {
              continue;
            }

            emit("global.meta.service_instance.updated", {
              serviceInstance: {
                ...row,
                transports: transportsByInstance.get(uuid) ?? [],
              },
            });
          }

          for (const row of manifestRows) {
            const snapshot = normalizeServiceManifestSnapshot(
              row.manifest && typeof row.manifest === "object" ? row.manifest : row,
            );
            if (!snapshot) {
              continue;
            }

            emit(AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL, {
              serviceName: snapshot.serviceName,
              serviceInstanceId: snapshot.serviceInstanceId,
              revision: snapshot.revision,
              manifestHash: snapshot.manifestHash,
              publishedAt: snapshot.publishedAt,
            });
          }
          emitManifestStructuralProjectionRequests(emit, {
            serviceManifests: manifestRows,
          });
          if (leaseConsistencyUpdates.length > 0) {
            emit(META_SERVICE_INSTANCE_LEASE_CONSISTENCY_UPDATES_READY, {
              ...ctx,
              __serviceInstanceLeaseConsistencyUpdates: leaseConsistencyUpdates,
            });
          }

          logLocalSyncDebug("projected_authority_registry_state", {
            serviceInstances: mergedServiceInstanceRows.length,
            serviceInstanceLeases: serviceInstanceLeaseRows.length,
            serviceInstanceTransports: transportRows.length,
            serviceManifests: manifestRows.length,
            leaseConsistencyUpdates: leaseConsistencyUpdates.length,
          });

          return {
            projectedServiceInstances: mergedServiceInstanceRows.length,
            projectedServiceInstanceLeases: serviceInstanceLeaseRows.length,
            projectedServiceInstanceTransports: transportRows.length,
            projectedServiceManifests: manifestRows.length,
            __serviceInstanceLeaseConsistencyUpdates: leaseConsistencyUpdates,
          };
        },
        "Replays persisted service registry rows into the authority runtime registry after startup.",
        {
          register: false,
          isHidden: true,
          isUnique: true,
        },
      );

      executeAuthorityRegistryProjectionTask.then(
        queryServiceInstanceTask,
        queryServiceInstanceTransportTask,
        queryServiceManifestTask,
      );
      queryServiceInstanceTask.then(normalizeProjectedServiceInstancesTask);
      if (queryServiceInstanceLeaseTask) {
        executeAuthorityRegistryProjectionTask.then(queryServiceInstanceLeaseTask);
        queryServiceInstanceLeaseTask.then(normalizeProjectedServiceInstanceLeasesTask);
      }
      queryServiceInstanceTransportTask.then(
        normalizeProjectedServiceInstanceTransportsTask,
      );
      queryServiceManifestTask.then(normalizeProjectedServiceManifestsTask);
      requestAuthorityRegistryProjectionTask.then(
        executeAuthorityRegistryProjectionTask,
      );
      normalizeProjectedServiceInstancesTask.then(
        collectAuthorityRegistryProjectionTask,
      );
      if (queryServiceInstanceLeaseTask) {
        normalizeProjectedServiceInstanceLeasesTask.then(
          collectAuthorityRegistryProjectionTask,
        );
      }
      normalizeProjectedServiceInstanceTransportsTask.then(
        collectAuthorityRegistryProjectionTask,
      );
      normalizeProjectedServiceManifestsTask.then(
        collectAuthorityRegistryProjectionTask,
      );
      collectAuthorityRegistryProjectionTask.then(projectAuthorityRegistryStateTask);

      for (const delayMs of AUTHORITY_REGISTRY_PROJECTION_STARTUP_DELAYS_MS) {
        Cadenza.schedule(
          META_AUTHORITY_REGISTRY_PROJECTION_REQUESTED,
          {
            __reason: "authority_startup_registry_projection",
          },
          delayMs,
        );
      }

      Cadenza.debounce(
        META_AUTHORITY_REGISTRY_PROJECTION_REQUESTED,
        {
          __reason: "authority_registry_projection_flow_registered",
        },
        25,
      );
      logLocalSyncDebug("authority_registry_projection_registered", {
        hasQueryServiceInstanceTask: !!queryServiceInstanceTask,
        hasQueryServiceInstanceLeaseTask: !!queryServiceInstanceLeaseTask,
        hasQueryServiceInstanceTransportTask: !!queryServiceInstanceTransportTask,
        hasQueryServiceManifestTask: !!queryServiceManifestTask,
      });

      return requestAuthorityRegistryProjectionTask;
    };

    ensureAuthorityRegistryProjectionTasks();

    Cadenza.createMetaTask(
      "Ensure authority registry projection flow is registered",
      () => {
        const ensured = ensureAuthorityRegistryProjectionTasks();

        if (!ensured) {
          scheduleLocalEnsureRetry(
            ensureAuthorityRegistryProjectionTasks,
            25,
          );
        }

        return ensured;
      },
      "Registers the authority persisted-registry projection flow once generated local query tasks are available.",
      {
        register: false,
        isHidden: true,
      },
    ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");

    for (const delayMs of AUTHORITY_REGISTRY_PROJECTION_STARTUP_DELAYS_MS) {
      scheduleLocalEnsureRetry(ensureAuthorityRegistryProjectionTasks, delayMs);
    }

    const buildOnConflictDoNothing = (target: string[]) => ({
      target,
      action: {
        do: "nothing",
      },
    });
    const buildOnConflictUpdate = (
      target: string[],
      set: Record<string, unknown>,
    ) => ({
      target,
      action: {
        do: "update",
        set,
      },
    });
    const extractToolDependencyServiceNames = (
      ctx: Record<string, unknown> | null,
    ): string[] => {
      const serviceNames = new Set<string>();
      const rowCollections = [
        normalizeRowArray(ctx?.data),
        normalizeRowArray(ctx?.rows),
        normalizeRowArray(readRecord(ctx?.queryData)?.data),
      ];

      for (const rows of rowCollections) {
        for (const row of rows) {
          const serviceName =
            readString(row.service_name) || readString(row.serviceName);
          if (serviceName) {
            serviceNames.add(serviceName);
          }
        }
      }

      const directRecords = [
        readRecord(ctx?.data),
        readRecord(ctx?.queryData),
        readRecord(readRecord(ctx?.queryData)?.data),
        ctx,
      ];

      for (const record of directRecords) {
        const serviceName =
          readString(record?.service_name) || readString(record?.serviceName);
        if (serviceName) {
          serviceNames.add(serviceName);
        }
      }

      return Array.from(serviceNames);
    };

    const localIntentRegistryInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("intent_registry");
    const localIntentToTaskMapInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("intent_to_task_map");
    const localHelperInsertTask = Cadenza.getLocalCadenzaDBInsertTask("helper");
    const localGlobalRegistryInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("global_registry");
    const localTaskToHelperMapInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("task_to_helper_map");
    const localHelperToHelperMapInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("helper_to_helper_map");
    const localTaskToGlobalMapInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("task_to_global_map");
    const localHelperToGlobalMapInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("helper_to_global_map");

    if (localIntentRegistryInsertTask && localIntentToTaskMapInsertTask) {
      const prepareIntentRegistryAssociationTask = Cadenza.createMetaTask(
        "Prepare direct intent registry insert from task-intent association",
        (ctx: any) => {
          const intentName =
            typeof ctx.data?.intentName === "string" ? ctx.data.intentName : "";

          if (!intentName) {
            return false;
          }

          const intentData = {
            name: intentName,
            isMeta:
              intentName.startsWith("meta.") ||
              intentName.startsWith("meta-") ||
              intentName.startsWith("global.meta."),
          };

          return {
            ...ctx,
            data: intentData,
            onConflict: buildOnConflictDoNothing(["name"]),
            queryData: {
              data: intentData,
              onConflict: buildOnConflictDoNothing(["name"]),
            },
            __intentMapData: ctx.data,
          };
        },
        "Builds a minimal intent_registry row from direct task-intent metadata.",
        {
          register: false,
          isHidden: true,
        },
      );

      const restoreIntentToTaskMapAssociationTask = Cadenza.createMetaTask(
        "Restore direct intent-to-task map insert payload",
        (ctx: any) => {
          const mapData = ctx.__intentMapData;
          const intentName =
            typeof mapData?.intentName === "string" ? mapData.intentName : "";
          const taskName =
            typeof mapData?.taskName === "string" ? mapData.taskName : "";
          const taskVersion = Number.isFinite(Number(mapData?.taskVersion))
            ? Number(mapData.taskVersion)
            : 1;
          const serviceName =
            typeof mapData?.serviceName === "string" ? mapData.serviceName : "";

          if (!intentName || !taskName || !serviceName) {
            return false;
          }

          const row = {
            intentName,
            taskName,
            taskVersion,
            serviceName,
          };

          return {
            ...ctx,
            data: row,
            onConflict: buildOnConflictDoNothing([
              "intent_name",
              "task_name",
              "task_version",
              "service_name",
            ]),
            queryData: {
              data: row,
              onConflict: buildOnConflictDoNothing([
                "intent_name",
                "task_name",
                "task_version",
                "service_name",
              ]),
            },
          };
        },
        "Builds direct intent_to_task_map rows from task-intent metadata.",
        {
          register: false,
          isHidden: true,
        },
      );

      prepareIntentRegistryAssociationTask
        .doOn("global.meta.graph_metadata.task_intent_associated")
        .then(localIntentRegistryInsertTask)
        .then(restoreIntentToTaskMapAssociationTask)
        .then(localIntentToTaskMapInsertTask);
    }

    if (localHelperInsertTask) {
      const prepareDirectHelperUpsertTask = Cadenza.createMetaTask(
        "Prepare direct helper upsert",
        (ctx: any) => {
          const data = readRecord(ctx?.data);
          const name = readString(data?.name);
          const serviceName = readString(data?.serviceName ?? data?.service_name);
          if (!name || !serviceName) {
            return false;
          }

          const row = {
            name,
            version: readInteger(data?.version) ?? 1,
            description: readString(data?.description),
            serviceName,
            isMeta: readBoolean(data?.isMeta ?? data?.is_meta),
            handlerSource:
              readString(data?.handlerSource) ||
              readString(data?.handler_source) ||
              readString(data?.functionString) ||
              "",
            language: readString(data?.language) || "js",
          };

          return {
            ...ctx,
            data: row,
            queryData: {
              data: row,
              onConflict: buildOnConflictUpdate(
                ["name", "service_name", "version"],
                {
                  description: "excluded",
                  is_meta: "excluded",
                  handler_source: "excluded",
                  language: "excluded",
                  deleted: "false",
                },
              ),
            },
          };
        },
        "Builds helper upserts from direct helper graph metadata.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(
        "global.meta.graph_metadata.helper_created",
        "global.meta.graph_metadata.helper_updated",
      );

      prepareDirectHelperUpsertTask.then(localHelperInsertTask);
    }

    if (localGlobalRegistryInsertTask) {
      const prepareDirectGlobalUpsertTask = Cadenza.createMetaTask(
        "Prepare direct global upsert",
        (ctx: any) => {
          const data = readRecord(ctx?.data);
          const name = readString(data?.name);
          const serviceName = readString(data?.serviceName ?? data?.service_name);
          if (!name || !serviceName) {
            return false;
          }

          const row = {
            name,
            version: readInteger(data?.version) ?? 1,
            description: readString(data?.description),
            serviceName,
            isMeta: readBoolean(data?.isMeta ?? data?.is_meta),
            value: data?.value ?? null,
          };

          return {
            ...ctx,
            data: row,
            queryData: {
              data: row,
              onConflict: buildOnConflictUpdate(
                ["name", "service_name", "version"],
                {
                  description: "excluded",
                  is_meta: "excluded",
                  value: "excluded",
                  deleted: "false",
                },
              ),
            },
          };
        },
        "Builds global_registry upserts from direct global graph metadata.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(
        "global.meta.graph_metadata.global_created",
        "global.meta.graph_metadata.global_updated",
      );

      prepareDirectGlobalUpsertTask.then(localGlobalRegistryInsertTask);
    }

    if (localTaskToHelperMapInsertTask) {
      Cadenza.createMetaTask(
        "Prepare direct task-to-helper map insert",
        (ctx: any) => {
          const data = readRecord(ctx?.data);
          const taskName = readString(data?.taskName ?? data?.task_name);
          const serviceName = readString(data?.serviceName ?? data?.service_name);
          const alias = readString(data?.alias);
          const helperName = readString(
            data?.dependencyHelperName ?? data?.helperName ?? data?.helper_name,
          );
          if (!taskName || !serviceName || !alias || !helperName) {
            return false;
          }

          const row = {
            taskName,
            taskVersion: readInteger(data?.taskVersion ?? data?.task_version) ?? 1,
            serviceName,
            alias,
            helperName,
            helperVersion:
              readInteger(
                data?.dependencyHelperVersion ?? data?.helperVersion ?? data?.helper_version,
              ) ?? 1,
          };

          return {
            ...ctx,
            data: row,
            queryData: {
              data: row,
              onConflict: buildOnConflictDoNothing([
                "task_name",
                "task_version",
                "service_name",
                "alias",
                "helper_name",
                "helper_version",
              ]),
            },
          };
        },
        "Builds task_to_helper_map rows from direct task-helper metadata.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn("global.meta.graph_metadata.task_helper_associated")
        .then(localTaskToHelperMapInsertTask);
    }

    if (localHelperToHelperMapInsertTask) {
      Cadenza.createMetaTask(
        "Prepare direct helper-to-helper map insert",
        (ctx: any) => {
          const data = readRecord(ctx?.data);
          const helperName = readString(data?.helperName ?? data?.helper_name);
          const serviceName = readString(data?.serviceName ?? data?.service_name);
          const alias = readString(data?.alias);
          const dependencyHelperName = readString(
            data?.dependencyHelperName ?? data?.dependency_helper_name,
          );
          if (!helperName || !serviceName || !alias || !dependencyHelperName) {
            return false;
          }

          const row = {
            helperName,
            helperVersion:
              readInteger(data?.helperVersion ?? data?.helper_version) ?? 1,
            serviceName,
            alias,
            dependencyHelperName,
            dependencyHelperVersion:
              readInteger(
                data?.dependencyHelperVersion ?? data?.dependency_helper_version,
              ) ?? 1,
          };

          return {
            ...ctx,
            data: row,
            queryData: {
              data: row,
              onConflict: buildOnConflictDoNothing([
                "helper_name",
                "helper_version",
                "service_name",
                "alias",
                "dependency_helper_name",
                "dependency_helper_version",
              ]),
            },
          };
        },
        "Builds helper_to_helper_map rows from direct helper-helper metadata.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn("global.meta.graph_metadata.helper_helper_associated")
        .then(localHelperToHelperMapInsertTask);
    }

    if (localTaskToGlobalMapInsertTask) {
      Cadenza.createMetaTask(
        "Prepare direct task-to-global map insert",
        (ctx: any) => {
          const data = readRecord(ctx?.data);
          const taskName = readString(data?.taskName ?? data?.task_name);
          const serviceName = readString(data?.serviceName ?? data?.service_name);
          const alias = readString(data?.alias);
          const globalName = readString(data?.globalName ?? data?.global_name);
          if (!taskName || !serviceName || !alias || !globalName) {
            return false;
          }

          const row = {
            taskName,
            taskVersion: readInteger(data?.taskVersion ?? data?.task_version) ?? 1,
            serviceName,
            alias,
            globalName,
            globalVersion:
              readInteger(data?.globalVersion ?? data?.global_version) ?? 1,
          };

          return {
            ...ctx,
            data: row,
            queryData: {
              data: row,
              onConflict: buildOnConflictDoNothing([
                "task_name",
                "task_version",
                "service_name",
                "alias",
                "global_name",
                "global_version",
              ]),
            },
          };
        },
        "Builds task_to_global_map rows from direct task-global metadata.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn("global.meta.graph_metadata.task_global_associated")
        .then(localTaskToGlobalMapInsertTask);
    }

    if (localHelperToGlobalMapInsertTask) {
      Cadenza.createMetaTask(
        "Prepare direct helper-to-global map insert",
        (ctx: any) => {
          const data = readRecord(ctx?.data);
          const helperName = readString(data?.helperName ?? data?.helper_name);
          const serviceName = readString(data?.serviceName ?? data?.service_name);
          const alias = readString(data?.alias);
          const globalName = readString(data?.globalName ?? data?.global_name);
          if (!helperName || !serviceName || !alias || !globalName) {
            return false;
          }

          const row = {
            helperName,
            helperVersion:
              readInteger(data?.helperVersion ?? data?.helper_version) ?? 1,
            serviceName,
            alias,
            globalName,
            globalVersion:
              readInteger(data?.globalVersion ?? data?.global_version) ?? 1,
          };

          return {
            ...ctx,
            data: row,
            queryData: {
              data: row,
              onConflict: buildOnConflictDoNothing([
                "helper_name",
                "helper_version",
                "service_name",
                "alias",
                "global_name",
                "global_version",
              ]),
            },
          };
        },
        "Builds helper_to_global_map rows from direct helper-global metadata.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn("global.meta.graph_metadata.helper_global_associated")
        .then(localHelperToGlobalMapInsertTask);
    }

    const ensureAuthorityToolDependencySnapshotTasks = () => {
      if (Cadenza.get("Execute tool dependency snapshot refresh")) {
        return true;
      }

      const localHelperQueryTask = Cadenza.getLocalCadenzaDBQueryTask("helper");
      const localGlobalRegistryQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("global_registry");
      const localTaskToHelperMapQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("task_to_helper_map");
      const localHelperToHelperMapQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("helper_to_helper_map");
      const localTaskToGlobalMapQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("task_to_global_map");
      const localHelperToGlobalMapQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("helper_to_global_map");
      const localTaskToolDependencySnapshotInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("task_tool_dependency_snapshot");
      const localHelperToolDependencySnapshotInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("helper_tool_dependency_snapshot");
      const localTaskToolDependencySnapshotUpdateTask = Cadenza.getLocalCadenzaDBTask(
        "task_tool_dependency_snapshot",
        "update",
      );
      const localHelperToolDependencySnapshotUpdateTask =
        Cadenza.getLocalCadenzaDBTask(
          "helper_tool_dependency_snapshot",
          "update",
        );

      if (
        !localHelperQueryTask ||
        !localGlobalRegistryQueryTask ||
        !localTaskToHelperMapQueryTask ||
        !localHelperToHelperMapQueryTask ||
        !localTaskToGlobalMapQueryTask ||
        !localHelperToGlobalMapQueryTask ||
        !localTaskToolDependencySnapshotInsertTask ||
        !localHelperToolDependencySnapshotInsertTask ||
        !localTaskToolDependencySnapshotUpdateTask ||
        !localHelperToolDependencySnapshotUpdateTask
      ) {
        return false;
      }

      const requestToolDependencySnapshotRefreshTask = Cadenza.createMetaTask(
        "Request tool dependency snapshot refresh",
        (ctx) => {
          const serviceNames = extractToolDependencyServiceNames(readRecord(ctx));
          if (serviceNames.length === 0) {
            return false;
          }

          for (const serviceName of serviceNames) {
            Cadenza.debounce(
              META_TOOL_DEPENDENCY_SNAPSHOT_REFRESH_EXECUTE,
              {
                ...ctx,
                serviceName,
              },
              TOOL_DEPENDENCY_SNAPSHOT_REFRESH_DEBOUNCE_MS,
            );
          }

          return {
            ...ctx,
            requestedServiceNames: serviceNames,
          };
        },
        "Requests a debounced rebuild of tool dependency snapshot rows for affected services.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(
        META_TOOL_DEPENDENCY_SNAPSHOT_REFRESH_REQUESTED,
        AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL,
      );

      const executeToolDependencySnapshotRefreshTask = Cadenza.createUniqueMetaTask(
        "Execute tool dependency snapshot refresh",
        (ctx) => {
          const serviceName =
            readString(ctx?.serviceName) ||
            readString(ctx?.__projectedServiceName) ||
            readString(ctx?.service_name);
          if (!serviceName) {
            return false;
          }

          return {
            ...ctx,
            serviceName,
            queryData: {
              filter: {
                service_name: serviceName,
                deleted: false,
              },
            },
          };
        },
        "Executes one service-scoped query fan-out for tool dependency snapshot rebuilds.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(META_TOOL_DEPENDENCY_SNAPSHOT_REFRESH_EXECUTE);

      const normalizeToolDependencyQueryRowsTask = Cadenza.createMetaTask(
        "Normalize tool dependency snapshot query rows",
        (ctx) => {
          const source = readString(ctx?.__toolDependencySource);
          const serviceName = readString(ctx?.serviceName);
          if (!source || !serviceName) {
            return false;
          }

          return {
            ...ctx,
            serviceName,
            [source]: normalizeRowArray(ctx?.rows),
          };
        },
        "Normalizes queried rows used to rebuild tool dependency snapshots.",
        {
          register: false,
          isHidden: true,
        },
      );

      const collectToolDependencySnapshotRowsTask = Cadenza.createUniqueMetaTask(
        "Collect tool dependency snapshot source rows",
        (ctx: any) => {
          let joinedContext: any = { ...ctx };
          for (const joined of Array.isArray(ctx.joinedContexts)
            ? ctx.joinedContexts
            : []) {
            joinedContext = {
              ...joinedContext,
              ...joined,
            };
          }

          const serviceName = readString(joinedContext.serviceName);
          if (!serviceName) {
            return false;
          }

          const snapshots = computeToolDependencySnapshotRows(
            buildToolDependencyGraph({
              taskToHelperMaps: joinedContext.taskToHelperMaps,
              helperToHelperMaps: joinedContext.helperToHelperMaps,
              taskToGlobalMaps: joinedContext.taskToGlobalMaps,
              helperToGlobalMaps: joinedContext.helperToGlobalMaps,
            }),
          );

          return {
            ...joinedContext,
            serviceName,
            __taskToolDependencySnapshotRows: snapshots.taskSnapshots,
            __helperToolDependencySnapshotRows: snapshots.helperSnapshots,
          };
        },
        "Collects queried direct edge rows and computes transitive tool dependency snapshots.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareTaskToolDependencySnapshotResetTask = Cadenza.createMetaTask(
        "Prepare task tool dependency snapshot reset",
        (ctx) => {
          const serviceName = readString(ctx?.serviceName);
          if (!serviceName) {
            return false;
          }

          return {
            ...ctx,
            data: {
              deleted: true,
            },
            queryData: {
              filter: {
                service_name: serviceName,
                deleted: false,
              },
              data: {
                deleted: true,
              },
            },
          };
        },
        "Marks existing task tool dependency snapshot rows deleted before reinserting the fresh closure.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareTaskToolDependencySnapshotInsertTask = Cadenza.createMetaTask(
        "Prepare task tool dependency snapshot insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__taskToolDependencySnapshotRows);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: buildOnConflictUpdate(
                [
                  "task_name",
                  "task_version",
                  "service_name",
                  "alias",
                  "dependency_kind",
                  "dependency_name",
                  "dependency_version",
                  "depth",
                ],
                {
                  deleted: "false",
                },
              ),
            },
          };
        },
        "Builds fresh task_tool_dependency_snapshot rows from computed closure state.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareHelperToolDependencySnapshotResetTask = Cadenza.createMetaTask(
        "Prepare helper tool dependency snapshot reset",
        (ctx) => {
          const serviceName = readString(ctx?.serviceName);
          if (!serviceName) {
            return false;
          }

          return {
            ...ctx,
            data: {
              deleted: true,
            },
            queryData: {
              filter: {
                service_name: serviceName,
                deleted: false,
              },
              data: {
                deleted: true,
              },
            },
          };
        },
        "Marks existing helper tool dependency snapshot rows deleted before reinserting the fresh closure.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareHelperToolDependencySnapshotInsertTask = Cadenza.createMetaTask(
        "Prepare helper tool dependency snapshot insert",
        (ctx) => {
          const rows = normalizeRowArray(ctx?.__helperToolDependencySnapshotRows);
          if (rows.length === 0) {
            return false;
          }

          return {
            ...ctx,
            data: rows,
            queryData: {
              data: rows,
              onConflict: buildOnConflictUpdate(
                [
                  "helper_name",
                  "helper_version",
                  "service_name",
                  "alias",
                  "dependency_kind",
                  "dependency_name",
                  "dependency_version",
                  "depth",
                ],
                {
                  deleted: "false",
                },
              ),
            },
          };
        },
        "Builds fresh helper_tool_dependency_snapshot rows from computed closure state.",
        {
          register: false,
          isHidden: true,
        },
      );

      const helperQueryForSnapshotTask = createLocalCadenzaDBQueryInquiryTask(
        "Load helper rows for tool dependency snapshot refresh",
        localHelperQueryTask,
        "Loads helper rows through the generated default database inquiry during tool dependency snapshot rebuild.",
      );
      const globalQueryForSnapshotTask = createLocalCadenzaDBQueryInquiryTask(
        "Load global rows for tool dependency snapshot refresh",
        localGlobalRegistryQueryTask,
        "Loads global_registry rows through the generated default database inquiry during tool dependency snapshot rebuild.",
      );
      const taskToHelperMapQueryForSnapshotTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load task-to-helper rows for tool dependency snapshot refresh",
          localTaskToHelperMapQueryTask,
          "Loads task_to_helper_map rows through the generated default database inquiry during tool dependency snapshot rebuild.",
        );
      const helperToHelperMapQueryForSnapshotTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load helper-to-helper rows for tool dependency snapshot refresh",
          localHelperToHelperMapQueryTask,
          "Loads helper_to_helper_map rows through the generated default database inquiry during tool dependency snapshot rebuild.",
        );
      const taskToGlobalMapQueryForSnapshotTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load task-to-global rows for tool dependency snapshot refresh",
          localTaskToGlobalMapQueryTask,
          "Loads task_to_global_map rows through the generated default database inquiry during tool dependency snapshot rebuild.",
        );
      const helperToGlobalMapQueryForSnapshotTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load helper-to-global rows for tool dependency snapshot refresh",
          localHelperToGlobalMapQueryTask,
          "Loads helper_to_global_map rows through the generated default database inquiry during tool dependency snapshot rebuild.",
        );

      const prepareHelperQueryForSnapshotTask = Cadenza.createMetaTask(
        "Prepare helper query for tool dependency snapshot refresh",
        (ctx) => ({
          ...ctx,
          __toolDependencySource: "helpers",
          queryData: {
            filter: {
              service_name: readString(ctx?.serviceName),
              deleted: false,
            },
          },
        }),
        "Loads helper rows for a service during tool dependency snapshot rebuild.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareGlobalQueryForSnapshotTask = Cadenza.createMetaTask(
        "Prepare global query for tool dependency snapshot refresh",
        (ctx) => ({
          ...ctx,
          __toolDependencySource: "globals",
          queryData: {
            filter: {
              service_name: readString(ctx?.serviceName),
              deleted: false,
            },
          },
        }),
        "Loads global_registry rows for a service during tool dependency snapshot rebuild.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareTaskToHelperMapQueryForSnapshotTask = Cadenza.createMetaTask(
        "Prepare task-to-helper query for tool dependency snapshot refresh",
        (ctx) => ({
          ...ctx,
          __toolDependencySource: "taskToHelperMaps",
          queryData: {
            filter: {
              service_name: readString(ctx?.serviceName),
              deleted: false,
            },
          },
        }),
        "Loads task_to_helper_map rows for a service during tool dependency snapshot rebuild.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareHelperToHelperMapQueryForSnapshotTask = Cadenza.createMetaTask(
        "Prepare helper-to-helper query for tool dependency snapshot refresh",
        (ctx) => ({
          ...ctx,
          __toolDependencySource: "helperToHelperMaps",
          queryData: {
            filter: {
              service_name: readString(ctx?.serviceName),
              deleted: false,
            },
          },
        }),
        "Loads helper_to_helper_map rows for a service during tool dependency snapshot rebuild.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareTaskToGlobalMapQueryForSnapshotTask = Cadenza.createMetaTask(
        "Prepare task-to-global query for tool dependency snapshot refresh",
        (ctx) => ({
          ...ctx,
          __toolDependencySource: "taskToGlobalMaps",
          queryData: {
            filter: {
              service_name: readString(ctx?.serviceName),
              deleted: false,
            },
          },
        }),
        "Loads task_to_global_map rows for a service during tool dependency snapshot rebuild.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareHelperToGlobalMapQueryForSnapshotTask = Cadenza.createMetaTask(
        "Prepare helper-to-global query for tool dependency snapshot refresh",
        (ctx) => ({
          ...ctx,
          __toolDependencySource: "helperToGlobalMaps",
          queryData: {
            filter: {
              service_name: readString(ctx?.serviceName),
              deleted: false,
            },
          },
        }),
        "Loads helper_to_global_map rows for a service during tool dependency snapshot rebuild.",
        {
          register: false,
          isHidden: true,
        },
      );

      executeToolDependencySnapshotRefreshTask.then(
        prepareHelperQueryForSnapshotTask,
        prepareGlobalQueryForSnapshotTask,
        prepareTaskToHelperMapQueryForSnapshotTask,
        prepareHelperToHelperMapQueryForSnapshotTask,
        prepareTaskToGlobalMapQueryForSnapshotTask,
        prepareHelperToGlobalMapQueryForSnapshotTask,
      );
      prepareHelperQueryForSnapshotTask.then(helperQueryForSnapshotTask);
      prepareGlobalQueryForSnapshotTask.then(globalQueryForSnapshotTask);
      prepareTaskToHelperMapQueryForSnapshotTask.then(
        taskToHelperMapQueryForSnapshotTask,
      );
      prepareHelperToHelperMapQueryForSnapshotTask.then(
        helperToHelperMapQueryForSnapshotTask,
      );
      prepareTaskToGlobalMapQueryForSnapshotTask.then(
        taskToGlobalMapQueryForSnapshotTask,
      );
      prepareHelperToGlobalMapQueryForSnapshotTask.then(
        helperToGlobalMapQueryForSnapshotTask,
      );
      helperQueryForSnapshotTask.then(normalizeToolDependencyQueryRowsTask);
      globalQueryForSnapshotTask.then(normalizeToolDependencyQueryRowsTask);
      taskToHelperMapQueryForSnapshotTask.then(normalizeToolDependencyQueryRowsTask);
      helperToHelperMapQueryForSnapshotTask.then(
        normalizeToolDependencyQueryRowsTask,
      );
      taskToGlobalMapQueryForSnapshotTask.then(normalizeToolDependencyQueryRowsTask);
      helperToGlobalMapQueryForSnapshotTask.then(
        normalizeToolDependencyQueryRowsTask,
      );
      normalizeToolDependencyQueryRowsTask.then(collectToolDependencySnapshotRowsTask);
      collectToolDependencySnapshotRowsTask.then(
        prepareTaskToolDependencySnapshotResetTask,
        prepareHelperToolDependencySnapshotResetTask,
      );
      prepareTaskToolDependencySnapshotResetTask.then(
        localTaskToolDependencySnapshotUpdateTask,
      );
      prepareHelperToolDependencySnapshotResetTask.then(
        localHelperToolDependencySnapshotUpdateTask,
      );
      localTaskToolDependencySnapshotUpdateTask.then(
        prepareTaskToolDependencySnapshotInsertTask,
      );
      localHelperToolDependencySnapshotUpdateTask.then(
        prepareHelperToolDependencySnapshotInsertTask,
      );
      prepareTaskToolDependencySnapshotInsertTask.then(
        localTaskToolDependencySnapshotInsertTask,
      );
      prepareHelperToolDependencySnapshotInsertTask.then(
        localHelperToolDependencySnapshotInsertTask,
      );

      localHelperInsertTask?.then(requestToolDependencySnapshotRefreshTask);
      localGlobalRegistryInsertTask?.then(requestToolDependencySnapshotRefreshTask);
      localTaskToHelperMapInsertTask?.then(requestToolDependencySnapshotRefreshTask);
      localHelperToHelperMapInsertTask?.then(
        requestToolDependencySnapshotRefreshTask,
      );
      localTaskToGlobalMapInsertTask?.then(requestToolDependencySnapshotRefreshTask);
      localHelperToGlobalMapInsertTask?.then(
        requestToolDependencySnapshotRefreshTask,
      );

      return true;
    };

    ensureAuthorityToolDependencySnapshotTasks();
    scheduleLocalEnsureRetry(ensureAuthorityToolDependencySnapshotTasks, 25);
    scheduleLocalEnsureRetry(ensureAuthorityToolDependencySnapshotTasks, 250);
    scheduleLocalEnsureRetry(ensureAuthorityToolDependencySnapshotTasks, 1500);

    const ensureAuthorityBootstrapRegistrationTasks = () => {
      const localServiceInstanceInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance");
      const localServiceInstanceTransportInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance_transport");
      if (
        !localServiceInstanceInsertTask ||
        !localServiceInstanceTransportInsertTask
      ) {
        return false;
      }

      if (!Cadenza.get(AUTHORITY_SERVICE_INSTANCE_REGISTER_TASK_NAME)) {
        Cadenza.createMetaTask(
          AUTHORITY_SERVICE_INSTANCE_REGISTER_TASK_NAME,
          (ctx: any) => {
            const row =
              readRecord(ctx?.queryData?.data) ?? readRecord(ctx?.data);
            if (!row) {
              return false;
            }

            return {
              ...ctx,
              data: row,
              queryData: {
                ...(readRecord(ctx?.queryData) ?? {}),
                data: row,
              },
            };
          },
          "Accepts bootstrap service_instance registrations from remote services and routes them into the authority instance store.",
        )
          .respondsTo(AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT)
          .then(localServiceInstanceInsertTask);
      }

      if (!Cadenza.get(AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_TASK_NAME)) {
        Cadenza.createMetaTask(
          AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_TASK_NAME,
          (ctx: any) => {
            const row =
              readRecord(ctx?.queryData?.data) ?? readRecord(ctx?.data);
            if (!row) {
              return false;
            }

            return {
              ...ctx,
              data: row,
              queryData: {
                ...(readRecord(ctx?.queryData) ?? {}),
                data: row,
              },
            };
          },
          "Accepts bootstrap service_instance_transport registrations from remote services and routes them into the authority transport store.",
        )
          .respondsTo(AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT)
          .then(localServiceInstanceTransportInsertTask);
      }

      return true;
    };

    ensureAuthorityBootstrapRegistrationTasks();

    Cadenza.createMetaTask(
      "Ensure authority bootstrap registration flow is registered",
      () => ensureAuthorityBootstrapRegistrationTasks(),
      "Registers the authority bootstrap registration responders once generated local service-instance insert tasks are available.",
      {
        register: false,
        isHidden: true,
      },
    ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");

    const ensureAuthorityOriginCanonicalizationTasks = () => {
      if (Cadenza.get("Execute service instance origin canonicalization sweep")) {
        return true;
      }

      const localServiceInstanceQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("service_instance");
      const localServiceInstanceLeaseQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("service_instance_lease");
      const localServiceInstanceInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance");
      const localServiceInstanceTransportInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance_transport");
      const localServiceInstanceTransportQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("service_instance_transport");
      const localServiceInstanceUpdateTask = Cadenza.getLocalCadenzaDBTask(
        "service_instance",
        "update",
      );
      const localServiceInstanceLeaseUpdateTask = Cadenza.getLocalCadenzaDBTask(
        "service_instance_lease",
        "update",
      );
      const localServiceInstanceTransportUpdateTask =
        Cadenza.getLocalCadenzaDBTask("service_instance_transport", "update");

      if (
        !localServiceInstanceQueryTask ||
        !localServiceInstanceLeaseQueryTask ||
        !localServiceInstanceInsertTask ||
        !localServiceInstanceTransportInsertTask ||
        !localServiceInstanceTransportQueryTask ||
        !localServiceInstanceUpdateTask ||
        !localServiceInstanceLeaseUpdateTask ||
        !localServiceInstanceTransportUpdateTask
      ) {
        return false;
      }

      Cadenza.createMetaTask(
        "Persist service not responding authority updates",
        (ctx: any, emit: any) => {
          const updates = buildServiceNotRespondingAuthorityUpdates(ctx);
          if (!updates) {
            return false;
          }
          const serviceInstanceId = readString(
            readRecord(updates.serviceInstanceUpdate?.filter)?.uuid,
          );

          emit("meta.service_instance.updated", updates.serviceInstanceUpdate);
          emit(
            "meta.service_instance_lease.updated",
            updates.serviceInstanceLeaseUpdate,
          );
          emit(META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE, {
            __reason: "service_not_responding",
            queryData: {
              filter: {
                uuid: serviceInstanceId,
              },
            },
          });
          return true;
        },
        "Persists nonresponsive authority state when a service instance stops responding so stale routes are excluded immediately.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn("global.meta.service_registry.service_not_responding");

      Cadenza.createMetaTask(
        "Log local service instance insert for canonicalization debug",
        (ctx: any) => {
          logCanonicalizationTrace("local_instance_insert", {
            uuid: ctx?.data?.uuid ?? ctx?.uuid ?? null,
            serviceName:
              ctx?.data?.service_name ?? ctx?.service_name ?? null,
            isActive: ctx?.data?.is_active ?? ctx?.is_active ?? null,
          });
          return ctx;
        },
        "Debug-only trace for local service_instance inserts reaching authority canonicalization wiring.",
        {
          register: false,
          isHidden: true,
        },
      ).doAfter(localServiceInstanceInsertTask);

      Cadenza.createMetaTask(
        "Log local service instance transport insert for canonicalization debug",
        (ctx: any) => {
          logCanonicalizationTrace("local_transport_insert", {
            uuid: ctx?.data?.uuid ?? ctx?.uuid ?? null,
            serviceInstanceId:
              ctx?.data?.service_instance_id ?? ctx?.service_instance_id ?? null,
            origin: ctx?.data?.origin ?? ctx?.origin ?? null,
          });
          return ctx;
        },
        "Debug-only trace for local service_instance_transport inserts reaching authority canonicalization wiring.",
        {
          register: false,
          isHidden: true,
        },
      ).doAfter(localServiceInstanceTransportInsertTask);

      const localServiceInstanceReconciliationQueryTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load service instance rows for origin reconciliation",
          localServiceInstanceQueryTask,
          "Loads service_instance rows through the generated default database inquiry for origin reconciliation.",
        );
      const localServiceInstanceTransportByInstanceQueryTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load service instance transport rows by instance",
          localServiceInstanceTransportQueryTask,
          "Loads service_instance_transport rows through the generated default database inquiry for instance-first reconciliation.",
        );
      const localServiceInstanceTransportlessInstanceQueryTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load transportless service instance candidate",
          localServiceInstanceQueryTask,
          "Loads service_instance rows through the generated default database inquiry for transportless-instance evaluation.",
        );
      const localServiceInstanceTransportLookupTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load authoritative service instance transport",
          localServiceInstanceTransportQueryTask,
          "Loads authoritative service_instance_transport rows through the generated default database inquiry for origin reconciliation.",
        );
      const localServiceInstanceTransportReconciliationQueryTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load matching service instance transports for origin reconciliation",
          localServiceInstanceTransportQueryTask,
          "Loads matching same-origin service_instance_transport rows through the generated default database inquiry for reconciliation.",
        );
      const localServiceInstanceTransportlessTransportQueryTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load transports for transportless service instance candidate",
          localServiceInstanceTransportQueryTask,
          "Loads service_instance_transport rows through the generated default database inquiry for transportless-instance evaluation.",
        );
      const localServiceInstanceOriginCanonicalizationQueryTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load service instance rows for origin canonicalization sweep",
          localServiceInstanceQueryTask,
          "Loads service_instance rows through the generated default database inquiry for origin canonicalization sweeps.",
        );
      const localServiceInstanceTransportOriginCanonicalizationQueryTask =
        createLocalCadenzaDBQueryInquiryTask(
          "Load service instance transport rows for origin canonicalization sweep",
          localServiceInstanceTransportQueryTask,
          "Loads service_instance_transport rows through the generated default database inquiry for origin canonicalization sweeps.",
        );

      const prepareOriginReconciliationLookupTask = Cadenza.createMetaTask(
        "Prepare service instance origin reconciliation lookup",
        (ctx: any) => {
          const descriptor = resolveServiceInstanceTransportTriggerDescriptor(ctx);
          if (!descriptor || descriptor.deleted) {
            return false;
          }

          return {
            ...ctx,
            __originReconciliationTrigger: descriptor,
            queryData: {
              filter: {
                uuid: descriptor.transportId,
              },
            },
          };
        },
        "Loads the authoritative transport row that triggered same-origin reconciliation.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareOriginReconciliationSeedTransportQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin reconciliation seed transport query",
          (ctx: any) => {
            const updateData =
              readRecord(ctx?.queryData?.data) ?? readRecord(ctx?.data);
            if (
              updateData &&
              (updateData.deleted === true ||
                updateData.is_active === false)
            ) {
              return false;
            }

            const instanceId = readString(
              ctx?.queryData?.data?.uuid ??
                ctx?.queryData?.filter?.uuid ??
                ctx?.data?.uuid ??
                ctx?.filter?.uuid ??
                ctx?.uuid ??
                ctx?.__serviceInstanceId,
            );
            if (!instanceId) {
              return false;
            }

            return {
              ...ctx,
              __originReconciliationAuthoritativeInstanceId: instanceId,
              queryData: {
                filter: {
                  service_instance_id: instanceId,
                  deleted: false,
                },
              },
            };
          },
          "Loads undeleted transports for an authoritative service instance so same-origin reconciliation can retry after instance-first writes.",
          {
            register: false,
            isHidden: true,
          },
        );

      const emitOriginReconciliationRequestsFromInstanceTask =
        Cadenza.createUniqueMetaTask(
          "Emit service instance origin reconciliation requests",
          (ctx: any) => {
            const authoritativeInstanceId = readString(
              ctx.__originReconciliationAuthoritativeInstanceId,
            );
            if (!authoritativeInstanceId) {
              return false;
            }

            const transports = Array.isArray(ctx.serviceInstanceTransports)
              ? ctx.serviceInstanceTransports
                  .map(normalizeServiceTransport)
                  .filter(Boolean)
              : [];

            let emitted = 0;
            for (const transport of transports) {
              if (
                !transport ||
                transport.deleted ||
                transport.serviceInstanceId !== authoritativeInstanceId
              ) {
                continue;
              }

              emitted += 1;
              Cadenza.emit(
                META_SERVICE_INSTANCE_ORIGIN_RECONCILIATION_REQUESTED,
                {
                  ...ctx,
                  data: {
                    uuid: transport.uuid,
                    service_instance_id: transport.serviceInstanceId,
                    role: transport.role,
                    origin: transport.origin,
                    deleted: transport.deleted,
                  },
                  queryData: {
                    filter: {
                      uuid: transport.uuid,
                    },
                  },
                },
              );
            }

            return emitted > 0
              ? {
                  ...ctx,
                  emittedOriginReconciliationRequests: emitted,
                }
              : false;
          },
          "Replays same-origin reconciliation from authoritative service_instance writes once their transports exist.",
          {
            register: false,
            isHidden: true,
          },
        );

      const prepareOriginReconciliationScanTask = Cadenza.createMetaTask(
        "Prepare service instance origin reconciliation scan",
        (ctx: any) => {
          const authoritativeTransport = normalizeServiceTransport(
            ctx.serviceInstanceTransports?.[0],
          );

          if (!authoritativeTransport || authoritativeTransport.deleted) {
            return false;
          }

          return {
            ...ctx,
            __originReconciliation: {
              authoritativeInstanceId: authoritativeTransport.serviceInstanceId,
              role: authoritativeTransport.role,
              origin: authoritativeTransport.origin,
            },
          };
        },
        "Captures the exact same-origin transport ownership key from the authoritative row.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareServiceInstanceReconciliationQueryTask = Cadenza.createMetaTask(
        "Prepare service instance origin reconciliation instance query",
        (ctx: any) => ({
          ...ctx,
          queryData: {
            filter: {
              deleted: false,
            },
          },
        }),
        "Loads active and inactive service_instance rows so authority can choose one same-origin owner.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareServiceTransportReconciliationQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin reconciliation transport query",
          (ctx: any) => {
            const descriptor = ctx.__originReconciliation;
            if (!descriptor?.role || !descriptor?.origin) {
              return false;
            }

            return {
              ...ctx,
              queryData: {
                filter: {
                  role: descriptor.role,
                  origin: descriptor.origin,
                  deleted: false,
                },
              },
            };
          },
          "Loads matching same-origin transports for authority duplicate reconciliation.",
          {
            register: false,
            isHidden: true,
          },
        );

      const computeOriginReconciliationPlanTask = Cadenza.createUniqueMetaTask(
        "Compute service instance origin reconciliation plan",
        (ctx: any) => {
          let joinedContext: any = { ...ctx };
          for (const joined of Array.isArray(ctx.joinedContexts)
            ? ctx.joinedContexts
            : []) {
            joinedContext = {
              ...joinedContext,
              ...joined,
            };
          }

          const descriptor = joinedContext.__originReconciliation;
          if (!descriptor?.authoritativeInstanceId || !descriptor?.role || !descriptor?.origin) {
            return false;
          }

          const serviceInstances = Array.isArray(joinedContext.serviceInstances)
            ? joinedContext.serviceInstances
                .map(normalizeServiceInstance)
                .filter(Boolean)
            : [];
          const serviceInstanceTransports = Array.isArray(
            joinedContext.serviceInstanceTransports,
          )
            ? joinedContext.serviceInstanceTransports
                .map(normalizeServiceTransport)
                .filter(Boolean)
            : [];
          const authoritativeInstance = serviceInstances.find(
            (instance: ServiceInstanceDescriptor) =>
              instance.uuid === descriptor.authoritativeInstanceId,
          );

          if (!authoritativeInstance?.serviceName) {
            return false;
          }

          const plan = planServiceInstanceOriginReconciliation({
            authoritativeInstanceId: descriptor.authoritativeInstanceId,
            serviceName: authoritativeInstance.serviceName,
            role: descriptor.role,
            origin: descriptor.origin,
            serviceInstances,
            serviceInstanceTransports,
          });

          if (
            plan.retiredInstanceIds.length === 0 &&
            plan.retiredTransportIds.length === 0
          ) {
            return false;
          }

          for (const instanceId of plan.retiredInstanceIds) {
            Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE, {
              __originReconciliationPlan: plan,
              __originReconciliation: descriptor,
              data: {
                is_active: false,
                is_non_responsive: false,
                deleted: false,
              },
              queryData: {
                filter: {
                  uuid: instanceId,
                },
              },
            });
          }

          for (const transportId of plan.retiredTransportIds) {
            Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_TRANSPORT, {
              __originReconciliationPlan: plan,
              __originReconciliation: descriptor,
              __retiredServiceInstanceIds: plan.retiredInstanceIds,
              data: {
                deleted: true,
              },
              queryData: {
                filter: {
                  uuid: transportId,
                },
              },
            });
          }

          for (const instanceId of plan.retiredInstanceIds) {
            Cadenza.emit(META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE, {
              __originReconciliationPlan: plan,
              queryData: {
                filter: {
                  uuid: instanceId,
                },
              },
            });
          }

          return {
            ...joinedContext,
            __originReconciliationPlan: plan,
          };
        },
        "Collapses duplicate same-origin service-instance ownership on authority.",
        {
          register: false,
          isHidden: true,
        },
      );

      const retireSupersededServiceInstanceTask = Cadenza.createMetaTask(
        "Retire superseded same-origin service instance",
        (ctx: any, emit: any) => {
          const instanceId = readString(ctx?.queryData?.filter?.uuid);
          if (!instanceId) {
            return false;
          }

          const retiredAt = new Date().toISOString();

          const nextFilter = {
            uuid: instanceId,
          };
          const nextData = {
            is_active: false,
            is_non_responsive: false,
            deleted: false,
          };

          emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_LEASE, {
            ...ctx,
            filter: {
              ...(ctx.filter ?? {}),
              service_instance_id: instanceId,
            },
            data: {
              status: "inactive",
              is_ready: false,
              readiness_reason: "superseded",
              lease_expires_at: retiredAt,
              last_ready_at: null,
              deleted: false,
              modified: retiredAt,
            },
            queryData: {
              ...(ctx.queryData ?? {}),
              filter: {
                service_instance_id: instanceId,
              },
              data: {
                status: "inactive",
                is_ready: false,
                readiness_reason: "superseded",
                lease_expires_at: retiredAt,
                last_ready_at: null,
                deleted: false,
                modified: retiredAt,
              },
            },
          });

          return {
            ...ctx,
            filter: {
              ...(ctx.filter ?? {}),
              ...nextFilter,
            },
            data: {
              ...(ctx.data ?? {}),
              ...nextData,
            },
            queryData: {
              ...(ctx.queryData ?? {}),
              filter: {
                ...(ctx.queryData?.filter ?? ctx.filter ?? {}),
                ...nextFilter,
              },
              data: {
                ...(ctx.queryData?.data ?? ctx.data ?? {}),
                ...nextData,
              },
            },
          };
        },
        "Marks superseded same-origin service instances inactive on authority.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE)
        .then(localServiceInstanceUpdateTask);

      Cadenza.createMetaTask(
        "Retire superseded same-origin service instance lease",
        (ctx: any) => {
          const serviceInstanceId = readString(
            ctx?.queryData?.filter?.service_instance_id ??
              ctx?.filter?.service_instance_id,
          );
          if (!serviceInstanceId) {
            return false;
          }

          const retiredAt =
            readString(ctx?.queryData?.data?.modified ?? ctx?.data?.modified) ||
            new Date().toISOString();
          const nextFilter = {
            service_instance_id: serviceInstanceId,
          };
          const nextData = {
            status: "inactive",
            is_ready: false,
            readiness_reason: "superseded",
            lease_expires_at: retiredAt,
            last_ready_at: null,
            deleted: false,
            modified: retiredAt,
          };

          return {
            ...ctx,
            filter: {
              ...(ctx.filter ?? {}),
              ...nextFilter,
            },
            data: {
              ...(ctx.data ?? {}),
              ...nextData,
            },
            queryData: {
              ...(ctx.queryData ?? {}),
              filter: {
                ...(ctx.queryData?.filter ?? ctx.filter ?? {}),
                ...nextFilter,
              },
              data: {
                ...(ctx.queryData?.data ?? ctx.data ?? {}),
                ...nextData,
              },
            },
          };
        },
        "Marks superseded same-origin service-instance leases inactive on authority.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_LEASE)
        .then(localServiceInstanceLeaseUpdateTask);

      Cadenza.createMetaTask(
        "Delete superseded same-origin service transport",
        (ctx: any) => {
          const transportId = readString(ctx?.queryData?.filter?.uuid);
          if (!transportId) {
            return false;
          }

          const nextFilter = {
            uuid: transportId,
          };
          const nextData = {
            deleted: true,
          };

          return {
            ...ctx,
            filter: {
              ...(ctx.filter ?? {}),
              ...nextFilter,
            },
            data: {
              ...(ctx.data ?? {}),
              ...nextData,
            },
            queryData: {
              ...(ctx.queryData ?? {}),
              filter: {
                ...(ctx.queryData?.filter ?? ctx.filter ?? {}),
                ...nextFilter,
              },
              data: {
                ...(ctx.queryData?.data ?? ctx.data ?? {}),
                ...nextData,
              },
            },
          };
        },
        "Deletes superseded same-origin service transports on authority.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_TRANSPORT)
        .then(localServiceInstanceTransportUpdateTask);

      const prepareTransportlessInstanceTransportQueryTask =
        Cadenza.createMetaTask(
          "Prepare transportless service instance transport query",
          (ctx: any) => {
            const instanceId = readString(ctx?.queryData?.filter?.uuid);
            if (!instanceId) {
              return false;
            }

            return {
              ...ctx,
              __transportlessServiceInstanceId: instanceId,
              queryData: {
                filter: {
                  service_instance_id: instanceId,
                  deleted: false,
                },
              },
            };
          },
          "Loads undeleted transports for a retired instance candidate.",
          {
            register: false,
            isHidden: true,
          },
        );

      const prepareTransportlessInstanceQueryTask = Cadenza.createMetaTask(
        "Prepare transportless service instance query",
        (ctx: any) => {
          const instanceId = readString(ctx?.queryData?.filter?.uuid);
          if (!instanceId) {
            return false;
          }

          return {
            ...ctx,
            __transportlessServiceInstanceId: instanceId,
            queryData: {
              filter: {
                uuid: instanceId,
                deleted: false,
              },
            },
          };
        },
        "Loads the retired instance candidate so authority can clear stale active rows with no transports.",
        {
          register: false,
          isHidden: true,
        },
      );

      const retireTransportlessServiceInstanceTask = Cadenza.createUniqueMetaTask(
        "Retire transportless service instance",
        (ctx: any) => {
          let joinedContext: any = { ...ctx };
          for (const joined of Array.isArray(ctx.joinedContexts)
            ? ctx.joinedContexts
            : []) {
            joinedContext = {
              ...joinedContext,
              ...joined,
            };
          }

          const instanceId = readString(
            joinedContext.__transportlessServiceInstanceId ??
              joinedContext.queryData?.filter?.uuid,
          );
          if (!instanceId) {
            return false;
          }

          const undeletedTransports = Array.isArray(
            joinedContext.serviceInstanceTransports,
          )
            ? joinedContext.serviceInstanceTransports
                .map(normalizeServiceTransport)
                .filter(Boolean)
            : [];
          if (undeletedTransports.length > 0) {
            return false;
          }

          const instance = Array.isArray(joinedContext.serviceInstances)
            ? joinedContext.serviceInstances
                .map(normalizeServiceInstance)
                .filter(Boolean)
                .find(
                  (candidate: ServiceInstanceDescriptor) =>
                    candidate.uuid === instanceId,
                )
            : null;
          if (!instance || instance.deleted || !instance.isActive) {
            return false;
          }

          Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE, {
            __transportlessServiceInstanceId: instanceId,
            data: {
              is_active: false,
              is_non_responsive: false,
              deleted: false,
            },
            queryData: {
              filter: {
                uuid: instanceId,
              },
            },
          });

          return {
            ...joinedContext,
            __retiredTransportlessServiceInstanceId: instanceId,
          };
        },
        "Clears stale active instance rows that no longer own any undeleted transports.",
        {
          register: false,
          isHidden: true,
        },
      );

      prepareTransportlessInstanceTransportQueryTask.doOn(
        META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE,
      );
      prepareTransportlessInstanceQueryTask.doOn(
        META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE,
      );
      localServiceInstanceTransportlessTransportQueryTask
        .doAfter(prepareTransportlessInstanceTransportQueryTask)
        .then(retireTransportlessServiceInstanceTask);
      localServiceInstanceTransportlessInstanceQueryTask
        .doAfter(prepareTransportlessInstanceQueryTask)
        .then(retireTransportlessServiceInstanceTask);

      prepareOriginReconciliationLookupTask.doAfter(
        localServiceInstanceTransportInsertTask,
        localServiceInstanceTransportUpdateTask,
      );
      prepareOriginReconciliationLookupTask.doOn(
        META_SERVICE_INSTANCE_ORIGIN_RECONCILIATION_REQUESTED,
      );
      prepareOriginReconciliationSeedTransportQueryTask
        .doAfter(
          localServiceInstanceInsertTask,
        )
        .attachSignal("global.meta.service_instance.created");
      localServiceInstanceTransportByInstanceQueryTask
        .doAfter(prepareOriginReconciliationSeedTransportQueryTask)
        .then(emitOriginReconciliationRequestsFromInstanceTask);
      localServiceInstanceTransportLookupTask.doAfter(
        prepareOriginReconciliationLookupTask,
      );
      prepareOriginReconciliationScanTask.doAfter(
        localServiceInstanceTransportLookupTask,
      );
      prepareServiceInstanceReconciliationQueryTask.doAfter(
        prepareOriginReconciliationScanTask,
      );
      prepareServiceTransportReconciliationQueryTask.doAfter(
        prepareOriginReconciliationScanTask,
      );
      localServiceInstanceReconciliationQueryTask
        .doAfter(prepareServiceInstanceReconciliationQueryTask)
        .then(computeOriginReconciliationPlanTask);
      localServiceInstanceTransportReconciliationQueryTask
        .doAfter(prepareServiceTransportReconciliationQueryTask)
        .then(computeOriginReconciliationPlanTask);

      const requestServiceInstanceOriginCanonicalizationSweepTask =
        Cadenza.createUniqueMetaTask(
          "Request service instance origin canonicalization sweep",
          (ctx: any) => {
            const transportDescriptor =
              resolveServiceInstanceTransportTriggerDescriptor(ctx);
            const instanceId = readString(
              ctx?.data?.uuid ??
                ctx?.queryData?.filter?.uuid ??
                ctx?.uuid ??
                ctx?.__serviceInstanceId,
            );
            const instanceServiceName = readString(
              ctx?.data?.service_name ?? ctx?.service_name,
            );

            if (
              ctx?.__reason !== "cadenza_db_startup" &&
              !transportDescriptor &&
              (!isPersistedUuid(instanceId) || !instanceServiceName)
            ) {
              return false;
            }

            logCanonicalizationTrace("request", {
              reason: ctx?.__reason ?? null,
              attempt: ctx?.__attempt ?? null,
              serviceName: ctx?.data?.service_name ?? ctx?.service_name ?? null,
              transportOrigin: ctx?.data?.origin ?? ctx?.origin ?? null,
            });
            Cadenza.debounce(
              META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_EXECUTE,
              {
                ...ctx,
              },
              100,
            );
            return true;
          },
          "Requests one debounced authority canonicalization sweep for same-origin service-instance ownership.",
          {
            isHidden: true,
          },
        );

      requestServiceInstanceOriginCanonicalizationSweepTask.doOn(
        META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_REQUESTED,
        "global.meta.sync_controller.synced",
        "global.meta.service_instance.created",
        "meta.service_instance.created",
        "global.meta.service_registry.instance_registered",
        "meta.service_registry.instance_registered",
        "global.meta.service_registry.service_handshake",
        "global.meta.service_registry.service_not_responding",
        "global.meta.service_registry.deleted",
        "global.meta.service_instance_transport.created",
        "meta.service_instance_transport.created",
        "global.meta.service_registry.transport_registered",
        "meta.service_registry.transport_registered",
        "global.meta.service_registry.transport_updated",
        "meta.service_registry.transport_updated",
      );
      requestServiceInstanceOriginCanonicalizationSweepTask.doAfter(
        localServiceInstanceInsertTask,
        localServiceInstanceTransportInsertTask,
      );

      const executeServiceInstanceOriginCanonicalizationSweepTask =
        Cadenza.createUniqueMetaTask(
          "Execute service instance origin canonicalization sweep",
          (ctx: any) => {
            logCanonicalizationTrace("execute", {
              reason: ctx?.__reason ?? null,
              attempt: ctx?.__attempt ?? null,
              serviceName: ctx?.data?.service_name ?? ctx?.service_name ?? null,
              transportOrigin: ctx?.data?.origin ?? ctx?.origin ?? null,
            });
            return {
              ...ctx,
            };
          },
          "Executes one canonicalization sweep after the debounced request window closes.",
          {
            isHidden: true,
          },
        ).doOn(META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_EXECUTE);
      executeServiceInstanceOriginCanonicalizationSweepTask.doAfter(
        localServiceInstanceInsertTask,
        localServiceInstanceTransportInsertTask,
      );

      const prepareOriginCanonicalizationInstanceQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin canonicalization instance query",
          (ctx: any) => ({
            ...ctx,
            queryData: {
              filter: {
                deleted: false,
              },
            },
          }),
          "Loads all undeleted service_instance rows for authority same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const normalizeOriginCanonicalizationInstanceRowsTask =
        Cadenza.createMetaTask(
          "Normalize service instance origin canonicalization instance rows",
          (ctx: any) => ({
            ...ctx,
            serviceInstances: normalizeRowArray(ctx.rows ?? ctx.serviceInstances),
          }),
          "Normalizes queried service_instance rows for same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const prepareOriginCanonicalizationTransportQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin canonicalization transport query",
          (ctx: any) => ({
            ...ctx,
            queryData: {
              filter: {
                deleted: false,
              },
            },
          }),
          "Loads all undeleted service_instance_transport rows for authority same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const normalizeOriginCanonicalizationTransportRowsTask =
        Cadenza.createMetaTask(
          "Normalize service instance origin canonicalization transport rows",
          (ctx: any) => ({
            ...ctx,
            serviceInstanceTransports: normalizeRowArray(
              ctx.rows ?? ctx.serviceInstanceTransports,
            ),
          }),
          "Normalizes queried service_instance_transport rows for same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const canonicalizeServiceInstanceOriginsTask = Cadenza.createUniqueMetaTask(
        "Canonicalize service instance origins",
        (ctx: any) => {
          let joinedContext: any = { ...ctx };
          for (const joined of Array.isArray(ctx.joinedContexts)
            ? ctx.joinedContexts
            : []) {
            joinedContext = {
              ...joinedContext,
              ...joined,
            };
          }

          const serviceInstances = Array.isArray(joinedContext.serviceInstances)
            ? joinedContext.serviceInstances
                .map(normalizeServiceInstance)
                .filter(Boolean)
            : [];
          const serviceInstanceTransports = Array.isArray(
            joinedContext.serviceInstanceTransports,
          )
            ? joinedContext.serviceInstanceTransports
                .map(normalizeServiceTransport)
                .filter(Boolean)
            : [];

          const plans = collectServiceInstanceOriginReconciliationPlans({
            serviceInstances,
            serviceInstanceTransports,
          });

          logCanonicalizationTrace("plans", {
            serviceInstanceCount: serviceInstances.length,
            serviceTransportCount: serviceInstanceTransports.length,
            planCount: plans.length,
            plans: plans.map((plan) => ({
              serviceName: plan.serviceName ?? null,
              role: plan.role ?? null,
              origin: plan.origin ?? null,
              winningInstanceId: plan.winningInstanceId ?? null,
              retiredInstanceIds: plan.retiredInstanceIds,
              retiredTransportIds: plan.retiredTransportIds,
            })),
          });

          if (!plans.length) {
            return false;
          }

          for (const plan of plans) {
            for (const instanceId of plan.retiredInstanceIds) {
              Cadenza.emit(META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE, {
                __originCanonicalizationPlan: plan,
                queryData: {
                  filter: {
                    uuid: instanceId,
                  },
                },
              });
            }
          }

          return {
            ...joinedContext,
            __originCanonicalizationPlans: plans,
          };
        },
        "Canonicalizes same-origin service-instance ownership from queried authority state.",
        {
          register: false,
          isHidden: true,
        },
      );

      const splitSupersededServiceInstanceRetirementsTask =
        Cadenza.createMetaTask(
          "Split superseded same-origin service instance retirements",
          function* (ctx: any) {
            const plans = Array.isArray(ctx?.__originCanonicalizationPlans)
              ? ctx.__originCanonicalizationPlans
              : [];

            logCanonicalizationTrace("split_instances", {
              planCount: plans.length,
            });

            for (const plan of plans) {
              for (const instanceId of Array.isArray(plan?.retiredInstanceIds)
                ? plan.retiredInstanceIds
                : []) {
                if (!readString(instanceId)) {
                  continue;
                }

                yield {
                  ...ctx,
                  __originCanonicalizationPlan: plan,
                  filter: {
                    uuid: instanceId,
                  },
                  data: {
                    is_active: false,
                    is_non_responsive: false,
                    deleted: false,
                  },
                  queryData: {
                    filter: {
                      uuid: instanceId,
                    },
                    data: {
                      is_active: false,
                      is_non_responsive: false,
                      deleted: false,
                    },
                  },
                };
              }
            }
          },
          "Projects canonicalized same-origin instance retirements directly into local update tasks.",
          {
            register: false,
            isHidden: true,
          },
        );

      const splitSupersededServiceTransportRetirementsTask =
        Cadenza.createMetaTask(
          "Split superseded same-origin service transport retirements",
          function* (ctx: any) {
            const plans = Array.isArray(ctx?.__originCanonicalizationPlans)
              ? ctx.__originCanonicalizationPlans
              : [];

            logCanonicalizationTrace("split_transports", {
              planCount: plans.length,
            });

            for (const plan of plans) {
              for (const transportId of Array.isArray(plan?.retiredTransportIds)
                ? plan.retiredTransportIds
                : []) {
                if (!readString(transportId)) {
                  continue;
                }

                yield {
                  ...ctx,
                  __originCanonicalizationPlan: plan,
                  __retiredServiceInstanceIds: Array.isArray(
                    plan?.retiredInstanceIds,
                  )
                    ? plan.retiredInstanceIds
                    : [],
                  filter: {
                    uuid: transportId,
                  },
                  data: {
                    deleted: true,
                  },
                  queryData: {
                    filter: {
                      uuid: transportId,
                    },
                    data: {
                      deleted: true,
                    },
                  },
                };
              }
            }
          },
          "Projects canonicalized same-origin transport retirements directly into local update tasks.",
          {
            register: false,
            isHidden: true,
          },
        );

      const executeServiceInstanceLeaseConsistencySweepTask =
        Cadenza.createMetaTask(
          "Execute service instance lease consistency sweep",
          async (ctx: any, _emit: any, inquire: any) => {
            logLocalSyncDebug("service_instance_lease_consistency_sweep_execute", {
              reason: readString(ctx?.__reason),
              requestedAt: readString(ctx?.requestedAt),
              attemptDelayMs:
                typeof ctx?.__attemptDelayMs === "number"
                  ? ctx.__attemptDelayMs
                  : null,
            });
            const [serviceInstanceResult, serviceInstanceLeaseResult] =
              await Promise.all([
                inquire(
                  resolveDefaultLocalCadenzaDBQueryIntent(localServiceInstanceQueryTask),
                  {
                    queryData: {
                      filter: {
                        deleted: false,
                      },
                    },
                  },
                  { requireComplete: true },
                ),
                inquire(
                  resolveDefaultLocalCadenzaDBQueryIntent(
                    localServiceInstanceLeaseQueryTask,
                  ),
                  {
                    queryData: {
                      filter: {
                        deleted: false,
                      },
                    },
                  },
                  { requireComplete: true },
                ),
              ]);

            const serviceInstanceRows = Array.isArray(serviceInstanceResult?.rows)
              ? serviceInstanceResult.rows
              : [];
            const serviceInstanceLeaseRows = Array.isArray(
              serviceInstanceLeaseResult?.rows,
            )
              ? serviceInstanceLeaseResult.rows
              : [];
            logLocalSyncDebug("service_instance_lease_consistency_sweep_rows", {
              serviceInstanceRowCount: serviceInstanceRows.length,
              serviceInstanceLeaseRowCount: serviceInstanceLeaseRows.length,
            });
            const leaseUpdates = buildServiceInstanceLeaseConsistencyUpdates(
              normalizeRowArray(serviceInstanceRows),
              normalizeRowArray(serviceInstanceLeaseRows),
              ctx,
            );

            if (leaseUpdates.length === 0) {
              logLocalSyncDebug(
                "service_instance_lease_consistency_sweep_no_updates",
                {
                  serviceInstanceRowCount: serviceInstanceRows.length,
                  serviceInstanceLeaseRowCount: serviceInstanceLeaseRows.length,
                },
              );
              return false;
            }

            logLocalSyncDebug("service_instance_lease_consistency_sweep_updates", {
              leaseUpdateCount: leaseUpdates.length,
              leaseUpdateServiceInstanceIds: leaseUpdates
                .map((update) => {
                  const updateRecord = readRecord(update);
                  const queryData = readRecord(updateRecord?.queryData);
                  const queryFilter = readRecord(queryData?.filter);
                  const filter = readRecord(updateRecord?.filter);
                  return readString(
                    queryFilter?.service_instance_id ?? filter?.service_instance_id,
                  );
                })
                .filter(Boolean)
                .slice(0, 20),
            });

            return {
              ...ctx,
              __serviceInstanceLeaseConsistencyUpdates: leaseUpdates,
            };
          },
          "Reconciles authority service-instance leases with durable service_instance lifecycle state after startup and sync.",
          {
            register: false,
            isHidden: true,
          },
        );

      const splitServiceInstanceLeaseConsistencyUpdatesTask =
        Cadenza.createMetaTask(
          "Split service instance lease consistency updates",
          function* (ctx: any) {
            const updates = Array.isArray(
              ctx?.__serviceInstanceLeaseConsistencyUpdates,
            )
              ? ctx.__serviceInstanceLeaseConsistencyUpdates
              : [];

            logLocalSyncDebug("service_instance_lease_consistency_split", {
              updateCount: updates.length,
            });

            for (const update of updates) {
              if (
                !readString(
                  update?.queryData?.filter?.service_instance_id ??
                    update?.filter?.service_instance_id,
                )
              ) {
                continue;
              }

              yield update;
            }
          },
          "Projects service-instance lease consistency updates into local lease update tasks.",
          {
            register: false,
            isHidden: true,
          },
        );

      prepareOriginCanonicalizationInstanceQueryTask.doAfter(
        executeServiceInstanceOriginCanonicalizationSweepTask,
      );
      localServiceInstanceOriginCanonicalizationQueryTask
        .doAfter(prepareOriginCanonicalizationInstanceQueryTask)
        .then(normalizeOriginCanonicalizationInstanceRowsTask);
      prepareOriginCanonicalizationTransportQueryTask.doAfter(
        normalizeOriginCanonicalizationInstanceRowsTask,
      );
      localServiceInstanceTransportOriginCanonicalizationQueryTask
        .doAfter(prepareOriginCanonicalizationTransportQueryTask)
        .then(normalizeOriginCanonicalizationTransportRowsTask);
      normalizeOriginCanonicalizationTransportRowsTask.then(
        canonicalizeServiceInstanceOriginsTask,
      );
      canonicalizeServiceInstanceOriginsTask.then(
        splitSupersededServiceInstanceRetirementsTask,
        splitSupersededServiceTransportRetirementsTask,
      );
      splitSupersededServiceInstanceRetirementsTask.then(
        retireSupersededServiceInstanceTask,
      );
      executeServiceInstanceLeaseConsistencySweepTask.then(
        splitServiceInstanceLeaseConsistencyUpdatesTask,
      );
      splitServiceInstanceLeaseConsistencyUpdatesTask.doOn(
        META_SERVICE_INSTANCE_LEASE_CONSISTENCY_UPDATES_READY,
      );
      splitServiceInstanceLeaseConsistencyUpdatesTask.then(
        localServiceInstanceLeaseUpdateTask,
      );
      splitSupersededServiceTransportRetirementsTask.then(
        localServiceInstanceTransportUpdateTask,
      );

      Cadenza.createMetaTask(
        "Request service instance lease consistency sweep",
        (ctx: any, emit: any) => {
          logLocalSyncDebug("service_instance_lease_consistency_sweep_requested", {
            reason: readString(ctx?.__reason),
            attemptDelayMs:
              typeof ctx?.__attemptDelayMs === "number"
                ? ctx.__attemptDelayMs
                : null,
          });
          emit(META_SERVICE_INSTANCE_LEASE_CONSISTENCY_SWEEP_REQUESTED, {
            ...ctx,
            requestedAt: new Date().toISOString(),
          });
          return true;
        },
        "Requests one authority-local sweep to reconcile stale service-instance leases with durable lifecycle rows.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn("global.meta.sync_controller.synced", "meta.service_registry.instance_inserted");

      executeServiceInstanceLeaseConsistencySweepTask.doOn(
        META_SERVICE_INSTANCE_LEASE_CONSISTENCY_SWEEP_REQUESTED,
      );

      for (const delayMs of AUTHORITY_REGISTRY_PROJECTION_STARTUP_DELAYS_MS) {
        Cadenza.schedule(
          META_SERVICE_INSTANCE_LEASE_CONSISTENCY_SWEEP_REQUESTED,
          {
            __attemptDelayMs: delayMs,
            __reason: "cadenza_db_startup",
          },
          delayMs,
        );
      }

      for (const [index, delayMs] of SERVICE_INSTANCE_ORIGIN_CANONICALIZATION_STARTUP_DELAYS_MS.entries()) {
        Cadenza.schedule(
          META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_REQUESTED,
          {
            __attempt: index + 1,
            __reason: "cadenza_db_startup",
          },
          delayMs,
        );

      }
      return true;
    };

    ensureAuthorityOriginCanonicalizationTasks();

    Cadenza.createMetaTask(
      "Ensure authority origin canonicalization flow is registered",
      () => ensureAuthorityOriginCanonicalizationTasks(),
      "Registers the authority same-origin canonicalization flow once generated local service-instance tasks are available.",
      {
        register: false,
        isHidden: true,
      },
    ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");
  }
}

if (process.env.NODE_ENV === "production") {
  CadenzaDB.createCadenzaDBService();
}
