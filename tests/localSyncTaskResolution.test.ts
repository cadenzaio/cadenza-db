import { afterEach, describe, expect, it, vi } from "vitest";

import Cadenza, {
  AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT,
  AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT,
  AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT,
  AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL,
} from "@cadenza.io/service";
import CadenzaDB, {
  collectProjectedManifestStructuralRowsFromManifestRows,
  resolveLocalServiceRegistrySyncTasks,
} from "../src/index";

describe("local CadenzaDB sync task resolution", () => {
  afterEach(async () => {
    try {
      Cadenza.reset();
    } catch {
      // Ignore resets before bootstrap in the test harness.
    }

    try {
      const serviceModule = await import("@cadenza.io/service");
      serviceModule.default.reset();
    } catch {
      // Ignore module reset failures while tearing down isolated module tests.
    }

    delete (globalThis as any).__CADENZA_RUNTIME__;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("uses the generated local CadenzaDB query task names", () => {
    const tasksByTable = {
      service_instance: { name: "Query service_instance" },
      service_instance_lease: { name: "Query service_instance_lease" },
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
    expect(getTaskSpy).toHaveBeenCalledWith("Query service_instance_lease");
    expect(getTaskSpy).toHaveBeenCalledWith("Query service_instance_transport");
    expect(getTaskSpy).toHaveBeenCalledWith("Query service_manifest");
    expect(resolvedTasks).toMatchObject({
      queryServiceInstanceTask: tasksByTable.service_instance,
      queryServiceInstanceLeaseTask: tasksByTable.service_instance_lease,
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
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    FreshCadenza.createMetaTask("Query service_instance", () => ({
      serviceInstances: [],
      rowCount: 0,
    }));
    FreshCadenza.createMetaTask("Query service_instance_transport", () => ({
      serviceInstanceTransports: [],
      rowCount: 0,
    }));
    FreshCadenza.createMetaTask("Query service_manifest", () => ({
      serviceManifests: [],
      rowCount: 0,
    }));

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    const emitSpy = vi.spyOn(FreshCadenza, "emit");

    FreshCadenzaDB.createCadenzaDBService();
    FreshCadenza.emit("global.meta.sync_controller.synced", {});

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
    FreshCadenza.createMetaTask("Query service_instance_lease", () => ({
      rows: [
        {
          service_instance_id: "runner-1",
          status: "active",
          is_ready: true,
          readiness_reason: "accepting_work",
          lease_expires_at: "2026-03-30T12:00:45.000Z",
          last_lease_renewed_at: "2026-03-30T12:00:00.000Z",
          last_ready_at: "2026-03-30T12:00:00.000Z",
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
      serviceInstanceLeases: [
        {
          service_instance_id: "runner-1",
          status: "active",
          is_ready: true,
          readiness_reason: "accepting_work",
          lease_expires_at: "2026-03-30T12:00:45.000Z",
          last_lease_renewed_at: "2026-03-30T12:00:00.000Z",
          last_ready_at: "2026-03-30T12:00:00.000Z",
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

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(projectedInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: "runner-1",
          service_name: "ScheduledRunnerService",
          lease_status: "active",
          is_ready: true,
          transports: [
            expect.objectContaining({
              uuid: "runner-transport-1",
              origin: "http://scheduled-runner:3002",
            }),
          ],
        }),
      ]),
    );
    expect(
      projectedInstances.every((instance) => instance.uuid === "runner-1"),
    ).toBe(true);
    expect(projectedManifestUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "ScheduledRunnerService",
          serviceInstanceId: "runner-1",
          revision: 2,
          manifestHash: "runner-manifest-v2",
        }),
      ]),
    );
    expect(
      projectedManifestUpdates.every(
        (update) => update.serviceInstanceId === "runner-1",
      ),
    ).toBe(true);
  });

  it("wires authority registry replay through normalize and collect tasks before projection", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    FreshCadenza.createMetaTask("Query service_instance", () => ({
      rows: [
        {
          uuid: "predictor-1",
          service_name: "PredictorService",
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
          uuid: "predictor-transport-1",
          service_instance_id: "predictor-1",
          role: "internal",
          origin: "http://predictor:3005",
          protocols: ["rest"],
          deleted: false,
        },
      ],
      rowCount: 1,
    }));
    FreshCadenza.createMetaTask("Query service_manifest", () => ({
      rows: [
        {
          service_instance_id: "predictor-1",
          manifest: {
            serviceName: "PredictorService",
            serviceInstanceId: "predictor-1",
            revision: 2,
            manifestHash: "predictor-manifest-v2",
            publishedAt: "2026-03-30T12:00:00.000Z",
            tasks: [
              {
                name: "Compute prediction",
                version: 1,
                service_name: "PredictorService",
                display_name: "Compute prediction",
                description: "Computes a device prediction.",
                is_meta: false,
              },
            ],
            signals: [
              {
                name: "predictor_service.ready",
                action: "ready",
                domain: "predictor_service",
                is_meta: false,
                is_global: false,
                delivery_mode: "single",
              },
            ],
            intents: [
              {
                name: "iot-prediction-compute",
                input: { type: "object" },
                output: { type: "object" },
                is_meta: false,
                description: "",
              },
            ],
            actors: [
              {
                name: "PredictionSessionActor",
                version: 1,
                service_name: "PredictorService",
                default_key: "device:unknown",
                description: "Durable predictor session state.",
                load_policy: "eager",
                write_contract: "overwrite",
                runtime_read_guard: "none",
                consistency_profile: null,
                key_definition: null,
                state_definition: { durable: { initState: {} } },
                retry_policy: {},
                idempotency_policy: {},
                session_policy: { persistDurableState: true },
                is_meta: false,
              },
            ],
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

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    const executeTask = FreshCadenza.get(
      "Execute authority registry projection replay",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const requestTask = FreshCadenza.get(
      "Request authority registry projection replay",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const queryServiceInstanceTask = FreshCadenza.get(
      "Query service_instance",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const queryServiceInstanceTransportTask = FreshCadenza.get(
      "Query service_instance_transport",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const queryServiceManifestTask = FreshCadenza.get(
      "Query service_manifest",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const normalizeInstancesTask = FreshCadenza.get(
      "Normalize projected authority service instances",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const normalizeTransportsTask = FreshCadenza.get(
      "Normalize projected authority service instance transports",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const normalizeManifestsTask = FreshCadenza.get(
      "Normalize projected authority service manifests",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const collectTask = FreshCadenza.get(
      "Collect authority registry projection replay",
    ) as { nextTasks?: Set<{ name: string }> } | undefined;
    const projectTask = FreshCadenza.get(
      "Project persisted authority registry state",
    ) as { name: string } | undefined;

    expect(executeTask).toBeTruthy();
    expect(requestTask).toBeTruthy();
    expect(collectTask).toBeTruthy();
    expect(projectTask).toBeTruthy();
    expect(
      Array.from(requestTask?.nextTasks ?? []).map((task) => task.name),
    ).toContain("Execute authority registry projection replay");
    expect(
      Array.from(executeTask?.nextTasks ?? []).map((task) => task.name),
    ).toEqual(
      expect.arrayContaining([
        "Query service_instance",
        "Query service_instance_transport",
        "Query service_manifest",
      ]),
    );
    expect(
      Array.from(queryServiceInstanceTask?.nextTasks ?? []).map(
        (task) => task.name,
      ),
    ).toContain("Normalize projected authority service instances");
    expect(
      Array.from(queryServiceInstanceTransportTask?.nextTasks ?? []).map(
        (task) => task.name,
      ),
    ).toContain("Normalize projected authority service instance transports");
    expect(
      Array.from(queryServiceManifestTask?.nextTasks ?? []).map(
        (task) => task.name,
      ),
    ).toContain("Normalize projected authority service manifests");
    expect(
      Array.from(normalizeInstancesTask?.nextTasks ?? []).map(
        (task) => task.name,
      ),
    ).toContain("Collect authority registry projection replay");
    expect(
      Array.from(normalizeTransportsTask?.nextTasks ?? []).map(
        (task) => task.name,
      ),
    ).toContain("Collect authority registry projection replay");
    expect(
      Array.from(normalizeManifestsTask?.nextTasks ?? []).map(
        (task) => task.name,
      ),
    ).toContain("Collect authority registry projection replay");
    expect(
      Array.from(collectTask?.nextTasks ?? []).map((task) => task.name),
    ).toContain("Project persisted authority registry state");
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
    FreshCadenza.emit("meta.task.created", {
      data: {
        name: "Insert service_manifest",
      },
    });
    FreshCadenza.emit("global.meta.sync_controller.synced", {
      __reason: "test_manifest_flow_late_task_registration",
    });
    const ensureTask = FreshCadenza.get(
      "Ensure authority service manifest flow is registered",
    );

    expect(ensureTask).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 150));

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

  it("collects latest manifest structural rows for manifest entities and maps", () => {
    const projectedRows = collectProjectedManifestStructuralRowsFromManifestRows({
      serviceName: "TelemetryCollectorService",
      serviceManifests: [
        {
          manifest: {
            serviceName: "TelemetryCollectorService",
            serviceInstanceId: "telemetry-instance-old",
            revision: 1,
            manifestHash: "telemetry-v1",
            publishedAt: "2026-04-09T10:00:00.000Z",
            tasks: [
              {
                name: "Record telemetry ingest session state",
                version: 1,
                service_name: "TelemetryCollectorService",
                display_name: "Record telemetry ingest session state",
                description: "old task",
                is_meta: false,
              },
            ],
            signals: [
              {
                name: "global.iot.telemetry.ingested",
                is_global: true,
                domain: "iot.telemetry",
                action: "ingested",
                is_meta: false,
              },
            ],
            intents: [
              {
                name: "iot-telemetry-session-get",
                description: "old intent",
                input: { type: "object" },
                output: { type: "object" },
                is_meta: false,
              },
            ],
            actors: [
              {
                name: "TelemetrySessionActor",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "old",
                default_key: "device:unknown",
                load_policy: "eager",
                write_contract: "overwrite",
                runtime_read_guard: "none",
                consistency_profile: null,
                key_definition: null,
                state_definition: {},
                retry_policy: {},
                idempotency_policy: {},
                session_policy: { persistDurableState: true },
                is_meta: false,
              },
            ],
            routines: [
              {
                name: "Telemetry ingest routine",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "old routine",
                is_meta: false,
              },
            ],
            directionalTaskMaps: [
              {
                task_name: "Get telemetry session state",
                predecessor_task_name: "Record telemetry ingest session state",
                task_version: 1,
                predecessor_task_version: 1,
                service_name: "TelemetryCollectorService",
                predecessor_service_name: "TelemetryCollectorService",
              },
            ],
            signalToTaskMaps: [],
            intentToTaskMaps: [],
            actorTaskMaps: [],
            taskToRoutineMaps: [
              {
                routine_name: "Telemetry ingest routine",
                routine_version: 1,
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
              },
            ],
          },
        },
        {
          manifest: {
            serviceName: "TelemetryCollectorService",
            serviceInstanceId: "telemetry-instance-new",
            revision: 2,
            manifestHash: "telemetry-v2",
            publishedAt: "2026-04-09T10:05:00.000Z",
            tasks: [
              {
                name: "Record telemetry ingest session state",
                version: 1,
                service_name: "TelemetryCollectorService",
                display_name: "Record telemetry ingest session state",
                description: "new task",
                is_meta: false,
              },
              {
                name: "Get telemetry session state",
                version: 1,
                service_name: "TelemetryCollectorService",
                display_name: "Get telemetry session state",
                description: "read task",
                is_meta: false,
              },
            ],
            signals: [
              {
                name: "global.iot.telemetry.ingested",
                is_global: true,
                domain: "iot.telemetry",
                action: "ingested",
                is_meta: false,
              },
            ],
            intents: [
              {
                name: "iot-telemetry-session-get",
                description: "new intent",
                input: { type: "object" },
                output: { type: "object" },
                is_meta: false,
              },
            ],
            actors: [
              {
                name: "TelemetrySessionActor",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "new",
                default_key: "device:unknown",
                load_policy: "eager",
                write_contract: "overwrite",
                runtime_read_guard: "none",
                consistency_profile: null,
                key_definition: null,
                state_definition: {},
                retry_policy: {},
                idempotency_policy: {},
                session_policy: { persistDurableState: true },
                is_meta: false,
              },
              {
                name: "ServiceLifecycleFlushActor",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "flush",
                default_key: "service-lifecycle-flush-default",
                load_policy: "eager",
                write_contract: "overwrite",
                runtime_read_guard: "none",
                consistency_profile: null,
                key_definition: null,
                state_definition: {},
                retry_policy: {},
                idempotency_policy: {},
                session_policy: { enabled: true },
                is_meta: true,
              },
            ],
            routines: [
              {
                name: "Telemetry ingest routine",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "new routine",
                is_meta: false,
              },
            ],
            directionalTaskMaps: [
              {
                task_name: "Get telemetry session state",
                predecessor_task_name: "Record telemetry ingest session state",
                task_version: 1,
                predecessor_task_version: 1,
                service_name: "TelemetryCollectorService",
                predecessor_service_name: "TelemetryCollectorService",
              },
            ],
            signalToTaskMaps: [
              {
                signal_name: "global.iot.telemetry.ingested",
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
              },
            ],
            intentToTaskMaps: [
              {
                intent_name: "iot-telemetry-session-get",
                service_name: "TelemetryCollectorService",
                task_name: "Get telemetry session state",
                task_version: 1,
              },
            ],
            actorTaskMaps: [
              {
                actor_name: "TelemetrySessionActor",
                actor_version: 1,
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
                mode: "write",
                description: "Updates durable telemetry session actor.",
                is_meta: false,
              },
            ],
            taskToRoutineMaps: [
              {
                routine_name: "Telemetry ingest routine",
                routine_version: 1,
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
              },
            ],
          },
        },
      ],
    });

    expect(projectedRows.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Record telemetry ingest session state",
          service_name: "TelemetryCollectorService",
          description: "new task",
          function_string: "",
          flags: {},
          deleted: false,
        }),
        expect.objectContaining({
          name: "Get telemetry session state",
          service_name: "TelemetryCollectorService",
          function_string: "",
          flags: {},
          deleted: false,
        }),
      ]),
    );
    expect(projectedRows.signals).toEqual([
      expect.objectContaining({
        name: "global.iot.telemetry.ingested",
        deleted: false,
      }),
    ]);
    expect(projectedRows.intents).toEqual([
      expect.objectContaining({
        name: "iot-telemetry-session-get",
        description: "new intent",
        deleted: false,
      }),
    ]);
    expect(projectedRows.actors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "TelemetrySessionActor",
          service_name: "TelemetryCollectorService",
          description: "new",
          deleted: false,
        }),
        expect.objectContaining({
          name: "ServiceLifecycleFlushActor",
          service_name: "TelemetryCollectorService",
          is_meta: true,
          deleted: false,
        }),
      ]),
    );
    expect(projectedRows.routines).toEqual([
      expect.objectContaining({
        name: "Telemetry ingest routine",
        service_name: "TelemetryCollectorService",
        description: "new routine",
        deleted: false,
      }),
    ]);
    expect(projectedRows.directionalTaskMaps).toEqual([
      expect.objectContaining({
        task_name: "Get telemetry session state",
        predecessor_task_name: "Record telemetry ingest session state",
        service_name: "TelemetryCollectorService",
        predecessor_service_name: "TelemetryCollectorService",
        deleted: false,
      }),
    ]);
    expect(projectedRows.signalToTaskMaps).toEqual([
      expect.objectContaining({
        signal_name: "global.iot.telemetry.ingested",
        service_name: "TelemetryCollectorService",
        task_name: "Record telemetry ingest session state",
        deleted: false,
      }),
    ]);
    expect(projectedRows.intentToTaskMaps).toEqual([
      expect.objectContaining({
        intent_name: "iot-telemetry-session-get",
        service_name: "TelemetryCollectorService",
        task_name: "Get telemetry session state",
        deleted: false,
      }),
    ]);
    expect(projectedRows.actorTaskMaps).toEqual([
      expect.objectContaining({
        actor_name: "TelemetrySessionActor",
        service_name: "TelemetryCollectorService",
        task_name: "Record telemetry ingest session state",
        deleted: false,
      }),
    ]);
    expect(projectedRows.taskToRoutineMaps).toEqual([
      expect.objectContaining({
        routine_name: "Telemetry ingest routine",
        task_name: "Record telemetry ingest session state",
        service_name: "TelemetryCollectorService",
        deleted: false,
      }),
    ]);
  });

  it("replays manifest structural rows into local entity and map insert tasks", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    const capturedTaskInserts: Array<Record<string, any>> = [];
    const capturedSignalInserts: Array<Record<string, any>> = [];
    const capturedIntentInserts: Array<Record<string, any>> = [];
    const capturedActorInserts: Array<Record<string, any>> = [];
    const capturedRoutineInserts: Array<Record<string, any>> = [];
    const capturedTaskRelationshipInserts: Array<Record<string, any>> = [];
    const capturedSignalMapInserts: Array<Record<string, any>> = [];
    const capturedIntentMapInserts: Array<Record<string, any>> = [];
    const capturedActorTaskMapInserts: Array<Record<string, any>> = [];
    const capturedTaskToRoutineMapInserts: Array<Record<string, any>> = [];
    const capturedProjectionRequests: Array<Record<string, any>> = [];
    const capturedAssociationRequests: Array<Record<string, any>> = [];

    FreshCadenza.createMetaTask("Query service_instance", () => ({ rows: [] }));
    FreshCadenza.createMetaTask("Query service_instance_transport", () => ({
      rows: [],
    }));
    FreshCadenza.createMetaTask("Query service_manifest", () => ({
      rows: [
        {
          service_instance_id: "telemetry-instance-1",
          manifest: {
            serviceName: "TelemetryCollectorService",
            serviceInstanceId: "telemetry-instance-1",
            revision: 1,
            manifestHash: "telemetry-v1",
            publishedAt: "2026-04-09T10:00:00.000Z",
            tasks: [
              {
                name: "Record telemetry ingest session state",
                version: 1,
                service_name: "TelemetryCollectorService",
                display_name: "Record telemetry ingest session state",
                description: "Persists ingest state.",
                is_meta: false,
              },
              {
                name: "Get telemetry session state",
                version: 1,
                service_name: "TelemetryCollectorService",
                display_name: "Get telemetry session state",
                description: "Reads ingest state.",
                is_meta: false,
              },
            ],
            signals: [
              {
                name: "global.iot.telemetry.ingested",
                is_global: true,
                domain: "iot.telemetry",
                action: "ingested",
                is_meta: false,
              },
            ],
            intents: [
              {
                name: "iot-telemetry-session-get",
                description: "Gets telemetry session state.",
                input: { type: "object" },
                output: { type: "object" },
                is_meta: false,
              },
            ],
            actors: [
              {
                name: "TelemetrySessionActor",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "telemetry actor",
                default_key: "device:unknown",
                load_policy: "eager",
                write_contract: "overwrite",
                runtime_read_guard: "none",
                consistency_profile: null,
                key_definition: null,
                state_definition: {},
                retry_policy: {},
                idempotency_policy: {},
                session_policy: { persistDurableState: true },
                is_meta: false,
              },
            ],
            routines: [
              {
                name: "Telemetry ingest routine",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "Runs telemetry ingest flow.",
                is_meta: false,
              },
            ],
            directionalTaskMaps: [
              {
                task_name: "Get telemetry session state",
                predecessor_task_name: "Record telemetry ingest session state",
                task_version: 1,
                predecessor_task_version: 1,
                service_name: "TelemetryCollectorService",
                predecessor_service_name: "TelemetryCollectorService",
              },
            ],
            signalToTaskMaps: [
              {
                signal_name: "global.iot.telemetry.ingested",
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
              },
            ],
            intentToTaskMaps: [
              {
                intent_name: "iot-telemetry-session-get",
                service_name: "TelemetryCollectorService",
                task_name: "Get telemetry session state",
                task_version: 1,
              },
            ],
            actorTaskMaps: [
              {
                actor_name: "TelemetrySessionActor",
                actor_version: 1,
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
                mode: "write",
                description: "Updates durable telemetry session actor.",
                is_meta: false,
              },
            ],
            taskToRoutineMaps: [
              {
                routine_name: "Telemetry ingest routine",
                routine_version: 1,
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
              },
            ],
          },
        },
      ],
    }));

    FreshCadenza.createMetaTask("Insert task", (ctx) => {
      capturedTaskInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert signal_registry", (ctx) => {
      capturedSignalInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert intent_registry", (ctx) => {
      capturedIntentInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert actor", (ctx) => {
      capturedActorInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert routine", (ctx) => {
      capturedRoutineInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert directional_task_graph_map", (ctx) => {
      capturedTaskRelationshipInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert signal_to_task_map", (ctx) => {
      capturedSignalMapInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert intent_to_task_map", (ctx) => {
      capturedIntentMapInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert actor_task_map", (ctx) => {
      capturedActorTaskMapInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask("Insert task_to_routine_map", (ctx) => {
      capturedTaskToRoutineMapInserts.push(ctx as Record<string, any>);
      return { rowCount: 1, __success: true };
    });
    FreshCadenza.createMetaTask(
      "Capture manifest entity projection request",
      (ctx) => {
        capturedProjectionRequests.push(ctx as Record<string, any>);
        return true;
      },
    ).doOn("meta.cadenza_db.manifest_entity_projection_requested");
    FreshCadenza.createMetaTask(
      "Capture manifest association projection request",
      (ctx) => {
        capturedAssociationRequests.push(ctx as Record<string, any>);
        return true;
      },
    ).doOn("meta.cadenza_db.manifest_association_projection_requested");

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);
    FreshCadenzaDB.createCadenzaDBService();

    const ensureTask = FreshCadenza.get(
      "Ensure authority manifest structural projection flow is registered",
    );
    expect(ensureTask).toBeTruthy();
    expect(
      FreshCadenza.get("Prepare manifest task projection insert"),
    ).toBeTruthy();
    expect(
      FreshCadenza.get("Prepare manifest signal task map projection insert"),
    ).toBeTruthy();
    const projectTask = FreshCadenza.get(
      "Project persisted authority registry state",
    );
    expect(projectTask).toBeTruthy();

    FreshCadenza.run(projectTask!, {
      serviceInstances: [],
      serviceInstanceTransports: [],
      serviceManifests: [
        {
          service_instance_id: "telemetry-instance-1",
          manifest: {
            serviceName: "TelemetryCollectorService",
            serviceInstanceId: "telemetry-instance-1",
            revision: 1,
            manifestHash: "telemetry-v1",
            publishedAt: "2026-04-09T10:00:00.000Z",
            tasks: [
              {
                name: "Record telemetry ingest session state",
                version: 1,
                service_name: "TelemetryCollectorService",
                display_name: "Record telemetry ingest session state",
                description: "Persists ingest state.",
                is_meta: false,
              },
              {
                name: "Get telemetry session state",
                version: 1,
                service_name: "TelemetryCollectorService",
                display_name: "Get telemetry session state",
                description: "Reads ingest state.",
                is_meta: false,
              },
            ],
            signals: [
              {
                name: "global.iot.telemetry.ingested",
                is_global: true,
                domain: "iot.telemetry",
                action: "ingested",
                is_meta: false,
              },
            ],
            intents: [
              {
                name: "iot-telemetry-session-get",
                description: "Gets telemetry session state.",
                input: { type: "object" },
                output: { type: "object" },
                is_meta: false,
              },
            ],
            actors: [
              {
                name: "TelemetrySessionActor",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "telemetry actor",
                default_key: "device:unknown",
                load_policy: "eager",
                write_contract: "overwrite",
                runtime_read_guard: "none",
                consistency_profile: null,
                key_definition: null,
                state_definition: {},
                retry_policy: {},
                idempotency_policy: {},
                session_policy: { persistDurableState: true },
                is_meta: false,
              },
            ],
            routines: [
              {
                name: "Telemetry ingest routine",
                version: 1,
                service_name: "TelemetryCollectorService",
                description: "Runs telemetry ingest flow.",
                is_meta: false,
              },
            ],
            directionalTaskMaps: [
              {
                task_name: "Get telemetry session state",
                predecessor_task_name: "Record telemetry ingest session state",
                task_version: 1,
                predecessor_task_version: 1,
                service_name: "TelemetryCollectorService",
                predecessor_service_name: "TelemetryCollectorService",
              },
            ],
            signalToTaskMaps: [
              {
                signal_name: "global.iot.telemetry.ingested",
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
              },
            ],
            intentToTaskMaps: [
              {
                intent_name: "iot-telemetry-session-get",
                service_name: "TelemetryCollectorService",
                task_name: "Get telemetry session state",
                task_version: 1,
              },
            ],
            actorTaskMaps: [
              {
                actor_name: "TelemetrySessionActor",
                actor_version: 1,
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
                mode: "write",
                description: "Updates durable telemetry session actor.",
                is_meta: false,
              },
            ],
            taskToRoutineMaps: [
              {
                routine_name: "Telemetry ingest routine",
                routine_version: 1,
                service_name: "TelemetryCollectorService",
                task_name: "Record telemetry ingest session state",
                task_version: 1,
              },
            ],
          },
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(capturedProjectionRequests.length).toBeGreaterThan(0);
    expect(capturedAssociationRequests.length).toBeGreaterThan(0);
    expect(capturedTaskInserts.length).toBeGreaterThan(0);
    expect(capturedSignalInserts.length).toBeGreaterThan(0);
    expect(capturedIntentInserts.length).toBeGreaterThan(0);
    expect(capturedActorInserts.length).toBeGreaterThan(0);
    expect(capturedRoutineInserts.length).toBeGreaterThan(0);
    expect(capturedTaskRelationshipInserts.length).toBeGreaterThan(0);
    expect(capturedTaskToRoutineMapInserts.length).toBeGreaterThan(0);
    expect(capturedTaskInserts[0]).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          name: "Record telemetry ingest session state",
          service_name: "TelemetryCollectorService",
          function_string: "",
          flags: {},
        }),
      ]),
    });
    expect(capturedTaskInserts[0]?.data?.[0]).not.toHaveProperty("display_name");
    expect(capturedTaskInserts[0]?.queryData?.data?.[0]).not.toHaveProperty(
      "display_name",
    );
    expect(capturedTaskInserts[0]?.queryData?.onConflict?.action?.set).toEqual(
      expect.objectContaining({
        function_string: "excluded",
        retry_count: "excluded",
        is_hidden: "excluded",
      }),
    );
    expect(
      capturedTaskInserts[0]?.queryData?.onConflict?.action?.set,
    ).not.toHaveProperty("display_name");
    expect(
      capturedTaskInserts[0]?.queryData?.onConflict?.action?.set,
    ).not.toHaveProperty("retry_attempts");
    expect(capturedSignalInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          name: "global.iot.telemetry.ingested",
        }),
      ],
    });
    expect(capturedIntentInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          name: "iot-telemetry-session-get",
        }),
      ],
    });
    expect(capturedActorInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          name: "TelemetrySessionActor",
          service_name: "TelemetryCollectorService",
        }),
      ],
      queryData: {
        data: [
          expect.objectContaining({
            name: "TelemetrySessionActor",
            service_name: "TelemetryCollectorService",
          }),
        ],
      },
    });
    expect(capturedRoutineInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          name: "Telemetry ingest routine",
          service_name: "TelemetryCollectorService",
        }),
      ],
    });
    expect(capturedTaskRelationshipInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          task_name: "Get telemetry session state",
          predecessor_task_name: "Record telemetry ingest session state",
        }),
      ],
    });

    expect(capturedSignalMapInserts).toHaveLength(1);
    expect(capturedSignalMapInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          signal_name: "global.iot.telemetry.ingested",
          service_name: "TelemetryCollectorService",
        }),
      ],
    });

    expect(capturedIntentMapInserts).toHaveLength(1);
    expect(capturedIntentMapInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          intent_name: "iot-telemetry-session-get",
          service_name: "TelemetryCollectorService",
        }),
      ],
    });

    expect(capturedActorTaskMapInserts).toHaveLength(1);
    expect(capturedActorTaskMapInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          actor_name: "TelemetrySessionActor",
          service_name: "TelemetryCollectorService",
        }),
      ],
    });
    expect(capturedTaskToRoutineMapInserts[0]).toMatchObject({
      data: [
        expect.objectContaining({
          routine_name: "Telemetry ingest routine",
          task_name: "Record telemetry ingest session state",
          service_name: "TelemetryCollectorService",
        }),
      ],
    });
  });

  it("registers the authority registry projection flow after local query tasks appear", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);
    vi.spyOn(FreshCadenza, "schedule").mockImplementation((() => undefined) as any);

    FreshCadenzaDB.createCadenzaDBService();

    FreshCadenza.createMetaTask("Query service_instance", () => ({ rows: [] }));
    FreshCadenza.createMetaTask("Query service_instance_transport", () => ({
      rows: [],
    }));
    FreshCadenza.createMetaTask("Query service_manifest", () => ({ rows: [] }));

    const ensureTask = FreshCadenza.get(
      "Ensure authority registry projection flow is registered",
    );
    expect(ensureTask).toBeTruthy();

    FreshCadenza.run(ensureTask!, {
      __reason: "test_late_registry_projection_registration",
    });

    expect(
      FreshCadenza.get("Execute authority registry projection replay"),
    ).toBeTruthy();
    expect(
      FreshCadenza.get("Collect authority registry projection replay"),
    ).toBeTruthy();
    expect(
      FreshCadenza.get("Project persisted authority registry state"),
    ).toBeTruthy();
  });

  it("retains authority registry projection identity when query branches drop replay context", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const FreshCadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const FreshCadenzaDB = dbModule.default;

    vi.spyOn(FreshCadenza, "createMetaDatabaseService").mockImplementation(
      (() => undefined) as any,
    );
    vi.spyOn(FreshCadenza, "interval").mockImplementation((() => undefined) as any);
    vi.spyOn(FreshCadenza, "schedule").mockImplementation((() => undefined) as any);

    FreshCadenza.createMetaTask("Query service_instance", () => ({
      rows: [{ uuid: "runner-1" }],
    }));
    FreshCadenza.createMetaTask("Query service_instance_transport", () => ({
      rows: [{ uuid: "transport-1", service_instance_id: "runner-1" }],
    }));
    FreshCadenza.createMetaTask("Query service_manifest", () => ({
      rows: [
        {
          service_instance_id: "runner-1",
          manifest: {
            serviceName: "ScheduledRunnerService",
            serviceInstanceId: "runner-1",
            revision: 1,
            manifestHash: "runner-manifest-v1",
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
    }));

    FreshCadenzaDB.createCadenzaDBService();
    FreshCadenza.run(
      FreshCadenza.get("Ensure authority registry projection flow is registered")!,
      {},
    );

    const requestTask = FreshCadenza.get("Request authority registry projection replay");
    const executeTask = FreshCadenza.get("Execute authority registry projection replay");
    const normalizeInstancesTask = FreshCadenza.get(
      "Normalize projected authority service instances",
    );
    const normalizeTransportsTask = FreshCadenza.get(
      "Normalize projected authority service instance transports",
    );
    const normalizeManifestsTask = FreshCadenza.get(
      "Normalize projected authority service manifests",
    );
    const collectTask = FreshCadenza.get("Collect authority registry projection replay");
    const projectTask = FreshCadenza.get("Project persisted authority registry state");

    expect(requestTask).toBeTruthy();
    expect(executeTask).toBeTruthy();
    expect(normalizeInstancesTask).toBeTruthy();
    expect(normalizeTransportsTask).toBeTruthy();
    expect(normalizeManifestsTask).toBeTruthy();
    expect(collectTask).toBeTruthy();
    expect(projectTask).toBeTruthy();

    const requestResult = (requestTask as any).taskFunction({
      __reason: "test_projection_id_fallback",
    }) as Record<string, unknown>;
    const requestedProjectionId = requestResult.__projectionId as string;

    const executeResult = (executeTask as any).taskFunction({
      __reason: "test_projection_id_fallback",
    }) as Record<string, unknown>;
    expect(executeResult.__projectionId).toBe(requestedProjectionId);

    const normalizedInstances = (normalizeInstancesTask as any).taskFunction({
      rows: [{ uuid: "runner-1" }],
    }) as Record<string, unknown>;
    const normalizedTransports = (normalizeTransportsTask as any).taskFunction({
      rows: [{ uuid: "transport-1", service_instance_id: "runner-1" }],
    }) as Record<string, unknown>;
    const normalizedManifests = (normalizeManifestsTask as any).taskFunction({
      rows: [
        {
          service_instance_id: "runner-1",
          manifest: {
            serviceName: "ScheduledRunnerService",
            serviceInstanceId: "runner-1",
            revision: 1,
            manifestHash: "runner-manifest-v1",
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
    }) as Record<string, unknown>;

    expect(normalizedInstances.__projectionId).toBe(requestedProjectionId);
    expect(normalizedTransports.__projectionId).toBe(requestedProjectionId);
    expect(normalizedManifests.__projectionId).toBe(requestedProjectionId);

    expect((collectTask as any).taskFunction(normalizedInstances)).toBe(false);
    expect((collectTask as any).taskFunction(normalizedTransports)).toBe(false);
    const collected = (collectTask as any).taskFunction(
      normalizedManifests,
    ) as Record<string, unknown>;

    expect(collected.__projectionId).toBe(requestedProjectionId);
    expect(collected.serviceInstances).toEqual([{ uuid: "runner-1" }]);
    expect(collected.serviceInstanceTransports).toEqual([
      { uuid: "transport-1", service_instance_id: "runner-1" },
    ]);
    expect(collected.serviceManifests).toHaveLength(1);

    const emittedSignals: Array<{ signal: string; payload: Record<string, unknown> }> = [];
    const projected = (projectTask as any).taskFunction(
      { __projectionId: requestedProjectionId },
      (signal: string, payload: Record<string, unknown>) => {
        emittedSignals.push({ signal, payload });
      },
    ) as Record<string, unknown>;

    expect(projected.projectedServiceInstances).toBe(1);
    expect(projected.projectedServiceInstanceTransports).toBe(1);
    expect(projected.projectedServiceManifests).toBe(1);
    expect(
      emittedSignals.some(
        ({ signal, payload }) =>
          signal === "global.meta.service_instance.updated" &&
          payload.serviceInstance?.uuid === "runner-1",
      ),
    ).toBe(true);
  });
});
