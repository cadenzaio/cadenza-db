import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Cadenza, {
  AUTHORITY_RUNTIME_STATUS_REPORT_INTENT,
} from "@cadenza.io/service";
import { registerAuthorityRuntimeStatusTasks } from "../src/runtimeStatusAuthority";

const META_RUNTIME_STATUS_AUTHORITY_SYNC_REQUESTED_SIGNAL =
  "meta.service_registry.runtime_status_authority_sync_requested";

describe("authority runtime status actor", () => {
  let persistedHealthSnapshots: Record<string, unknown>[];
  let persistedLeases: Record<string, unknown>[];
  let knownServiceInstanceIds: Set<string>;
  let healthSnapshotInsertTask: any;
  let leaseInsertTask: any;
  let serviceInstanceQueryTask: any;

  beforeEach(() => {
    try {
      Cadenza.reset();
    } catch {
      // Ignore first-run resets before bootstrap.
    }
    Cadenza.bootstrap();
    Cadenza.setMode("production");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    persistedHealthSnapshots = [];
    persistedLeases = [];
    knownServiceInstanceIds = new Set<string>();
    healthSnapshotInsertTask = Cadenza.createMetaTask(
      "Capture health snapshot insert",
      (ctx) => {
        persistedHealthSnapshots.push({ ...ctx });
        return ctx;
      },
      "",
      { register: false },
    );
    leaseInsertTask = Cadenza.createMetaTask(
      "Capture lease insert",
      (ctx) => {
        persistedLeases.push({ ...ctx });
        return ctx;
      },
      "",
      { register: false },
    );
    serviceInstanceQueryTask = Cadenza.createMetaTask(
      "Capture service_instance query",
      (ctx) => {
        const targetId = String(ctx?.queryData?.filter?.uuid ?? "").trim();
        const rows = targetId && knownServiceInstanceIds.has(targetId)
          ? [{ uuid: targetId }]
          : [];
        return {
          ...ctx,
          rows,
          rowCount: rows.length,
        };
      },
      "",
      { register: false },
    );
    vi.spyOn(Cadenza, "getLocalCadenzaDBInsertTask").mockImplementation(
      ((tableName: string) =>
        tableName === "service_instance_health_snapshot"
          ? (healthSnapshotInsertTask as any)
          : tableName === "service_instance_lease"
            ? (leaseInsertTask as any)
          : null) as any,
    );
    vi.spyOn(Cadenza, "getLocalCadenzaDBQueryTask").mockImplementation(
      ((tableName: string) =>
        tableName === "service_instance"
          ? (serviceInstanceQueryTask as any)
          : null) as any,
    );
    registerAuthorityRuntimeStatusTasks();
    (Cadenza.serviceRegistry as any).serviceName = "CadenzaDB";
    (Cadenza.serviceRegistry as any).serviceInstanceId = "cadenza-db";
  });

  afterEach(() => {
    try {
      Cadenza.reset();
    } catch {
      // Ignore cleanup after failed bootstrap.
    }
    vi.restoreAllMocks();
  });

  it("applies volatile runtime status directly when the structural instance is already known", async () => {
    const registry = Cadenza.serviceRegistry as any;
    knownServiceInstanceIds.add("orders-1");
    registry.instances.set("OrdersService", [
      {
        uuid: "orders-1",
        serviceName: "OrdersService",
        numberOfRunningGraphs: 0,
        isPrimary: false,
        isActive: false,
        isNonResponsive: true,
        isBlocked: false,
        runtimeState: "unavailable",
        acceptingWork: false,
        reportedAt: "2026-03-27T09:00:00.000Z",
        health: {},
        isFrontend: false,
        isDatabase: false,
        transports: [],
      },
    ]);

    const result = await Cadenza.inquire(
      AUTHORITY_RUNTIME_STATUS_REPORT_INTENT,
      {
        serviceName: "OrdersService",
        serviceInstanceId: "orders-1",
        reportedAt: "2026-03-27T10:00:00.000Z",
        state: "healthy",
        acceptingWork: true,
        numberOfRunningGraphs: 2,
        cpuUsage: 0.3,
        memoryUsage: 0.4,
        eventLoopLag: 9,
        isActive: true,
        isNonResponsive: false,
        isBlocked: false,
        health: {
          runtimeMetrics: {
            rssBytes: 300,
            heapUsedBytes: 180,
            heapTotalBytes: 220,
            memoryLimitBytes: 700,
          },
        },
      },
      {
        requireComplete: true,
        overallTimeoutMs: 1_000,
      },
    );

    expect(result).toMatchObject({
      applied: true,
      serviceName: "OrdersService",
      serviceInstanceId: "orders-1",
    });
    expect(registry.instances.get("OrdersService")?.[0]).toMatchObject({
      uuid: "orders-1",
      isActive: true,
      isNonResponsive: false,
      runtimeState: "healthy",
      acceptingWork: true,
      numberOfRunningGraphs: 2,
      health: {
        cpuUsage: 0.3,
        memoryUsage: 0.4,
        eventLoopLag: 9,
        runtimeMetrics: {
          rssBytes: 300,
          heapUsedBytes: 180,
          heapTotalBytes: 220,
          memoryLimitBytes: 700,
        },
      },
    });
    expect(persistedHealthSnapshots).toHaveLength(1);
    expect(persistedHealthSnapshots[0]).toMatchObject({
      queryData: {
        data: {
          service_instance_id: "orders-1",
          cpu: 0.3,
          memory: 300,
          latency: 9,
          snapshot_time: "2026-03-27T10:00:00.000Z",
          custom_metrics: {
            memoryUsage: 0.4,
            numberOfRunningGraphs: 2,
          },
        },
      },
    });
    expect(persistedLeases).toHaveLength(1);
    expect(persistedLeases[0]).toMatchObject({
      queryData: {
        data: {
          service_instance_id: "orders-1",
          status: "active",
          is_ready: true,
          readiness_reason: "accepting_work",
        },
      },
    });
  });

  it("replays a cached volatile report after the structural instance row arrives", async () => {
    const registry = Cadenza.serviceRegistry as any;

    const firstResult = await Cadenza.inquire(
      AUTHORITY_RUNTIME_STATUS_REPORT_INTENT,
      {
        serviceName: "OrdersService",
        serviceInstanceId: "orders-2",
        reportedAt: "2026-03-27T10:05:00.000Z",
        state: "healthy",
        acceptingWork: true,
        numberOfRunningGraphs: 1,
        cpuUsage: 0.25,
        memoryUsage: 0.5,
        eventLoopLag: 7,
        isActive: true,
        isNonResponsive: false,
        isBlocked: false,
        health: {
          runtimeMetrics: {
            rssBytes: 280,
            heapUsedBytes: 170,
            heapTotalBytes: 210,
            memoryLimitBytes: 700,
          },
        },
      },
      {
        requireComplete: true,
        overallTimeoutMs: 1_000,
      },
    );

    expect(firstResult).toMatchObject({
      applied: false,
      serviceName: "OrdersService",
      serviceInstanceId: "orders-2",
    });
    expect(persistedLeases).toHaveLength(0);

    registry.instances.set("OrdersService", [
      {
        uuid: "orders-2",
        serviceName: "OrdersService",
        numberOfRunningGraphs: 0,
        isPrimary: false,
        isActive: false,
        isNonResponsive: false,
        isBlocked: false,
        runtimeState: "unavailable",
        acceptingWork: false,
        reportedAt: "2026-03-27T10:04:00.000Z",
        health: {},
        isFrontend: false,
        isDatabase: false,
        transports: [],
      },
    ]);
    knownServiceInstanceIds.add("orders-2");

    Cadenza.emit("meta.service_instance.updated", {
      data: {
        uuid: "orders-2",
        service_name: "OrdersService",
        is_primary: false,
        is_active: false,
        is_non_responsive: false,
        is_blocked: false,
        number_of_running_graphs: 0,
        health: {},
        is_frontend: false,
        is_database: false,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(registry.instances.get("OrdersService")?.[0]).toMatchObject({
      uuid: "orders-2",
      isActive: true,
      isNonResponsive: false,
      runtimeState: "healthy",
      acceptingWork: true,
      numberOfRunningGraphs: 1,
      health: {
        cpuUsage: 0.25,
        memoryUsage: 0.5,
        eventLoopLag: 7,
        runtimeMetrics: {
          rssBytes: 280,
          heapUsedBytes: 170,
          heapTotalBytes: 210,
          memoryLimitBytes: 700,
        },
      },
    });
    expect(persistedHealthSnapshots).toHaveLength(1);
    expect(persistedHealthSnapshots[0]).toMatchObject({
      queryData: {
        data: {
          service_instance_id: "orders-2",
          cpu: 0.25,
          memory: 280,
          latency: 7,
        },
      },
    });
    expect(persistedLeases).toHaveLength(1);
    expect(persistedLeases[0]).toMatchObject({
      queryData: {
        data: {
          service_instance_id: "orders-2",
          status: "active",
          is_ready: true,
        },
      },
    });
  });

  it("persists local CadenzaDB snapshots from the authority sync signal", async () => {
    knownServiceInstanceIds.add("cadenza-db");
    Cadenza.emit(META_RUNTIME_STATUS_AUTHORITY_SYNC_REQUESTED_SIGNAL, {
      serviceName: "CadenzaDB",
      serviceInstanceId: "cadenza-db",
      reportedAt: "2026-03-27T10:10:00.000Z",
      state: "healthy",
      acceptingWork: true,
      numberOfRunningGraphs: 0,
      cpuUsage: 0.1,
      memoryUsage: 0.2,
      eventLoopLag: 4,
      isActive: true,
      isNonResponsive: false,
      isBlocked: false,
      health: {
        runtimeMetrics: {
          rssBytes: 200,
          heapUsedBytes: 100,
          heapTotalBytes: 150,
          memoryLimitBytes: 700,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(persistedHealthSnapshots).toHaveLength(1);
    expect(persistedHealthSnapshots[0]).toMatchObject({
      queryData: {
        data: {
          service_instance_id: "cadenza-db",
          cpu: 0.1,
          memory: 200,
          latency: 4,
        },
      },
    });
    expect(persistedLeases).toHaveLength(1);
    expect(persistedLeases[0]).toMatchObject({
      queryData: {
        data: {
          service_instance_id: "cadenza-db",
          status: "active",
          is_ready: true,
        },
      },
    });
  });

  it("registers history persistence after the local insert task becomes available later", async () => {
    const insertTaskGetter = vi.spyOn(Cadenza, "getLocalCadenzaDBInsertTask");
    let insertTaskAvailable = false;
    insertTaskGetter.mockImplementation(
      ((tableName: string) =>
        insertTaskAvailable
          ? tableName === "service_instance_health_snapshot"
            ? healthSnapshotInsertTask
            : tableName === "service_instance_lease"
              ? leaseInsertTask
              : null
          : null) as any,
    );

    Cadenza.reset();
    Cadenza.bootstrap();
    Cadenza.setMode("production");
    persistedHealthSnapshots = [];
    persistedLeases = [];
    knownServiceInstanceIds = new Set<string>(["cadenza-db"]);
    healthSnapshotInsertTask = Cadenza.createMetaTask(
      "Capture health snapshot insert",
      (ctx) => {
        persistedHealthSnapshots.push({ ...ctx });
        return ctx;
      },
      "",
      { register: false },
    );
    leaseInsertTask = Cadenza.createMetaTask(
      "Capture lease insert",
      (ctx) => {
        persistedLeases.push({ ...ctx });
        return ctx;
      },
      "",
      { register: false },
    );
    serviceInstanceQueryTask = Cadenza.createMetaTask(
      "Capture service_instance query",
      (ctx) => {
        const targetId = String(ctx?.queryData?.filter?.uuid ?? "").trim();
        const rows = targetId && knownServiceInstanceIds.has(targetId)
          ? [{ uuid: targetId }]
          : [];
        return {
          ...ctx,
          rows,
          rowCount: rows.length,
        };
      },
      "",
      { register: false },
    );
    registerAuthorityRuntimeStatusTasks();
    (Cadenza.serviceRegistry as any).serviceName = "CadenzaDB";
    (Cadenza.serviceRegistry as any).serviceInstanceId = "cadenza-db";

    insertTaskAvailable = true;
    Cadenza.emit("global.meta.sync_controller.synced", {});
    await new Promise((resolve) => setTimeout(resolve, 25));

    Cadenza.emit(META_RUNTIME_STATUS_AUTHORITY_SYNC_REQUESTED_SIGNAL, {
      serviceName: "CadenzaDB",
      serviceInstanceId: "cadenza-db",
      reportedAt: "2026-03-27T10:11:00.000Z",
      state: "healthy",
      acceptingWork: true,
      numberOfRunningGraphs: 0,
      cpuUsage: 0.1,
      memoryUsage: 0.2,
      eventLoopLag: 4,
      isActive: true,
      isNonResponsive: false,
      isBlocked: false,
      health: {
        runtimeMetrics: {
          rssBytes: 200,
          heapUsedBytes: 100,
          heapTotalBytes: 150,
          memoryLimitBytes: 700,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(persistedHealthSnapshots).toHaveLength(1);
    expect(persistedHealthSnapshots[0]).toMatchObject({
      queryData: {
        data: {
          service_instance_id: "cadenza-db",
          cpu: 0.1,
          memory: 200,
          latency: 4,
        },
      },
    });
    expect(persistedLeases).toHaveLength(1);
  });

  it("skips lease persistence until the structural instance row exists", async () => {
    Cadenza.emit(META_RUNTIME_STATUS_AUTHORITY_SYNC_REQUESTED_SIGNAL, {
      serviceName: "CadenzaDB",
      serviceInstanceId: "cadenza-db",
      reportedAt: "2026-03-27T10:12:00.000Z",
      state: "healthy",
      acceptingWork: true,
      numberOfRunningGraphs: 0,
      cpuUsage: 0.1,
      memoryUsage: 0.2,
      eventLoopLag: 4,
      isActive: true,
      isNonResponsive: false,
      isBlocked: false,
      health: {
        runtimeMetrics: {
          rssBytes: 200,
          heapUsedBytes: 100,
          heapTotalBytes: 150,
          memoryLimitBytes: 700,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(persistedLeases).toHaveLength(0);

    knownServiceInstanceIds.add("cadenza-db");

    Cadenza.emit(META_RUNTIME_STATUS_AUTHORITY_SYNC_REQUESTED_SIGNAL, {
      serviceName: "CadenzaDB",
      serviceInstanceId: "cadenza-db",
      reportedAt: "2026-03-27T10:12:05.000Z",
      state: "healthy",
      acceptingWork: true,
      numberOfRunningGraphs: 0,
      cpuUsage: 0.1,
      memoryUsage: 0.2,
      eventLoopLag: 4,
      isActive: true,
      isNonResponsive: false,
      isBlocked: false,
      health: {
        runtimeMetrics: {
          rssBytes: 200,
          heapUsedBytes: 100,
          heapTotalBytes: 150,
          memoryLimitBytes: 700,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(persistedLeases).toHaveLength(1);
  });
});
