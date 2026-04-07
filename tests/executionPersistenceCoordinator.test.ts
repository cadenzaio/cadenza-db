import { beforeEach, describe, expect, it, vi } from "vitest";

import Cadenza from "@cadenza.io/service";
import ExecutionPersistenceCoordinator, {
  EXECUTION_PERSISTENCE_BUNDLE_SIGNAL,
} from "../src/execution/ExecutionPersistenceCoordinator";

function resetRuntimeState() {
  try {
    Cadenza.reset();
  } catch {
    // Ignore first-run reset errors before bootstrap.
  }

  (ExecutionPersistenceCoordinator as any)._instance = undefined;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
  pollIntervalMs = 10,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Condition not met within timeout");
}

describe("ExecutionPersistenceCoordinator", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeState();
    Cadenza.bootstrap();
    Cadenza.serviceRegistry.serviceName = "CadenzaDB";
    Cadenza.serviceRegistry.serviceInstanceId = "cadenza-db-service-1";
  });

  it("persists ready ensure events in dependency order through local authority intents", async () => {
    const order: string[] = [];

    vi.spyOn(Cadenza, "inquire").mockImplementation(
      async (intentName: string, context: Record<string, any>) => {
        order.push(
          `${intentName}:${String(
            context?.queryData?.data?.uuid ??
              context?.queryData?.data?.taskExecutionId ??
              context?.queryData?.data?.task_execution_id ??
              "unknown",
          )}`,
        );
        return { __success: true, rowCount: 1 } as any;
      },
    );

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-1",
      ensures: [
        {
          kind: "ensure",
          entityType: "task_execution",
          entityId: "task-exec-1",
          data: {
            uuid: "task-exec-1",
            routineExecutionId: "routine-exec-1",
            executionTraceId: "trace-1",
            signalEmissionId: "signal-emission-1",
          },
          deps: [
            "routine_execution:routine-exec-1",
            "signal_emission:signal-emission-1",
            "execution_trace:trace-1",
          ],
        },
        {
          kind: "ensure",
          entityType: "signal_emission",
          entityId: "signal-emission-1",
          data: {
            uuid: "signal-emission-1",
            executionTraceId: "trace-1",
          },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "routine_execution",
          entityId: "routine-exec-1",
          data: {
            uuid: "routine-exec-1",
            executionTraceId: "trace-1",
          },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "execution_trace",
          entityId: "trace-1",
          data: {
            uuid: "trace-1",
          },
          deps: [],
        },
      ],
      updates: [],
    });

    await waitForCondition(() => order.length === 4);

    expect(order).toEqual([
      "insert-pg-cadenza-db-postgres-actor-execution_trace:trace-1",
      "insert-pg-cadenza-db-postgres-actor-routine_execution:routine-exec-1",
      "insert-pg-cadenza-db-postgres-actor-signal_emission:signal-emission-1",
      "insert-pg-cadenza-db-postgres-actor-task_execution:task-exec-1",
    ]);
  });

  it("holds updates until the ensured row exists, then applies them", async () => {
    const order: string[] = [];

    vi.spyOn(Cadenza, "inquire").mockImplementation(
      async (intentName: string, context: Record<string, any>) => {
        order.push(
          `${intentName}:${String(
            context?.queryData?.filter?.uuid ??
              context?.queryData?.data?.uuid ??
              "unknown",
          )}`,
        );
        return { __success: true, rowCount: 1 } as any;
      },
    );

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-2",
      ensures: [],
      updates: [
        {
          kind: "update",
          entityType: "inquiry",
          entityId: "inquiry-1",
          data: {
            fulfilledAt: "2026-03-25T00:00:05.000Z",
          },
          filter: {
            uuid: "inquiry-1",
          },
          deps: ["inquiry:inquiry-1"],
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-2",
      ensures: [
        {
          kind: "ensure",
          entityType: "execution_trace",
          entityId: "trace-2",
          data: {
            uuid: "trace-2",
          },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "inquiry",
          entityId: "inquiry-1",
          data: {
            uuid: "inquiry-1",
            executionTraceId: "trace-2",
          },
          deps: ["execution_trace:trace-2"],
        },
      ],
      updates: [],
    });

    await waitForCondition(() => order.length === 3);

    expect(order).toEqual([
      "insert-pg-cadenza-db-postgres-actor-execution_trace:trace-2",
      "insert-pg-cadenza-db-postgres-actor-inquiry:inquiry-1",
      "update-pg-cadenza-db-postgres-actor-inquiry:inquiry-1",
    ]);
  });

  it("normalizes routine_execution trace fields before the authority insert", async () => {
    const routineInsertPayloads: Array<Record<string, any>> = [];

    vi.spyOn(Cadenza, "inquire").mockImplementation(
      async (intentName: string, context: Record<string, any>) => {
        if (intentName === "insert-pg-cadenza-db-postgres-actor-routine_execution") {
          routineInsertPayloads.push({ ...(context?.queryData?.data ?? {}) });
        }

        return { __success: true, rowCount: 1 } as any;
      },
    );

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-3",
      ensures: [
        {
          kind: "ensure",
          entityType: "routine_execution",
          entityId: "routine-exec-3",
          data: {
            uuid: "routine-exec-3",
            executionTraceId: "trace-3",
            execution_trace_id: "trace-3",
            metaContext: {
              __executionTraceId: "trace-3",
              __metadata: {
                __executionTraceId: "trace-3",
              },
            },
            meta_context: {
              __executionTraceId: "trace-3",
            },
            isMeta: true,
            is_meta: true,
            serviceName: "CadenzaDB",
            service_name: "CadenzaDB",
            serviceInstanceId: "cadenza-db-service-1",
            service_instance_id: "cadenza-db-service-1",
          },
          deps: [],
        },
      ],
      updates: [],
    });

    await waitForCondition(() => routineInsertPayloads.length === 1);

    expect(routineInsertPayloads[0]).toMatchObject({
      uuid: "routine-exec-3",
      execution_trace_id: "trace-3",
      meta_context: {
        __executionTraceId: "trace-3",
      },
      is_meta: true,
      service_name: "CadenzaDB",
      service_instance_id: "cadenza-db-service-1",
    });
    expect(routineInsertPayloads[0]).not.toHaveProperty("executionTraceId");
    expect(routineInsertPayloads[0]).not.toHaveProperty("traceId");
    expect(routineInsertPayloads[0]).not.toHaveProperty("metaContext");
    expect(routineInsertPayloads[0]).not.toHaveProperty("isMeta");
    expect(routineInsertPayloads[0]).not.toHaveProperty("serviceName");
    expect(routineInsertPayloads[0]).not.toHaveProperty("serviceInstanceId");
  });

  it("registers the authority-local coordinator tasks", async () => {
    ExecutionPersistenceCoordinator.instance;

    expect(Cadenza.get("Process execution persistence bundle")).toBeTruthy();
    expect(Cadenza.get("Normalize execution trace persistence event")).toBeTruthy();
    expect(Cadenza.get("Normalize routine execution update event")).toBeTruthy();
    expect(Cadenza.get("Normalize task execution update event")).toBeTruthy();
  });
});
