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

  it("moves task execution metadata keys out of context before insert", async () => {
    const taskInsertPayloads: Array<Record<string, any>> = [];

    vi.spyOn(Cadenza, "inquire").mockImplementation(
      async (intentName: string, context: Record<string, any>) => {
        if (intentName === "insert-pg-cadenza-db-postgres-actor-task_execution") {
          taskInsertPayloads.push({ ...(context?.queryData?.data ?? {}) });
        }

        return { __success: true, rowCount: 1 } as any;
      },
    );

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-ctx-1",
      ensures: [
        {
          kind: "ensure",
          entityType: "execution_trace",
          entityId: "trace-ctx-1",
          data: { uuid: "trace-ctx-1" },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "routine_execution",
          entityId: "routine-ctx-1",
          data: {
            uuid: "routine-ctx-1",
            execution_trace_id: "trace-ctx-1",
          },
          deps: ["execution_trace:trace-ctx-1"],
        },
        {
          kind: "ensure",
          entityType: "task_execution",
          entityId: "task-ctx-1",
          data: {
            uuid: "task-ctx-1",
            routine_execution_id: "routine-ctx-1",
            execution_trace_id: "trace-ctx-1",
            context: {
              deviceId: "device-1",
              __delegationRequestContext: { routeKey: "PredictorService|rest" },
            },
            meta_context: {
              __executionTraceId: "trace-ctx-1",
            },
          },
          deps: [
            "execution_trace:trace-ctx-1",
            "routine_execution:routine-ctx-1",
          ],
        },
      ],
      updates: [],
    });

    await waitForCondition(() => taskInsertPayloads.length === 1);

    expect(taskInsertPayloads[0]).toMatchObject({
      uuid: "task-ctx-1",
      context: {
        deviceId: "device-1",
      },
      meta_context: {
        __executionTraceId: "trace-ctx-1",
        __delegationRequestContext: {
          routeKey: "PredictorService|rest",
        },
      },
    });
    expect(taskInsertPayloads[0].context).not.toHaveProperty(
      "__delegationRequestContext",
    );
  });

  it("moves task execution metadata keys out of result_context before update", async () => {
    const taskUpdatePayloads: Array<Record<string, any>> = [];

    vi.spyOn(Cadenza, "inquire").mockImplementation(
      async (intentName: string, context: Record<string, any>) => {
        if (intentName === "update-pg-cadenza-db-postgres-actor-task_execution") {
          taskUpdatePayloads.push({ ...(context?.queryData?.data ?? {}) });
        }

        return { __success: true, rowCount: 1 } as any;
      },
    );

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-result-1",
      ensures: [
        {
          kind: "ensure",
          entityType: "execution_trace",
          entityId: "trace-result-1",
          data: { uuid: "trace-result-1" },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "routine_execution",
          entityId: "routine-result-1",
          data: {
            uuid: "routine-result-1",
            execution_trace_id: "trace-result-1",
          },
          deps: ["execution_trace:trace-result-1"],
        },
        {
          kind: "ensure",
          entityType: "task_execution",
          entityId: "task-result-1",
          data: {
            uuid: "task-result-1",
            routine_execution_id: "routine-result-1",
            execution_trace_id: "trace-result-1",
          },
          deps: [
            "execution_trace:trace-result-1",
            "routine_execution:routine-result-1",
          ],
        },
      ],
      updates: [
        {
          kind: "update",
          entityType: "task_execution",
          entityId: "task-result-1",
          data: {
            result_context: {
              predictedEta: "2026-04-10T10:00:00.000Z",
              __inquiryMeta: { responders: 1 },
            },
            meta_result_context: {
              __executionTraceId: "trace-result-1",
            },
          },
          filter: {
            uuid: "task-result-1",
          },
          deps: ["task_execution:task-result-1"],
        },
      ],
    });

    await waitForCondition(() => taskUpdatePayloads.length === 1);

    expect(taskUpdatePayloads[0]).toMatchObject({
      result_context: {
        predictedEta: "2026-04-10T10:00:00.000Z",
      },
      meta_result_context: {
        __executionTraceId: "trace-result-1",
        __inquiryMeta: {
          responders: 1,
        },
      },
    });
    expect(taskUpdatePayloads[0].result_context).not.toHaveProperty(
      "__inquiryMeta",
    );
  });

  it("strips meta_context from signal emission inserts", async () => {
    const signalInsertPayloads: Array<Record<string, any>> = [];

    vi.spyOn(Cadenza, "inquire").mockImplementation(
      async (intentName: string, context: Record<string, any>) => {
        if (intentName === "insert-pg-cadenza-db-postgres-actor-signal_emission") {
          signalInsertPayloads.push({ ...(context?.queryData?.data ?? {}) });
        }

        return { __success: true, rowCount: 1 } as any;
      },
    );

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-signal-ctx-1",
      ensures: [
        {
          kind: "ensure",
          entityType: "execution_trace",
          entityId: "trace-signal-ctx-1",
          data: { uuid: "trace-signal-ctx-1" },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "signal_emission",
          entityId: "signal-ctx-1",
          data: {
            uuid: "signal-ctx-1",
            execution_trace_id: "trace-signal-ctx-1",
            context: {
              orderId: "order-42",
              __delegationRequestContext: {
                routeKey: "PredictorService|rest",
              },
            },
            meta_context: {
              __executionTraceId: "trace-signal-ctx-1",
            },
          },
          deps: ["execution_trace:trace-signal-ctx-1"],
        },
      ],
      updates: [],
    });

    await waitForCondition(() => signalInsertPayloads.length === 1);

    expect(signalInsertPayloads[0]).toMatchObject({
      uuid: "signal-ctx-1",
      context: {
        orderId: "order-42",
      },
    });
    expect(signalInsertPayloads[0].context).not.toHaveProperty(
      "__delegationRequestContext",
    );
    expect(signalInsertPayloads[0]).not.toHaveProperty("meta_context");
  });

  it("registers the authority-local coordinator tasks", async () => {
    ExecutionPersistenceCoordinator.instance;

    expect(Cadenza.get("Process execution persistence bundle")).toBeTruthy();
    expect(Cadenza.get("Normalize execution trace persistence event")).toBeTruthy();
    expect(Cadenza.get("Normalize routine execution update event")).toBeTruthy();
    expect(Cadenza.get("Normalize task execution update event")).toBeTruthy();
  });

  it("uses an aggressively expiring per-trace actor session policy", () => {
    ExecutionPersistenceCoordinator.instance;

    const actor = Cadenza.getActor<any, any>(
      "ExecutionPersistenceCoordinatorActor",
    );
    const definition = actor?.toDefinition();

    expect(definition?.session).toMatchObject({
      enabled: true,
      persistDurableState: false,
      idleTtlMs: 10_000,
      absoluteTtlMs: 30_000,
    });
  });

  it("compacts per-trace runtime state after terminal routine updates", async () => {
    vi.spyOn(Cadenza, "inquire").mockResolvedValue({
      __success: true,
      rowCount: 1,
    } as any);

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-compact",
      ensures: [
        {
          kind: "ensure",
          entityType: "execution_trace",
          entityId: "trace-compact",
          data: { uuid: "trace-compact" },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "routine_execution",
          entityId: "routine-compact",
          data: {
            uuid: "routine-compact",
            executionTraceId: "trace-compact",
          },
          deps: ["execution_trace:trace-compact"],
        },
      ],
      updates: [
        {
          kind: "update",
          entityType: "routine_execution",
          entityId: "routine-compact",
          data: {
            endedAt: "2026-04-10T17:16:58.974Z",
          },
          filter: {
            uuid: "routine-compact",
          },
          deps: ["routine_execution:routine-compact"],
        },
      ],
    });

    await waitForCondition(() => {
      const actor = Cadenza.getActor<any, any>(
        "ExecutionPersistenceCoordinatorActor",
      );
      const runtimeState = actor?.getRuntimeState("trace-compact") as
        | Record<string, any>
        | undefined;

      return (
        !!runtimeState &&
        Object.keys(runtimeState.pending ?? {}).length === 0 &&
        Object.values(runtimeState.persisted ?? {}).every(
          (bucket) =>
            !!bucket &&
            typeof bucket === "object" &&
            Object.keys(bucket as Record<string, unknown>).length === 0,
        )
      );
    });
  });

  it("compacts per-trace runtime state after terminal task updates", async () => {
    vi.spyOn(Cadenza, "inquire").mockResolvedValue({
      __success: true,
      rowCount: 1,
    } as any);

    ExecutionPersistenceCoordinator.instance;

    Cadenza.emit(EXECUTION_PERSISTENCE_BUNDLE_SIGNAL, {
      traceId: "trace-task-compact",
      ensures: [
        {
          kind: "ensure",
          entityType: "execution_trace",
          entityId: "trace-task-compact",
          data: { uuid: "trace-task-compact" },
          deps: [],
        },
        {
          kind: "ensure",
          entityType: "routine_execution",
          entityId: "routine-task-compact",
          data: {
            uuid: "routine-task-compact",
            executionTraceId: "trace-task-compact",
          },
          deps: ["execution_trace:trace-task-compact"],
        },
        {
          kind: "ensure",
          entityType: "task_execution",
          entityId: "task-task-compact",
          data: {
            uuid: "task-task-compact",
            executionTraceId: "trace-task-compact",
            routineExecutionId: "routine-task-compact",
          },
          deps: [
            "execution_trace:trace-task-compact",
            "routine_execution:routine-task-compact",
          ],
        },
      ],
      updates: [
        {
          kind: "update",
          entityType: "task_execution",
          entityId: "task-task-compact",
          data: {
            endedAt: "2026-04-11T08:40:00.000Z",
          },
          filter: {
            uuid: "task-task-compact",
          },
          deps: ["task_execution:task-task-compact"],
        },
      ],
    });

    await waitForCondition(() => {
      const actor = Cadenza.getActor<any, any>(
        "ExecutionPersistenceCoordinatorActor",
      );
      const runtimeState = actor?.getRuntimeState("trace-task-compact") as
        | Record<string, any>
        | undefined;

      return (
        !!runtimeState &&
        Object.keys(runtimeState.pending ?? {}).length === 0 &&
        Object.values(runtimeState.persisted ?? {}).every(
          (bucket) =>
            !!bucket &&
            typeof bucket === "object" &&
            Object.keys(bucket as Record<string, unknown>).length === 0,
        )
      );
    });
  });
});
