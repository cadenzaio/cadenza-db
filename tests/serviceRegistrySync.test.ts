import { describe, expect, it } from "vitest";
import {
  composeServiceRegistrySyncPayload,
  normalizeServiceTransport,
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
});
