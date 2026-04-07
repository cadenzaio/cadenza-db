import { afterEach, describe, expect, it, vi } from "vitest";

import Cadenza, {
  AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT,
  AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT,
  AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT,
  AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL,
} from "@cadenza.io/service";
import CadenzaDB, { resolveLocalServiceRegistrySyncTasks } from "../src/index";

describe("local CadenzaDB sync task resolution", () => {
  afterEach(() => {
    try {
      Cadenza.reset();
    } catch {
      // Ignore resets before bootstrap in the test harness.
    }
    vi.restoreAllMocks();
  });

  it("uses the generated local CadenzaDB query task names", () => {
    const tasksByTable = {
      service_instance: { name: "Query service_instance" },
      service_instance_transport: { name: "Query service_instance_transport" },
      service_manifest: { name: "Query service_manifest" },
    };

    const getTaskSpy = vi
      .spyOn(Cadenza, "get")
      .mockImplementation((taskName) => {
        const match = Object.values(tasksByTable).find(
          (task) => task.name === taskName,
        );
        return (match as any) ?? undefined;
      });

    const resolvedTasks = resolveLocalServiceRegistrySyncTasks();

    expect(getTaskSpy).toHaveBeenCalledWith("Query service_instance");
    expect(getTaskSpy).toHaveBeenCalledWith("Query service_instance_transport");
    expect(getTaskSpy).toHaveBeenCalledWith("Query service_manifest");
    expect(resolvedTasks).toMatchObject({
      queryServiceInstanceTask: tasksByTable.service_instance,
      queryServiceInstanceTransportTask: tasksByTable.service_instance_transport,
      queryServiceManifestTask: tasksByTable.service_manifest,
    });
  });

  it("fails fast when a required local sync query task is missing", () => {
    vi.spyOn(Cadenza, "get").mockImplementation((taskName) =>
      taskName === "Query service_manifest" ||
      taskName === "dbQueryServiceManifest"
        ? undefined
        : ({ name: taskName } as any),
    );

    expect(() => resolveLocalServiceRegistrySyncTasks()).toThrow(
      /local sync query tasks are not available/i,
    );
  });

  it("registers bootstrap authority responders for service instance and transport inserts", async () => {
    const insertedRows: Array<Record<string, unknown>> = [];

    Cadenza.createMetaTask("Insert service_instance", (ctx) => {
      insertedRows.push({
        table: "service_instance",
        data: ctx.data,
      });
      return {
        uuid: ctx.data?.uuid,
        data: ctx.data,
      };
    });
    Cadenza.createMetaTask("Insert service_instance_transport", (ctx) => {
      insertedRows.push({
        table: "service_instance_transport",
        data: ctx.data,
      });
      return {
        uuid: ctx.data?.uuid,
        data: ctx.data,
      };
    });

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(Cadenza, "interval").mockImplementation((() => undefined) as any);

    CadenzaDB.createCadenzaDBService();

    await Cadenza.inquire(
      AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT,
      {
        data: {
          uuid: "runner-1",
          process_pid: 42,
          service_name: "ScheduledRunnerService",
          is_active: true,
        },
      },
      { requireComplete: true },
    );
    await Cadenza.inquire(
      AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT,
      {
        data: {
          uuid: "runner-transport-1",
          service_instance_id: "runner-1",
          role: "internal",
          origin: "http://scheduled-runner:3002",
          protocols: ["rest"],
        },
      },
      { requireComplete: true },
    );

    expect(insertedRows).toEqual([
      {
        table: "service_instance",
        data: expect.objectContaining({
          uuid: "runner-1",
          service_name: "ScheduledRunnerService",
        }),
      },
      {
        table: "service_instance_transport",
        data: expect.objectContaining({
          uuid: "runner-transport-1",
          service_instance_id: "runner-1",
        }),
      },
    ]);
  });

  it("registers bootstrap authority responders when local insert tasks appear after startup", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;
    const insertedRows: Array<Record<string, unknown>> = [];

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    expect(
      FreshCadenza.get("Register service instance with authority"),
    ).toBeUndefined();

    FreshCadenza.createMetaTask("Insert service_instance", (ctx) => {
      insertedRows.push({
        table: "service_instance",
        data: ctx.data,
      });
      return {
        uuid: ctx.data?.uuid,
        data: ctx.data,
      };
    });
    FreshCadenza.createMetaTask("Insert service_instance_transport", (ctx) => {
      insertedRows.push({
        table: "service_instance_transport",
        data: ctx.data,
      });
      return {
        uuid: ctx.data?.uuid,
        data: ctx.data,
      };
    });

    const ensureTask = FreshCadenza.get(
      "Ensure authority bootstrap registration flow is registered",
    );

    expect(ensureTask).toBeTruthy();

    FreshCadenza.run(ensureTask!, {});

    await FreshCadenza.inquire(
      AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT,
      {
        data: {
          uuid: "runner-late-1",
          process_pid: 42,
          service_name: "ScheduledRunnerService",
          is_active: true,
        },
      },
      { requireComplete: true },
    );
    await FreshCadenza.inquire(
      AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT,
      {
        data: {
          uuid: "runner-late-transport-1",
          service_instance_id: "runner-late-1",
          role: "internal",
          origin: "http://scheduled-runner:3002",
          protocols: ["rest"],
        },
      },
      { requireComplete: true },
    );

    expect(insertedRows).toEqual([
      {
        table: "service_instance",
        data: expect.objectContaining({
          uuid: "runner-late-1",
          service_name: "ScheduledRunnerService",
        }),
      },
      {
        table: "service_instance_transport",
        data: expect.objectContaining({
          uuid: "runner-late-transport-1",
          service_instance_id: "runner-late-1",
        }),
      },
    ]);
  });

  it("requests a follow-up sync after creating local throttle sync tasks", async () => {
    Cadenza.createMetaTask("Query service_instance", () => ({
      serviceInstances: [],
      rowCount: 0,
    }));
    Cadenza.createMetaTask("Query service_instance_transport", () => ({
      serviceInstanceTransports: [],
      rowCount: 0,
    }));
    Cadenza.createMetaTask("Query service_manifest", () => ({
      serviceManifests: [],
      rowCount: 0,
    }));

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(Cadenza, "interval").mockImplementation((() => undefined) as any);

    const emitSpy = vi.spyOn(Cadenza, "emit");

    CadenzaDB.createCadenzaDBService();
    Cadenza.emit("global.meta.sync_controller.synced", {});

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(
      emitSpy.mock.calls.some(
        ([signal, payload]) =>
          signal === "meta.sync_requested" &&
          payload &&
          typeof payload === "object" &&
          (payload as Record<string, unknown>).__syncing === true &&
          (payload as Record<string, unknown>).__reason ===
            "cadenza_db_local_sync_tasks_created",
      ),
    ).toBe(true);
  });

  it("replays persisted registry rows into authority runtime state after startup sync", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;
    const projectedInstances: Array<Record<string, unknown>> = [];
    const projectedManifestUpdates: Array<Record<string, unknown>> = [];

    FreshCadenza.createMetaTask("Query service_instance", () => ({
      rows: [
        {
          uuid: "runner-1",
          service_name: "ScheduledRunnerService",
          is_active: true,
          is_non_responsive: false,
          is_blocked: false,
          is_frontend: false,
          is_database: false,
          health: {},
        },
      ],
      rowCount: 1,
    }));
    FreshCadenza.createMetaTask("Query service_instance_transport", () => ({
      rows: [
        {
          uuid: "runner-transport-1",
          service_instance_id: "runner-1",
          role: "internal",
          origin: "http://scheduled-runner:3002",
          protocols: ["rest"],
          deleted: false,
        },
      ],
      rowCount: 1,
    }));
    FreshCadenza.createMetaTask("Query service_manifest", () => ({
      rows: [
        {
          service_instance_id: "runner-1",
          manifest: {
            serviceName: "ScheduledRunnerService",
            serviceInstanceId: "runner-1",
            revision: 2,
            manifestHash: "runner-manifest-v2",
            publishedAt: "2026-03-30T12:00:00.000Z",
            tasks: [],
            signals: [],
            intents: [],
            actors: [],
            routines: [],
            directionalTaskMaps: [],
            signalToTaskMaps: [],
            intentToTaskMaps: [],
            actorTaskMaps: [],
            taskToRoutineMaps: [],
          },
        },
      ],
      rowCount: 1,
    }));

    FreshCadenza.createMetaTask("Capture projected instance update", (ctx) => {
      projectedInstances.push(ctx.serviceInstance);
      return true;
    }).doOn("global.meta.service_instance.updated");
    FreshCadenza.createMetaTask("Capture projected manifest update", (ctx) => {
      projectedManifestUpdates.push(ctx);
      return true;
    }).doOn(AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL);

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);
    vi.spyOn(FreshCadenza, "schedule").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();
    const ensureProjectionTask = FreshCadenza.get(
      "Ensure authority registry projection flow is registered",
    );

    expect(ensureProjectionTask).toBeTruthy();

    FreshCadenza.run(ensureProjectionTask!, {});
    const projectTask = FreshCadenza.get(
      "Project persisted authority registry state",
    );

    expect(projectTask).toBeTruthy();

    FreshCadenza.run(projectTask!, {
      serviceInstances: [
        {
          uuid: "runner-1",
          service_name: "ScheduledRunnerService",
          is_active: true,
          is_non_responsive: false,
          is_blocked: false,
          is_frontend: false,
          is_database: false,
          health: {},
        },
      ],
      serviceInstanceTransports: [
        {
          uuid: "runner-transport-1",
          service_instance_id: "runner-1",
          role: "internal",
          origin: "http://scheduled-runner:3002",
          protocols: ["rest"],
          deleted: false,
        },
      ],
      serviceManifests: [
        {
          service_instance_id: "runner-1",
          manifest: {
            serviceName: "ScheduledRunnerService",
            serviceInstanceId: "runner-1",
            revision: 2,
            manifestHash: "runner-manifest-v2",
            publishedAt: "2026-03-30T12:00:00.000Z",
            tasks: [],
            signals: [],
            intents: [],
            actors: [],
            routines: [],
            directionalTaskMaps: [],
            signalToTaskMaps: [],
            intentToTaskMaps: [],
            actorTaskMaps: [],
            taskToRoutineMaps: [],
          },
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(projectedInstances).toEqual([
      expect.objectContaining({
        uuid: "runner-1",
        service_name: "ScheduledRunnerService",
        transports: [
          expect.objectContaining({
            uuid: "runner-transport-1",
            origin: "http://scheduled-runner:3002",
          }),
        ],
      }),
    ]);
    expect(projectedManifestUpdates).toEqual([
      expect.objectContaining({
        serviceName: "ScheduledRunnerService",
        serviceInstanceId: "runner-1",
        revision: 2,
        manifestHash: "runner-manifest-v2",
      }),
    ]);
  });

  it("registers the authority-local same-origin reconciliation flow", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    for (const taskName of [
      "Insert service_instance",
      "Query service_instance",
      "Query service_instance_transport",
      "Insert service_instance_transport",
      "Update service_instance",
      "Update service_instance_transport",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    const insertServiceInstanceTask = FreshCadenza.get(
      "Insert service_instance",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const insertServiceInstanceTransportTask = FreshCadenza.get(
      "Insert service_instance_transport",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const updateServiceInstanceTransportTask = FreshCadenza.get(
      "Update service_instance_transport",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;

    expect(
      FreshCadenza.get("Prepare service instance origin reconciliation lookup"),
    ).toBeTruthy();
    expect(
      FreshCadenza.get(
        "Prepare service instance origin reconciliation seed transport query",
      ),
    ).toBeTruthy();
    expect(
      FreshCadenza.get("Emit service instance origin reconciliation requests"),
    ).toBeTruthy();
    expect(
      Array.from(insertServiceInstanceTask?.nextTasks ?? []).some(
        (task) =>
          task.name ===
          "Prepare service instance origin reconciliation seed transport query",
      ),
    ).toBe(true);
    expect(
      Array.from(insertServiceInstanceTransportTask?.nextTasks ?? []).some(
        (task) =>
          task.name === "Prepare service instance origin reconciliation lookup",
      ),
    ).toBe(true);
    expect(
      Array.from(updateServiceInstanceTransportTask?.nextTasks ?? []).some(
        (task) =>
          task.name === "Prepare service instance origin reconciliation lookup",
      ),
    ).toBe(true);
  });

  it("does not seed same-origin reconciliation from routine lifecycle updates", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    for (const taskName of [
      "Insert service_instance",
      "Query service_instance",
      "Query service_instance_transport",
      "Insert service_instance_transport",
      "Update service_instance",
      "Update service_instance_transport",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    const reconciliationSeedTask = FreshCadenza.get(
      "Prepare service instance origin reconciliation seed transport query",
    ) as { observedSignals?: Set<string> } | undefined;

    expect(reconciliationSeedTask?.observedSignals.has("global.meta.service_instance.updated")).toBe(
      false,
    );
  });

  it("ignores bootstrap placeholder transport ids in origin reconciliation lookup", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    for (const taskName of [
      "Insert service_instance",
      "Query service_instance",
      "Query service_instance_transport",
      "Insert service_instance_transport",
      "Update service_instance",
      "Update service_instance_transport",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    const lookupTask = FreshCadenza.get(
      "Prepare service instance origin reconciliation lookup",
    );

    expect(lookupTask).toBeTruthy();
    expect(
      FreshCadenza.run(lookupTask!, {
        __transportId: "cadenza-db-internal-bootstrap",
        serviceName: "CadenzaDB",
      }),
    ).toBeFalsy();
  });

  it("registers the authority same-origin canonicalization sweep", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    for (const taskName of [
      "Insert service_instance",
      "Query service_instance",
      "Query service_instance_transport",
      "Insert service_instance_transport",
      "Update service_instance",
      "Update service_instance_transport",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);
    const scheduleSpy = vi
      .spyOn(FreshCadenza, "schedule")
      .mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    const requestSweepTask = FreshCadenza.get(
      "Request service instance origin canonicalization sweep",
    ) as { observedSignals?: Set<string> } | undefined;
    const localServiceInstanceInsertTask = FreshCadenza.get(
      "Insert service_instance",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const localServiceInstanceTransportInsertTask = FreshCadenza.get(
      "Insert service_instance_transport",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const executeSweepTask = FreshCadenza.get(
      "Execute service instance origin canonicalization sweep",
    ) as { observedSignals?: Set<string>; nextTasks?: Set<{ name: string }> } | undefined;
    const instanceQueryTask = FreshCadenza.get(
      "Prepare service instance origin canonicalization instance query",
    ) as { observedSignals?: Set<string> } | undefined;
    const transportQueryTask = FreshCadenza.get(
      "Prepare service instance origin canonicalization transport query",
    ) as { observedSignals?: Set<string> } | undefined;
    const normalizeInstanceRowsTask = FreshCadenza.get(
      "Normalize service instance origin canonicalization instance rows",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const normalizeTransportRowsTask = FreshCadenza.get(
      "Normalize service instance origin canonicalization transport rows",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const canonicalizeTask = FreshCadenza.get(
      "Canonicalize service instance origins",
    ) as { name: string } | undefined;
    const splitInstanceRetirementsTask = FreshCadenza.get(
      "Split superseded same-origin service instance retirements",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const splitTransportRetirementsTask = FreshCadenza.get(
      "Split superseded same-origin service transport retirements",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;

    expect(requestSweepTask).toBeTruthy();
    expect(requestSweepTask?.observedSignals.has("global.meta.sync_controller.synced")).toBe(
      true,
    );
    expect(
      requestSweepTask?.observedSignals.has("global.meta.service_instance.created"),
    ).toBe(true);
    expect(
      requestSweepTask?.observedSignals.has(
        "global.meta.service_instance_transport.created",
      ),
    ).toBe(true);
    expect(
      requestSweepTask?.observedSignals.has(
        "global.meta.service_registry.transport_registered",
      ),
    ).toBe(true);
    expect(
      requestSweepTask?.observedSignals.has(
        "global.meta.service_registry.instance_registered",
      ),
    ).toBe(true);
    expect(
      requestSweepTask?.observedSignals.has(
        "meta.cadenza_db.canonicalize_service_instance_origins_requested",
      ),
    ).toBe(true);
    expect(
      Array.from(localServiceInstanceInsertTask?.nextTasks ?? []).some(
        (task) =>
          task.name ===
          "Request service instance origin canonicalization sweep",
      ),
    ).toBe(true);
    expect(
      Array.from(localServiceInstanceTransportInsertTask?.nextTasks ?? []).some(
        (task) =>
          task.name ===
          "Request service instance origin canonicalization sweep",
      ),
    ).toBe(true);
    expect(
      Array.from(localServiceInstanceInsertTask?.nextTasks ?? []).some(
        (task) =>
          task.name ===
          "Execute service instance origin canonicalization sweep",
      ),
    ).toBe(true);
    expect(
      Array.from(localServiceInstanceTransportInsertTask?.nextTasks ?? []).some(
        (task) =>
          task.name ===
          "Execute service instance origin canonicalization sweep",
      ),
    ).toBe(true);
    expect(executeSweepTask).toBeTruthy();
    expect(
      executeSweepTask?.observedSignals?.has(
        "meta.cadenza_db.canonicalize_service_instance_origins_execute",
      ),
    ).toBe(true);
    expect(
      Array.from(executeSweepTask?.nextTasks ?? []).some(
        (task) =>
          task.name ===
          "Prepare service instance origin canonicalization instance query",
      ),
    ).toBe(true);
    expect(instanceQueryTask).toBeTruthy();
    expect(transportQueryTask).toBeTruthy();
    expect(normalizeInstanceRowsTask).toBeTruthy();
    expect(normalizeTransportRowsTask).toBeTruthy();
    expect(
      Array.from(normalizeInstanceRowsTask?.nextTasks ?? []).some(
        (task) =>
          task.name ===
          "Prepare service instance origin canonicalization transport query",
      ),
    ).toBe(true);
    expect(
      Array.from(normalizeTransportRowsTask?.nextTasks ?? []).some(
        (task) => task.name === "Canonicalize service instance origins",
      ),
    ).toBe(true);
    expect(canonicalizeTask).toBeTruthy();
    expect(
      Array.from((canonicalizeTask as any)?.nextTasks ?? []).some(
        (task: { name: string }) =>
          task.name ===
          "Split superseded same-origin service instance retirements",
      ),
    ).toBe(true);
    expect(
      Array.from((canonicalizeTask as any)?.nextTasks ?? []).some(
        (task: { name: string }) =>
          task.name ===
          "Split superseded same-origin service transport retirements",
      ),
    ).toBe(true);
    expect(
      Array.from(splitInstanceRetirementsTask?.nextTasks ?? []).some(
        (task) => task.name === "Update service_instance",
      ),
    ).toBe(true);
    expect(
      Array.from(splitTransportRetirementsTask?.nextTasks ?? []).some(
        (task) => task.name === "Update service_instance_transport",
      ),
    ).toBe(true);
    expect(scheduleSpy.mock.calls).toEqual(
      expect.arrayContaining([
      [
        "meta.cadenza_db.canonicalize_service_instance_origins_requested",
        {
          __attempt: 1,
          __reason: "cadenza_db_startup",
        },
        250,
      ],
      [
        "meta.cadenza_db.canonicalize_service_instance_origins_requested",
        {
          __attempt: 2,
          __reason: "cadenza_db_startup",
        },
        1500,
      ],
      [
        "meta.cadenza_db.canonicalize_service_instance_origins_requested",
        {
          __attempt: 3,
          __reason: "cadenza_db_startup",
        },
        5000,
      ],
      [
        "meta.cadenza_db.canonicalize_service_instance_origins_requested",
        {
          __attempt: 4,
          __reason: "cadenza_db_startup",
        },
        15000,
      ],
      [
        "meta.cadenza_db.canonicalize_service_instance_origins_requested",
        {
          __attempt: 5,
          __reason: "cadenza_db_startup",
        },
        30000,
      ],
      ]),
    );
  });

  it("passes top-level filter and data into same-origin retirement updates", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;
    for (const taskName of [
      "Insert service_instance",
      "Query service_instance",
      "Query service_instance_transport",
      "Insert service_instance_transport",
      "Update service_instance",
      "Update service_instance_transport",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);
    vi.spyOn(FreshCadenza, "schedule").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    const retireInstanceTask = FreshCadenza.get(
      "Retire superseded same-origin service instance",
    ) as { taskFunction?: (ctx: Record<string, unknown>) => Record<string, unknown> } | undefined;
    const deleteTransportTask = FreshCadenza.get(
      "Delete superseded same-origin service transport",
    ) as { taskFunction?: (ctx: Record<string, unknown>) => Record<string, unknown> } | undefined;

    expect(retireInstanceTask).toBeTruthy();
    expect(deleteTransportTask).toBeTruthy();

    const retiredInstanceContext = retireInstanceTask?.taskFunction?.({
      queryData: {
        filter: {
          uuid: "db-old",
        },
      },
    });
    const retiredTransportContext = deleteTransportTask?.taskFunction?.({
      queryData: {
        filter: {
          uuid: "transport-old",
        },
      },
    });

    expect(retiredInstanceContext).toEqual(
      expect.objectContaining({
        filter: { uuid: "db-old" },
        data: {
          is_active: false,
          is_non_responsive: false,
          deleted: false,
        },
        queryData: {
          filter: { uuid: "db-old" },
          data: {
            is_active: false,
            is_non_responsive: false,
            deleted: false,
          },
        },
      }),
    );
    expect(retiredTransportContext).toEqual(
      expect.objectContaining({
        filter: { uuid: "transport-old" },
        data: { deleted: true },
        queryData: {
          filter: { uuid: "transport-old" },
          data: { deleted: true },
        },
      }),
    );
  });

  it("registers the authority service manifest report responder", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    for (const taskName of [
      "Insert service_manifest",
      "Query service_instance",
      "Query service_instance_transport",
      "Query service_manifest",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    const observer = FreshCadenza.inquiryBroker.inquiryObservers.get(
      AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT,
    );

    expect(observer).toBeTruthy();
    expect(
      Array.from(observer?.tasks ?? []).some(
        (task) => task.name === "Report service manifest to authority",
      ),
    ).toBe(true);
  });

  it("registers the authority service manifest report responder after local insert tasks appear", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    for (const taskName of [
      "Query service_instance",
      "Query service_instance_transport",
      "Query service_manifest",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    expect(
      FreshCadenza.inquiryBroker.inquiryObservers.get(
        AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT,
      ),
    ).toBeFalsy();

    FreshCadenza.createMetaTask("Insert service_manifest", () => ({}));
    FreshCadenza.emit("meta.service_registry.instance_inserted", {});

    await new Promise((resolve) => setTimeout(resolve, 10));

    const observer = FreshCadenza.inquiryBroker.inquiryObservers.get(
      AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT,
    );
    expect(observer).toBeTruthy();
    expect(
      Array.from(observer?.tasks ?? []).some(
        (task) => task.name === "Report service manifest to authority",
      ),
    ).toBe(true);
  });

  it("passes prepared manifest rows into the local authority insert task", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    let capturedInsertContext: Record<string, any> | null = null;
    let capturedManifestUpdate: Record<string, any> | null = null;

    for (const taskName of [
      "Query service_instance",
      "Query service_instance_transport",
      "Query service_manifest",
    ]) {
      FreshCadenza.createMetaTask(taskName, () => ({}));
    }

    FreshCadenza.createMetaTask("Insert service_manifest", (ctx) => {
      capturedInsertContext = ctx as Record<string, any>;
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Capture manifest update signal", (ctx) => {
      capturedManifestUpdate = ctx as Record<string, any>;
      return true;
    }).doOn(AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL);

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    await FreshCadenza.inquire(AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT, {
      serviceName: "OrdersService",
      serviceInstanceId: "7c73db27-943c-40b6-9565-b92be77a02ce",
      revision: 1,
      manifestHash: "m-test",
      publishedAt: "2026-03-29T12:00:00.000Z",
      tasks: [],
      signals: [],
      intents: [],
      actors: [],
      routines: [],
      directionalTaskMaps: [],
      signalTaskMaps: [],
      intentTaskMaps: [],
      actorTaskMaps: [],
      taskRoutineMaps: [],
    });

    expect(capturedInsertContext).toBeTruthy();
    expect(capturedInsertContext?.data).toMatchObject({
      service_instance_id: "7c73db27-943c-40b6-9565-b92be77a02ce",
      service_name: "OrdersService",
      revision: 1,
      manifest_hash: "m-test",
      published_at: "2026-03-29T12:00:00.000Z",
    });
    expect(capturedInsertContext?.queryData?.data).toMatchObject({
      service_instance_id: "7c73db27-943c-40b6-9565-b92be77a02ce",
      service_name: "OrdersService",
    });
    expect(capturedManifestUpdate).toMatchObject({
      serviceName: "OrdersService",
      serviceInstanceId: "7c73db27-943c-40b6-9565-b92be77a02ce",
      revision: 1,
      manifestHash: "m-test",
      publishedAt: "2026-03-29T12:00:00.000Z",
    });
  });
});
