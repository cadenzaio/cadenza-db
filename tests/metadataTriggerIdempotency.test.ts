import { afterEach, describe, expect, it, vi } from "vitest";

describe("CadenzaDB metadata trigger idempotency", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    try {
      const serviceModule = await import("@cadenza.io/service");
      serviceModule.default.reset();
    } catch {
      // Ignore resets before bootstrap in the test harness.
    }
  });

  it("keeps direct insert triggers only for non-manifest-backed tables", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const Cadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const CadenzaDB = dbModule.default;

    let capturedSchema: any = null;

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      ((_: string, schema: any) => {
        capturedSchema = schema;
        return undefined;
      }) as any,
    );

    CadenzaDB.createCadenzaDBService();

    expect(capturedSchema).toBeTruthy();
    expect(capturedSchema.tables.service.customSignals.triggers.insert).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "meta.create_service_requested",
          queryData: expect.objectContaining({
            onConflict: expect.objectContaining({
              target: ["name"],
              action: expect.objectContaining({
                do: "nothing",
              }),
            }),
          }),
        }),
      ]),
    );
    expect(capturedSchema.tables.signal_registry.fields.delivery_mode).toEqual(
      expect.objectContaining({
        type: "varchar",
        default: "single",
      }),
    );
    expect(capturedSchema.tables.signal_registry.fields.broadcast_filter).toEqual(
      expect.objectContaining({
        type: "jsonb",
        default: null,
      }),
    );
    expect(
      capturedSchema.tables.database_service.customSignals.triggers.insert,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "global.meta.created_database_service",
          queryData: expect.objectContaining({
            onConflict: expect.objectContaining({
              target: ["service_name"],
            }),
          }),
        }),
      ]),
    );
    for (const tableName of [
      "task",
      "signal_registry",
      "signal_to_task_map",
      "intent_registry",
      "intent_to_task_map",
      "actor",
      "actor_task_map",
      "directional_task_graph_map",
      "routine",
      "task_to_routine_map",
    ]) {
      expect(capturedSchema.tables[tableName].customSignals).toBeUndefined();
    }
  });

  it("does not expose legacy table-level full-sync query intents", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const Cadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const CadenzaDB = dbModule.default;

    let capturedSchema: any = null;

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      ((_: string, schema: any) => {
        capturedSchema = schema;
        return undefined;
      }) as any,
    );

    CadenzaDB.createCadenzaDBService();

    expect(capturedSchema).toBeTruthy();

    for (const tableName of [
      "service_instance",
      "service_instance_transport",
      "signal_to_task_map",
      "intent_to_task_map",
    ]) {
      const queryIntents = capturedSchema.tables[tableName].customIntents?.query ?? [];
      expect(queryIntents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            intent: "meta-service-registry-full-sync",
          }),
        ]),
      );
    }
  });

  it("does not expose direct execution-observability custom signal triggers", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const Cadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const CadenzaDB = dbModule.default;

    let capturedSchema: any = null;

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      ((_: string, schema: any) => {
        capturedSchema = schema;
        return undefined;
      }) as any,
    );

    CadenzaDB.createCadenzaDBService();

    expect(capturedSchema).toBeTruthy();

    for (const tableName of [
      "execution_trace",
      "routine_execution",
      "task_execution",
      "signal_emission",
      "inquiry",
    ]) {
      expect(capturedSchema.tables[tableName].customSignals).toBeUndefined();
    }
  });

  it("does not expose direct actor session state graph-metadata triggers", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const Cadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const CadenzaDB = dbModule.default;

    let capturedSchema: any = null;

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      ((_: string, schema: any) => {
        capturedSchema = schema;
        return undefined;
      }) as any,
    );

    CadenzaDB.createCadenzaDBService();

    expect(capturedSchema).toBeTruthy();
    expect(capturedSchema.tables.actor_session_state.customSignals).toBeUndefined();
  });

  it("does not expose a direct service communication insert trigger", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const Cadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const CadenzaDB = dbModule.default;

    let capturedSchema: any = null;

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      ((_: string, schema: any) => {
        capturedSchema = schema;
        return undefined;
      }) as any,
    );

    CadenzaDB.createCadenzaDBService();

    expect(capturedSchema).toBeTruthy();
    expect(
      capturedSchema.tables.service_to_service_communication_map.customSignals,
    ).toBeUndefined();
  });

  it("removes routine_version from routine_execution and defines the drop migration", async () => {
    vi.resetModules();

    const serviceModule = await import("@cadenza.io/service");
    const Cadenza = serviceModule.default;
    const dbModule = await import("../src/index");
    const CadenzaDB = dbModule.default;

    let capturedSchema: any = null;

    vi.spyOn(Cadenza, "createMetaDatabaseService").mockImplementation(
      ((_: string, schema: any) => {
        capturedSchema = schema;
        return undefined;
      }) as any,
    );

    CadenzaDB.createCadenzaDBService();

    expect(capturedSchema).toBeTruthy();
    expect(capturedSchema.version).toBe(5);
    expect(capturedSchema.migrationPolicy).toEqual(
      expect.objectContaining({
        adoptExistingVersion: 1,
        allowDestructive: true,
      }),
    );
    expect(capturedSchema.tables.routine_execution.fields.routine_version).toBeUndefined();
    expect(
      capturedSchema.tables.task_execution.fields.previous_task_execution_ids,
    ).toBeTruthy();
    expect(capturedSchema.tables.task_execution_map).toBeUndefined();
    expect(capturedSchema.tables.service_manifest).toBeTruthy();
    expect(
      capturedSchema.tables.service_manifest.fields.service_instance_id.references,
    ).toBeUndefined();
    expect(capturedSchema.tables.routine_execution.indexes).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          "service_instance_id",
          "service_name",
          "execution_trace_id",
        ]),
      ]),
    );
    expect(capturedSchema.migrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: 2,
          name: "drop-routine-execution-routine-version",
          steps: [
            expect.objectContaining({
              kind: "dropColumn",
              table: "routine_execution",
              column: "routine_version",
              ifExists: true,
            }),
          ],
        }),
        expect.objectContaining({
          version: 4,
          name: "drop-service-manifest-service-instance-fk",
          steps: [
            expect.objectContaining({
              kind: "dropConstraint",
              table: "service_manifest",
              name: "service_manifest_service_instance_id_fkey",
              ifExists: true,
            }),
          ],
        }),
        expect.objectContaining({
          version: 5,
          name: "widen-structural-name-columns",
        }),
      ]),
    );
  });
});
