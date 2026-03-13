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
    created: readString(raw.created) || undefined,
    modified: readString(raw.modified) || undefined,
  };
}

export function composeServiceRegistrySyncPayload<T extends AnyRecord>(payload: T): T & {
  serviceInstances: ServiceInstanceSyncDescriptor[];
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

  return {
    ...(rest as T),
    serviceInstances: normalizedInstances,
  };
}
