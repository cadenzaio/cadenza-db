import {
  explodeServiceManifestSnapshots,
  normalizeServiceManifestSnapshot,
  selectLatestServiceManifestSnapshots,
  type ServiceManifestSnapshot,
} from "@cadenza.io/service";

export type ServiceTransportRole = "internal" | "public";
export type ServiceTransportProtocol = "rest" | "socket";

export interface ServiceTransportDescriptor {
  uuid: string;
  serviceInstanceId: string;
  role: ServiceTransportRole;
  origin: string;
  protocols: ServiceTransportProtocol[];
  securityProfile: string | null;
  authStrategy: string | null;
  deleted: boolean;
}

export interface ServiceInstanceDescriptor {
  uuid: string;
  serviceName: string;
  isPrimary: boolean;
  isDatabase: boolean;
  isFrontend: boolean;
  isBlocked: boolean;
  isNonResponsive: boolean;
  isActive: boolean;
  health: Record<string, unknown>;
  deleted: boolean;
  lastActive?: string;
  created?: string;
  modified?: string;
}

export interface ServiceInstanceSyncDescriptor extends ServiceInstanceDescriptor {
  transports: ServiceTransportDescriptor[];
}

type AnyRecord = Record<string, unknown>;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean {
  return Boolean(value);
}

function readObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readProtocols(value: unknown): ServiceTransportProtocol[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const normalized = rawValues
    .map((entry) => readString(entry))
    .filter(
      (entry): entry is ServiceTransportProtocol =>
        entry === "rest" || entry === "socket",
    );

  return Array.from(new Set(normalized));
}

export function normalizeServiceTransport(
  value: unknown,
): ServiceTransportDescriptor | null {
  const raw = (value ?? {}) as AnyRecord;
  const uuid = readString(raw.uuid);
  const serviceInstanceId = readString(
    raw.serviceInstanceId ?? raw.service_instance_id,
  );
  const role = readString(raw.role) as ServiceTransportRole;
  const origin = readString(raw.origin);

  if (!uuid || !serviceInstanceId || !origin) {
    return null;
  }

  if (role !== "internal" && role !== "public") {
    return null;
  }

  const protocols = readProtocols(raw.protocols);
  if (protocols.length === 0) {
    return null;
  }

  return {
    uuid,
    serviceInstanceId,
    role,
    origin,
    protocols,
    securityProfile: readString(
      raw.securityProfile ?? raw.security_profile,
    ) || null,
    authStrategy: readString(raw.authStrategy ?? raw.auth_strategy) || null,
    deleted: readBoolean(raw.deleted),
  };
}

export function normalizeServiceInstance(
  value: unknown,
): ServiceInstanceDescriptor | null {
  const raw = (value ?? {}) as AnyRecord;
  const uuid = readString(raw.uuid);
  const serviceName = readString(raw.serviceName ?? raw.service_name);

  if (!uuid || !serviceName) {
    return null;
  }

  return {
    uuid,
    serviceName,
    isPrimary: readBoolean(raw.isPrimary ?? raw.is_primary),
    isDatabase: readBoolean(raw.isDatabase ?? raw.is_database),
    isFrontend: readBoolean(raw.isFrontend ?? raw.is_frontend),
    isBlocked: readBoolean(raw.isBlocked ?? raw.is_blocked),
    isNonResponsive: readBoolean(raw.isNonResponsive ?? raw.is_non_responsive),
    isActive: readBoolean(raw.isActive ?? raw.is_active),
    health: readObject(raw.health),
    deleted: readBoolean(raw.deleted),
    lastActive: readString(raw.lastActive ?? raw.last_active) || undefined,
    created: readString(raw.created) || undefined,
    modified: readString(raw.modified) || undefined,
  };
}

export interface ServiceInstanceOriginReconciliationPlan {
  serviceName?: string;
  role?: ServiceTransportRole;
  origin?: string;
  winningInstanceId: string | null;
  retiredInstanceIds: string[];
  retiredTransportIds: string[];
}

function resolveInstanceRecency(instance: ServiceInstanceDescriptor): number {
  const candidates = [instance.modified, instance.lastActive, instance.created];
  for (const value of candidates) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

export function planServiceInstanceOriginReconciliation(input: {
  authoritativeInstanceId?: string | null;
  serviceName?: string | null;
  role: ServiceTransportRole;
  origin: string;
  serviceInstances: ServiceInstanceDescriptor[];
  serviceInstanceTransports: ServiceTransportDescriptor[];
}): ServiceInstanceOriginReconciliationPlan {
  const authoritativeInstanceId =
    typeof input.authoritativeInstanceId === "string"
      ? input.authoritativeInstanceId.trim()
      : "";
  const matchingTransports = input.serviceInstanceTransports.filter(
    (transport) =>
      !transport.deleted &&
      transport.role === input.role &&
      transport.origin === input.origin,
  );

  if (matchingTransports.length <= 1) {
    return {
      serviceName:
        typeof input.serviceName === "string" ? input.serviceName.trim() : "",
      role: input.role,
      origin: input.origin,
      winningInstanceId:
        matchingTransports[0]?.serviceInstanceId?.trim() ??
        authoritativeInstanceId ??
        null,
      retiredInstanceIds: [],
      retiredTransportIds: [],
    };
  }

  const instanceById = new Map(
    input.serviceInstances.map((instance) => [instance.uuid, instance] as const),
  );
  const matchingInstanceIds = Array.from(
    new Set(matchingTransports.map((transport) => transport.serviceInstanceId)),
  ).filter((instanceId) => {
    const instance = instanceById.get(instanceId);
    if (!instance || instance.deleted) {
      return false;
    }

    if (
      typeof input.serviceName === "string" &&
      input.serviceName.trim().length > 0 &&
      instance.serviceName !== input.serviceName.trim()
    ) {
      return false;
    }

    return true;
  });

  if (matchingInstanceIds.length <= 1) {
    return {
      serviceName:
        typeof input.serviceName === "string" ? input.serviceName.trim() : "",
      role: input.role,
      origin: input.origin,
      winningInstanceId:
        matchingInstanceIds[0] ?? authoritativeInstanceId ?? null,
      retiredInstanceIds: [],
      retiredTransportIds: [],
    };
  }

  const winningInstanceId = matchingInstanceIds
    .slice()
    .sort((leftId, rightId) => {
      const left = instanceById.get(leftId)!;
      const right = instanceById.get(rightId)!;

      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      const recencyDelta =
        resolveInstanceRecency(right) - resolveInstanceRecency(left);
      if (recencyDelta !== 0) {
        return recencyDelta;
      }

      if (authoritativeInstanceId) {
        if (leftId === authoritativeInstanceId) return -1;
        if (rightId === authoritativeInstanceId) return 1;
      }

      return right.uuid.localeCompare(left.uuid);
    })[0];

  const retiredInstanceIds = matchingInstanceIds.filter(
    (instanceId) => instanceId !== winningInstanceId,
  );
  const retiredTransportIds = matchingTransports
    .filter((transport) => transport.serviceInstanceId !== winningInstanceId)
    .map((transport) => transport.uuid);

  return {
    serviceName:
      typeof input.serviceName === "string" ? input.serviceName.trim() : "",
    role: input.role,
    origin: input.origin,
    winningInstanceId,
    retiredInstanceIds,
    retiredTransportIds,
  };
}

export function collectServiceInstanceOriginReconciliationPlans(input: {
  serviceInstances: ServiceInstanceDescriptor[];
  serviceInstanceTransports: ServiceTransportDescriptor[];
}): ServiceInstanceOriginReconciliationPlan[] {
  const instanceById = new Map(
    input.serviceInstances
      .filter((instance) => !instance.deleted)
      .map((instance) => [instance.uuid, instance] as const),
  );
  const groups = new Map<
    string,
    {
      serviceName: string;
      role: ServiceTransportRole;
      origin: string;
      authoritativeInstanceId: string | null;
    }
  >();

  for (const transport of input.serviceInstanceTransports) {
    if (transport.deleted) {
      continue;
    }

    const instance = instanceById.get(transport.serviceInstanceId);
    if (!instance || instance.deleted || !instance.serviceName) {
      continue;
    }

    const key = `${instance.serviceName}|${transport.role}|${transport.origin}`;
    const currentGroup = groups.get(key);
    if (!currentGroup) {
      groups.set(key, {
        serviceName: instance.serviceName,
        role: transport.role,
        origin: transport.origin,
        authoritativeInstanceId: instance.uuid,
      });
      continue;
    }

    const currentAuthoritativeInstance = currentGroup.authoritativeInstanceId
      ? instanceById.get(currentGroup.authoritativeInstanceId)
      : null;
    const currentAuthoritativeRecency = currentAuthoritativeInstance
      ? resolveInstanceRecency(currentAuthoritativeInstance)
      : -1;
    const candidateRecency = resolveInstanceRecency(instance);

    if (
      candidateRecency > currentAuthoritativeRecency ||
      (candidateRecency === currentAuthoritativeRecency &&
        instance.uuid.localeCompare(currentGroup.authoritativeInstanceId ?? "") > 0)
    ) {
      currentGroup.authoritativeInstanceId = instance.uuid;
    }
  }

  const plans: ServiceInstanceOriginReconciliationPlan[] = [];
  for (const group of groups.values()) {
    const plan = planServiceInstanceOriginReconciliation({
      authoritativeInstanceId: group.authoritativeInstanceId,
      serviceName: group.serviceName,
      role: group.role,
      origin: group.origin,
      serviceInstances: input.serviceInstances,
      serviceInstanceTransports: input.serviceInstanceTransports,
    });

    if (
      plan.retiredInstanceIds.length === 0 &&
      plan.retiredTransportIds.length === 0
    ) {
      continue;
    }

    plans.push(plan);
  }

  return plans.sort((left, right) => {
    const leftKey = `${left.serviceName ?? ""}|${left.role ?? ""}|${left.origin ?? ""}`;
    const rightKey = `${right.serviceName ?? ""}|${right.role ?? ""}|${right.origin ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function composeServiceRegistrySyncPayload<T extends AnyRecord>(payload: T): T & {
  serviceInstances: ServiceInstanceSyncDescriptor[];
  tasks: Array<Record<string, unknown>>;
  signals: Array<Record<string, unknown>>;
  intents: Array<Record<string, unknown>>;
  actors: Array<Record<string, unknown>>;
  routines: Array<Record<string, unknown>>;
  directionalTaskMaps: Array<Record<string, unknown>>;
  actorTaskMaps: Array<Record<string, unknown>>;
  taskToRoutineMaps: Array<Record<string, unknown>>;
  signalToTaskMaps: Array<Record<string, unknown>>;
  intentToTaskMaps: Array<Record<string, unknown>>;
} {
  const normalizedTransports = Array.isArray(payload.serviceInstanceTransports)
    ? payload.serviceInstanceTransports
        .map(normalizeServiceTransport)
        .filter(
          (item): item is ServiceTransportDescriptor => !!item && !item.deleted,
        )
    : [];

  const transportsByInstance = new Map<string, ServiceTransportDescriptor[]>();
  for (const transport of normalizedTransports) {
    if (!transportsByInstance.has(transport.serviceInstanceId)) {
      transportsByInstance.set(transport.serviceInstanceId, []);
    }

    transportsByInstance.get(transport.serviceInstanceId)!.push(transport);
  }

  const normalizedInstances = Array.isArray(payload.serviceInstances)
    ? payload.serviceInstances
        .map(normalizeServiceInstance)
        .filter((item): item is ServiceInstanceDescriptor => !!item)
        .map((instance) => ({
          ...instance,
          transports: (transportsByInstance.get(instance.uuid) ?? []).sort(
            (left, right) => left.role.localeCompare(right.role),
          ),
        }))
    : [];

  const { serviceInstanceTransports: _omitted, ...rest } = payload;
  const manifestSnapshots: ServiceManifestSnapshot[] = Array.isArray(
    (payload as AnyRecord).serviceManifests,
  )
    ? ((payload as AnyRecord).serviceManifests as unknown[])
        .map((entry) => {
          const row =
            entry && typeof entry === "object" && !Array.isArray(entry)
              ? (entry as AnyRecord)
              : null;
          return normalizeServiceManifestSnapshot(
            row?.manifest && typeof row.manifest === "object" ? row.manifest : row,
          );
        })
        .filter((snapshot): snapshot is ServiceManifestSnapshot => !!snapshot)
    : [];
  const explodedManifest = explodeServiceManifestSnapshots(
    selectLatestServiceManifestSnapshots(manifestSnapshots),
  );

  return {
    ...(rest as T),
    serviceInstances: normalizedInstances,
    tasks: explodedManifest.tasks as Array<Record<string, unknown>>,
    signals: explodedManifest.signals as Array<Record<string, unknown>>,
    intents: explodedManifest.intents as Array<Record<string, unknown>>,
    actors: explodedManifest.actors as Array<Record<string, unknown>>,
    routines: explodedManifest.routines as Array<Record<string, unknown>>,
    directionalTaskMaps:
      explodedManifest.directionalTaskMaps as Array<Record<string, unknown>>,
    actorTaskMaps:
      explodedManifest.actorTaskMaps as Array<Record<string, unknown>>,
    taskToRoutineMaps:
      explodedManifest.taskToRoutineMaps as Array<Record<string, unknown>>,
    signalToTaskMaps:
      explodedManifest.signalToTaskMaps as Array<Record<string, unknown>>,
    intentToTaskMaps:
      explodedManifest.intentToTaskMaps as Array<Record<string, unknown>>,
  };
}
