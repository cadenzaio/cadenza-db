import { afterEach, describe, expect, it, vi } from "vitest";

import Cadenza from "@cadenza.io/service";
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
      intent_to_task_map: { name: "Query intent_to_task_map" },
      signal_to_task_map: { name: "Query signal_to_task_map" },
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
    expect(getTaskSpy).toHaveBeenCalledWith("Query intent_to_task_map");
    expect(getTaskSpy).toHaveBeenCalledWith("Query signal_to_task_map");
    expect(resolvedTasks).toMatchObject({
      queryServiceInstanceTask: tasksByTable.service_instance,
      queryServiceInstanceTransportTask: tasksByTable.service_instance_transport,
      queryIntentToTaskMapTask: tasksByTable.intent_to_task_map,
      querySignalToTaskMapTask: tasksByTable.signal_to_task_map,
    });
  });

  it("fails fast when a required local sync query task is missing", () => {
    vi.spyOn(Cadenza, "get").mockImplementation((taskName) =>
      taskName === "Query signal_to_task_map" ||
      taskName === "dbQuerySignalToTaskMap"
        ? undefined
        : ({ name: taskName } as any),
    );

    expect(() => resolveLocalServiceRegistrySyncTasks()).toThrow(
      /local sync query tasks are not available/i,
    );
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
    Cadenza.createMetaTask("Query intent_to_task_map", () => ({
      intentToTaskMaps: [],
      rowCount: 0,
    }));
    Cadenza.createMetaTask("Query signal_to_task_map", () => ({
      signalToTaskMaps: [],
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

    expect(emitSpy).toHaveBeenCalledWith(
      "meta.sync_requested",
      expect.objectContaining({
        __syncing: true,
        __reason: "cadenza_db_local_sync_tasks_created",
      }),
    );
  });
});
