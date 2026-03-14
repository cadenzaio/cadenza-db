import { afterEach, describe, expect, it, vi } from "vitest";

import Cadenza from "@cadenza.io/service";
import { resolveLocalServiceRegistrySyncTasks } from "../src/index";

describe("local CadenzaDB sync task resolution", () => {
  afterEach(() => {
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
});
