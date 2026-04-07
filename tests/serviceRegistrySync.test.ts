import { describe, expect, it } from "vitest";
import {
  collectServiceInstanceOriginReconciliationPlans,
  composeServiceRegistrySyncPayload,
  normalizeServiceTransport,
  planServiceInstanceOriginReconciliation,
} from "../src/serviceRegistrySync";

describe("service registry sync composition", () => {
  it("nests non-deleted transports under their service instances", () => {
    const payload = composeServiceRegistrySyncPayload({
      serviceInstances: [
        {
          uuid: "svc-1",
          service_name: "OrdersService",
          is_primary: true,
          is_database: false,
          is_frontend: false,
          is_blocked: false,
          is_non_responsive: false,
          is_active: true,
          health: { ok: true },
          deleted: false,
        },
      ],
      serviceInstanceTransports: [
        {
          uuid: "transport-1",
          service_instance_id: "svc-1",
          role: "internal",
          origin: "http://10.0.0.5:3000",
          protocols: ["rest", "socket"],
          security_profile: null,
          auth_strategy: null,
          deleted: false,
        },
        {
          uuid: "transport-2",
          service_instance_id: "svc-1",
          role: "public",
          origin: "https://orders-1.example.com",
          protocols: ["rest", "socket"],
          security_profile: "high",
          auth_strategy: "reserved",
          deleted: false,
        },
        {
          uuid: "transport-3",
          service_instance_id: "svc-1",
          role: "public",
          origin: "https://orders-old.example.com",
          protocols: ["rest"],
          deleted: true,
        },
      ],
    });

    expect(payload.serviceInstances).toHaveLength(1);
    expect(payload.serviceInstances[0]).toMatchObject({
      uuid: "svc-1",
      serviceName: "OrdersService",
      transports: [
        {
          uuid: "transport-1",
          role: "internal",
          origin: "http://10.0.0.5:3000",
          protocols: ["rest", "socket"],
        },
        {
          uuid: "transport-2",
          role: "public",
          origin: "https://orders-1.example.com",
          protocols: ["rest", "socket"],
          securityProfile: "high",
          authStrategy: "reserved",
        },
      ],
    });
    expect((payload as any).serviceInstanceTransports).toBeUndefined();
  });

  it("rejects invalid transport descriptors", () => {
    expect(
      normalizeServiceTransport({
        uuid: "transport-1",
        service_instance_id: "svc-1",
        role: "internal",
        origin: "http://10.0.0.5:3000",
        protocols: ["invalid"],
      }),
    ).toBeNull();
  });

  it("prefers the latest manifest revision when composing the authority sync payload", () => {
    const payload = composeServiceRegistrySyncPayload({
      serviceInstances: [
        {
          uuid: "runner-1",
          service_name: "ScheduledRunnerService",
          is_primary: false,
          is_database: false,
          is_frontend: false,
          is_blocked: false,
          is_non_responsive: false,
          is_active: true,
          health: {},
          deleted: false,
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
          serviceName: "ScheduledRunnerService",
          serviceInstanceId: "runner-1",
          revision: 1,
          manifestHash: "runner-manifest-v1",
          publishedAt: "2026-03-30T10:00:00.000Z",
          tasks: [],
          signals: [],
          intents: [],
          actors: [],
          routines: [],
          directionalTaskMaps: [],
          actorTaskMaps: [],
          taskToRoutineMaps: [],
          signalToTaskMaps: [
            {
              signal_name: "global.runner.stale",
              service_name: "ScheduledRunnerService",
              task_name: "Handle stale runner signal",
              task_version: 1,
              is_global: true,
            },
          ],
          intentToTaskMaps: [],
        },
        {
          serviceName: "ScheduledRunnerService",
          serviceInstanceId: "runner-1",
          revision: 2,
          manifestHash: "runner-manifest-v2",
          publishedAt: "2026-03-30T10:05:00.000Z",
          tasks: [],
          signals: [],
          intents: [],
          actors: [],
          routines: [],
          directionalTaskMaps: [],
          actorTaskMaps: [],
          taskToRoutineMaps: [],
          signalToTaskMaps: [
            {
              signal_name: "global.runner.tick",
              service_name: "ScheduledRunnerService",
              task_name: "Runner tick",
              task_version: 1,
              is_global: true,
            },
          ],
          intentToTaskMaps: [],
        },
      ],
    });

    expect(payload.signalToTaskMaps).toEqual([
      expect.objectContaining({
        signal_name: "global.runner.tick",
        service_name: "ScheduledRunnerService",
        task_name: "Runner tick",
      }),
    ]);
  });

  it("retires older same-origin duplicates for the same service", () => {
    const plan = planServiceInstanceOriginReconciliation({
      authoritativeInstanceId: "svc-new",
      serviceName: "IotDbService",
      role: "internal",
      origin: "http://iot-db-service:3001",
      serviceInstances: [
        {
          uuid: "svc-old",
          serviceName: "IotDbService",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
          modified: "2026-03-26T10:00:00.000Z",
        },
        {
          uuid: "svc-new",
          serviceName: "IotDbService",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
          modified: "2026-03-26T10:01:00.000Z",
        },
      ],
      serviceInstanceTransports: [
        {
          uuid: "transport-old",
          serviceInstanceId: "svc-old",
          role: "internal",
          origin: "http://iot-db-service:3001",
          protocols: ["rest"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
        {
          uuid: "transport-new",
          serviceInstanceId: "svc-new",
          role: "internal",
          origin: "http://iot-db-service:3001",
          protocols: ["rest"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
      ],
    });

    expect(plan).toEqual({
      serviceName: "IotDbService",
      role: "internal",
      origin: "http://iot-db-service:3001",
      winningInstanceId: "svc-new",
      retiredInstanceIds: ["svc-old"],
      retiredTransportIds: ["transport-old"],
    });
  });

  it("prefers the newest active same-origin owner even when the trigger points at an older owner", () => {
    const plan = planServiceInstanceOriginReconciliation({
      authoritativeInstanceId: "svc-old",
      serviceName: "CadenzaDB",
      role: "internal",
      origin: "http://cadenza-db-service:8080",
      serviceInstances: [
        {
          uuid: "svc-old",
          serviceName: "CadenzaDB",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
          modified: "2026-03-30T21:19:19.609Z",
        },
        {
          uuid: "svc-new",
          serviceName: "CadenzaDB",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
          modified: "2026-03-30T23:29:32.611Z",
        },
      ],
      serviceInstanceTransports: [
        {
          uuid: "transport-old",
          serviceInstanceId: "svc-old",
          role: "internal",
          origin: "http://cadenza-db-service:8080",
          protocols: ["rest", "socket"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
        {
          uuid: "transport-new",
          serviceInstanceId: "svc-new",
          role: "internal",
          origin: "http://cadenza-db-service:8080",
          protocols: ["rest", "socket"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
      ],
    });

    expect(plan).toEqual({
      serviceName: "CadenzaDB",
      role: "internal",
      origin: "http://cadenza-db-service:8080",
      winningInstanceId: "svc-new",
      retiredInstanceIds: ["svc-old"],
      retiredTransportIds: ["transport-old"],
    });
  });

  it("keeps different services with the same origin isolated", () => {
    const plan = planServiceInstanceOriginReconciliation({
      authoritativeInstanceId: "svc-iot",
      serviceName: "IotDbService",
      role: "public",
      origin: "http://localhost:3001",
      serviceInstances: [
        {
          uuid: "svc-iot",
          serviceName: "IotDbService",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
        },
        {
          uuid: "svc-other",
          serviceName: "TelemetryCollectorService",
          isPrimary: true,
          isDatabase: false,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
        },
      ],
      serviceInstanceTransports: [
        {
          uuid: "transport-iot",
          serviceInstanceId: "svc-iot",
          role: "public",
          origin: "http://localhost:3001",
          protocols: ["rest"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
        {
          uuid: "transport-other",
          serviceInstanceId: "svc-other",
          role: "public",
          origin: "http://localhost:3001",
          protocols: ["rest"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
      ],
    });

    expect(plan).toEqual({
      serviceName: "IotDbService",
      role: "public",
      origin: "http://localhost:3001",
      winningInstanceId: "svc-iot",
      retiredInstanceIds: [],
      retiredTransportIds: [],
    });
  });

  it("builds canonicalization plans for duplicate same-origin owners", () => {
    const plans = collectServiceInstanceOriginReconciliationPlans({
      serviceInstances: [
        {
          uuid: "svc-old",
          serviceName: "CadenzaDB",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
          created: "2026-03-30T02:46:00.000Z",
          modified: "2026-03-30T02:46:00.000Z",
        },
        {
          uuid: "svc-new",
          serviceName: "CadenzaDB",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
          created: "2026-03-30T02:47:00.000Z",
          modified: "2026-03-30T02:47:00.000Z",
        },
        {
          uuid: "svc-other-origin",
          serviceName: "CadenzaDB",
          isPrimary: true,
          isDatabase: true,
          isFrontend: false,
          isBlocked: false,
          isNonResponsive: false,
          isActive: true,
          health: {},
          deleted: false,
          created: "2026-03-30T02:47:30.000Z",
          modified: "2026-03-30T02:47:30.000Z",
        },
      ],
      serviceInstanceTransports: [
        {
          uuid: "transport-old",
          serviceInstanceId: "svc-old",
          role: "internal",
          origin: "http://cadenza-db-service:8080",
          protocols: ["rest", "socket"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
        {
          uuid: "transport-new",
          serviceInstanceId: "svc-new",
          role: "internal",
          origin: "http://cadenza-db-service:8080",
          protocols: ["rest", "socket"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
        {
          uuid: "transport-other-origin",
          serviceInstanceId: "svc-other-origin",
          role: "internal",
          origin: "http://cadenza-db-service-2:8080",
          protocols: ["rest", "socket"],
          securityProfile: null,
          authStrategy: null,
          deleted: false,
        },
      ],
    });

    expect(plans).toEqual([
      {
        serviceName: "CadenzaDB",
        role: "internal",
        origin: "http://cadenza-db-service:8080",
        winningInstanceId: "svc-new",
        retiredInstanceIds: ["svc-old"],
        retiredTransportIds: ["transport-old"],
      },
    ]);
  });
});
