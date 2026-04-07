import Cadenza, {
  AUTHORITY_RUNTIME_STATUS_REPORT_INTENT,
  normalizeAuthorityRuntimeStatusReport,
  type AuthorityRuntimeStatusReport,
} from "@cadenza.io/service";

const META_AUTHORITY_RUNTIME_STATUS_REPLAY_REQUESTED =
  "meta.cadenza_db.authority_runtime_status.replay_requested";
const META_AUTHORITY_RUNTIME_STATUS_HISTORY_SNAPSHOT_REQUESTED =
  "meta.cadenza_db.authority_runtime_status.history_snapshot_requested";
const META_RUNTIME_STATUS_AUTHORITY_SYNC_REQUESTED_SIGNAL =
  "meta.service_registry.runtime_status_authority_sync_requested";
const AUTHORITY_RUNTIME_STATUS_HISTORY_ENSURE_DELAYS_MS = [250, 1_500, 5_000];

interface AuthorityRuntimeStatusActorState {
  latestReport: AuthorityRuntimeStatusReport | null;
  lastReceivedAt: string | null;
  lastAppliedAt: string | null;
  pendingApply: boolean;
}

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function readInteger(value: unknown): number | null {
  const normalized = readNumber(value);
  if (normalized === null) {
    return null;
  }

  return Math.max(0, Math.round(normalized));
}

function buildOnConflictDoNothing(target: string[]) {
  return {
    target,
    action: {
      do: "nothing",
    },
  };
}

function buildHealthSnapshotInsertContext(
  report: AuthorityRuntimeStatusReport,
): Record<string, any> {
  const runtimeMetrics =
    report.health?.runtimeMetrics &&
    typeof report.health.runtimeMetrics === "object"
      ? (report.health.runtimeMetrics as Record<string, unknown>)
      : null;
  const rssBytes = readInteger(runtimeMetrics?.rssBytes);
  const heapUsedBytes = readInteger(runtimeMetrics?.heapUsedBytes);
  const heapTotalBytes = readInteger(runtimeMetrics?.heapTotalBytes);
  const memoryLimitBytes = readInteger(runtimeMetrics?.memoryLimitBytes);

  return {
    data: {
      service_instance_id: report.serviceInstanceId,
      cpu:
        typeof report.cpuUsage === "number"
          ? Math.max(0, Math.min(1, report.cpuUsage))
          : 0,
      memory: rssBytes ?? 0,
      latency: readInteger(report.eventLoopLag) ?? 0,
      snapshot_time: report.reportedAt,
      custom_metrics: {
        cpuUsage: report.cpuUsage ?? null,
        memoryUsage: report.memoryUsage ?? null,
        eventLoopLag: report.eventLoopLag ?? null,
        rssBytes,
        heapUsedBytes,
        heapTotalBytes,
        memoryLimitBytes,
        numberOfRunningGraphs: report.numberOfRunningGraphs,
      },
    },
    queryData: {
      data: {
        service_instance_id: report.serviceInstanceId,
        cpu:
          typeof report.cpuUsage === "number"
            ? Math.max(0, Math.min(1, report.cpuUsage))
            : 0,
        memory: rssBytes ?? 0,
        latency: readInteger(report.eventLoopLag) ?? 0,
        snapshot_time: report.reportedAt,
        custom_metrics: {
          cpuUsage: report.cpuUsage ?? null,
          memoryUsage: report.memoryUsage ?? null,
          eventLoopLag: report.eventLoopLag ?? null,
          rssBytes,
          heapUsedBytes,
          heapTotalBytes,
          memoryLimitBytes,
          numberOfRunningGraphs: report.numberOfRunningGraphs,
        },
      },
      onConflict: buildOnConflictDoNothing([
        "service_instance_id",
        "snapshot_time",
      ]),
    },
  };
}

function readServiceInstanceId(input: Record<string, any> | null | undefined): string {
  return String(
    input?.serviceInstanceId ??
      input?.__serviceInstanceId ??
      input?.serviceInstance?.uuid ??
      input?.data?.uuid ??
      input?.queryData?.filter?.uuid ??
      input?.filter?.uuid ??
      "",
  ).trim();
}

export function registerAuthorityRuntimeStatusTasks(): void {
  const authorityRuntimeStatusActor = Cadenza.createActor<
    {},
    AuthorityRuntimeStatusActorState | null
  >(
    {
      name: "AuthorityRuntimeStatusActor",
      description:
        "Tracks the latest volatile runtime-status report per remote service instance on authority and reapplies it once structural registry rows are available.",
      defaultKey: "authority-runtime-status-default",
      keyResolver: (input) => readServiceInstanceId(input),
      initState: {},
      session: {
        enabled: true,
        persistDurableState: false,
        idleTtlMs: 10 * 60_000,
      },
    },
    { isMeta: true },
  );

  const applyReport = (
    report: AuthorityRuntimeStatusReport,
    runtimeState: AuthorityRuntimeStatusActorState | null | undefined,
    setRuntimeState: (
      next:
        | AuthorityRuntimeStatusActorState
        | ((current: AuthorityRuntimeStatusActorState | null) => AuthorityRuntimeStatusActorState),
    ) => void,
  ) => {
    const applied =
      ((Cadenza.serviceRegistry as any)?.applyAuthorityRuntimeStatusReport?.(report) as
        | boolean
        | undefined) ?? false;
    const now = new Date().toISOString();
    setRuntimeState({
      latestReport: report,
      lastReceivedAt: now,
      lastAppliedAt: applied ? now : runtimeState?.lastAppliedAt ?? null,
      pendingApply: !applied,
    });

    if (applied) {
      Cadenza.emit(META_AUTHORITY_RUNTIME_STATUS_HISTORY_SNAPSHOT_REQUESTED, {
        __authorityRuntimeStatusReport: report,
        applied: true,
      });
    }

    return {
      applied,
      serviceName: report.serviceName,
      serviceInstanceId: report.serviceInstanceId,
      reportedAt: report.reportedAt,
      __authorityRuntimeStatusReport: report,
    };
  };

  Cadenza.createMetaTask(
    "Record authority runtime status report",
    authorityRuntimeStatusActor.task(
      ({ input, runtimeState, setRuntimeState }) => {
        const report = normalizeAuthorityRuntimeStatusReport(
          input as Record<string, any>,
        );
        if (!report) {
          return false;
        }

        return applyReport(report, runtimeState, setRuntimeState);
      },
      { mode: "write" },
    ),
    "Records a lightweight runtime-status report on authority without touching the durable registry tables.",
  ).respondsTo(AUTHORITY_RUNTIME_STATUS_REPORT_INTENT);

  Cadenza.createMetaTask(
    "Queue authority runtime status replay",
    (ctx, emit) => {
      const serviceInstanceId = readServiceInstanceId(ctx as Record<string, any>);
      if (!serviceInstanceId) {
        return false;
      }

      emit(META_AUTHORITY_RUNTIME_STATUS_REPLAY_REQUESTED, {
        serviceInstanceId,
      });
      return true;
    },
    "Requests authority-local replay of the latest volatile runtime report after structural service-instance updates land.",
    {
      register: false,
      isHidden: true,
    },
  ).doOn(
    "global.meta.service_instance.inserted",
    "global.meta.service_instance.updated",
    "meta.service_instance.inserted",
    "meta.service_instance.updated",
  );

  Cadenza.createMetaTask(
    "Replay authority runtime status report",
    authorityRuntimeStatusActor.task(
      ({ input, runtimeState, setRuntimeState }) => {
        const targetId = readServiceInstanceId(input as Record<string, any>);
        if (
          !targetId ||
          !runtimeState?.latestReport ||
          runtimeState.latestReport.serviceInstanceId !== targetId ||
          !runtimeState.pendingApply
        ) {
          return false;
        }

        return applyReport(runtimeState.latestReport, runtimeState, setRuntimeState);
      },
      { mode: "write" },
    ),
    "Reapplies cached volatile runtime status after authority structural registry rows become available.",
  ).doOn(META_AUTHORITY_RUNTIME_STATUS_REPLAY_REQUESTED);

  const ensureRuntimeStatusHistoryTasks = () => {
    if (Cadenza.get("Prepare authority runtime status history snapshot insert")) {
      return true;
    }

    const localHealthSnapshotInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("service_instance_health_snapshot");
    if (!localHealthSnapshotInsertTask) {
      return false;
    }

    Cadenza.createMetaTask(
      "Prepare authority runtime status history snapshot insert",
      (ctx: any) => {
        if (ctx?.applied !== true) {
          return false;
        }

        const report = normalizeAuthorityRuntimeStatusReport(
          (ctx?.__authorityRuntimeStatusReport ?? ctx) as Record<string, any>,
        );
        if (!report) {
          return false;
        }

        return buildHealthSnapshotInsertContext(report);
      },
      "Builds append-only health snapshot rows from authority runtime-status reports for visualization.",
      {
        register: false,
        isHidden: true,
      },
    )
      .doOn(META_AUTHORITY_RUNTIME_STATUS_HISTORY_SNAPSHOT_REQUESTED)
      .then(localHealthSnapshotInsertTask);

    Cadenza.createMetaTask(
      "Persist local authority runtime status history snapshot",
      (ctx: any) => {
        const report = normalizeAuthorityRuntimeStatusReport(ctx as Record<string, any>);
        if (!report || report.serviceName !== "CadenzaDB") {
          return false;
        }

        const localServiceInstanceId = String(
          (Cadenza.serviceRegistry as any)?.serviceInstanceId ?? "",
        ).trim();
        if (
          !localServiceInstanceId ||
          report.serviceInstanceId !== localServiceInstanceId
        ) {
          return false;
        }

        return buildHealthSnapshotInsertContext(report);
      },
      "Persists local CadenzaDB runtime-status snapshots through the same authority history path used for remote reports.",
      {
        register: false,
        isHidden: true,
      },
    )
      .doOn(META_RUNTIME_STATUS_AUTHORITY_SYNC_REQUESTED_SIGNAL)
      .then(localHealthSnapshotInsertTask);

    return true;
  };

  ensureRuntimeStatusHistoryTasks();

  Cadenza.createMetaTask(
    "Ensure authority runtime status history flow is registered",
    () => ensureRuntimeStatusHistoryTasks(),
    "Registers authority-local runtime health snapshot persistence once the generated insert task is available.",
    {
      register: false,
      isHidden: true,
    },
  ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");

  for (const delayMs of AUTHORITY_RUNTIME_STATUS_HISTORY_ENSURE_DELAYS_MS) {
    Cadenza.schedule(
      "meta.service_registry.instance_inserted",
      {
        serviceInstance: {
          uuid: Cadenza.serviceRegistry.serviceInstanceId,
          serviceName: Cadenza.serviceRegistry.serviceName,
        },
        __reason: "authority_runtime_status_history_startup_ensure",
      },
      delayMs,
    );
  }
}
