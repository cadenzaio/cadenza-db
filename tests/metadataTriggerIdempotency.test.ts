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

  it("adds do-nothing onConflict clauses to metadata insert triggers", async () => {
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
    expect(capturedSchema.tables.task.customSignals.triggers.insert).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "global.meta.graph_metadata.task_created",
          queryData: expect.objectContaining({
            onConflict: expect.objectContaining({
              target: ["name", "service_name", "version"],
              action: expect.objectContaining({
                do: "nothing",
              }),
            }),
          }),
        }),
      ]),
    );
    expect(
      capturedSchema.tables.signal_registry.customSignals.triggers.insert,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "global.meta.signal_controller.signal_added",
          queryData: expect.objectContaining({
            onConflict: expect.objectContaining({
              target: ["name"],
            }),
          }),
        }),
      ]),
    );
    expect(
      capturedSchema.tables.intent_to_task_map.customSignals.triggers.insert,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "global.meta.graph_metadata.task_intent_associated",
          queryData: expect.objectContaining({
            onConflict: expect.objectContaining({
              target: [
                "intent_name",
                "task_name",
                "task_version",
                "service_name",
              ],
            }),
          }),
        }),
      ]),
    );
  });
});
