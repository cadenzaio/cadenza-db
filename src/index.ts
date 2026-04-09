import Cadenza, {
  AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT,
  AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT,
  AUTHORITY_SERVICE_INSTANCE_REGISTER_TASK_NAME,
  AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT,
  AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_TASK_NAME,
  AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL,
  normalizeServiceManifestSnapshot,
} from "@cadenza.io/service";
import ExecutionPersistenceCoordinator from "./execution/ExecutionPersistenceCoordinator";
import { registerAuthorityRuntimeStatusTasks } from "./runtimeStatusAuthority";
import {
  collectServiceInstanceOriginReconciliationPlans,
  normalizeServiceInstance,
  normalizeServiceTransport,
  planServiceInstanceOriginReconciliation,
  type ServiceInstanceDescriptor,
  type ServiceTransportRole,
} from "./serviceRegistrySync";

let CREATED = false;
let LOCAL_SYNC_INITIALIZED = false;
const SYNC_DEBUG_PREFIX = "[CADENZA_DB_SYNC_DEBUG]";
const LOCAL_SYNC_DEBUG_ENABLED =
  typeof process !== "undefined" &&
  typeof process.env === "object" &&
  process.env.CADENZA_DB_SYNC_DEBUG === "true";
const META_SERVICE_INSTANCE_ORIGIN_RECONCILIATION_REQUESTED =
  "meta.cadenza_db.service_instance_origin_reconciliation_requested";
const META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_REQUESTED =
  "meta.cadenza_db.canonicalize_service_instance_origins_requested";
const META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_EXECUTE =
  "meta.cadenza_db.canonicalize_service_instance_origins_execute";
const META_AUTHORITY_REGISTRY_PROJECTION_REQUESTED =
  "meta.cadenza_db.authority_registry_projection_requested";
const META_AUTHORITY_REGISTRY_PROJECTION_EXECUTE =
  "meta.cadenza_db.authority_registry_projection_execute";
const SERVICE_INSTANCE_ORIGIN_CANONICALIZATION_STARTUP_DELAYS_MS = [
  250,
  1500,
  5000,
  15000,
  30000,
] as const;
const AUTHORITY_REGISTRY_PROJECTION_STARTUP_DELAYS_MS = [
  250,
  1500,
  5000,
] as const;
const AUTHORITY_SERVICE_MANIFEST_ENSURE_DELAYS_MS = [
  250,
  1500,
  5000,
] as const;
const META_RETIRE_SUPERSEDED_SERVICE_INSTANCE =
  "meta.cadenza_db.retire_superseded_service_instance";
const META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_TRANSPORT =
  "meta.cadenza_db.retire_superseded_service_instance_transport";
const META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE =
  "meta.cadenza_db.evaluate_transportless_service_instance";

function logLocalSyncDebug(event: string, payload: Record<string, unknown>) {
  if (!LOCAL_SYNC_DEBUG_ENABLED) {
    return;
  }

  console.log(`${SYNC_DEBUG_PREFIX} ${event}`, payload);
}

function buildLegacyLocalSyncQueryTaskName(tableName: string): string {
  const suffix = String(tableName ?? "")
    .trim()
    .split("_")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");

  return `dbQuery${suffix}`;
}

function resolveLocalSyncQueryTask(tableName: string) {
  return (
    Cadenza.get(`Query ${tableName}`) ??
    Cadenza.get(buildLegacyLocalSyncQueryTaskName(tableName))
  );
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPersistedUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  );
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function normalizeRowArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function resolveServiceInstanceTransportTriggerDescriptor(ctx: any): {
  transportId: string;
  serviceInstanceId: string;
  role: ServiceTransportRole | null;
  origin: string;
  deleted: boolean;
} | null {
  const data = readRecord(ctx?.data);
  const filter = readRecord(ctx?.queryData?.filter) ?? readRecord(ctx?.filter);
  const transportId = readString(
    data?.uuid ?? filter?.uuid ?? ctx?.uuid ?? ctx?.__transportId,
  );
  const serviceInstanceId = readString(
    data?.service_instance_id ??
      data?.serviceInstanceId ??
      ctx?.service_instance_id ??
      ctx?.serviceInstanceId ??
      ctx?.__serviceInstanceId,
  );
  const roleValue = readString(data?.role ?? ctx?.role);
  const origin = readString(data?.origin ?? ctx?.origin);
  const deleted = readBoolean(data?.deleted ?? ctx?.deleted);
  const role =
    roleValue === "internal" || roleValue === "public"
      ? (roleValue as ServiceTransportRole)
      : null;

  if (!isPersistedUuid(transportId)) {
    return null;
  }

  return {
    transportId,
    serviceInstanceId,
    role,
    origin,
    deleted,
  };
}

function buildInsertTriggerWithOnConflictDoNothing(
  signal: string,
  target: string[],
) {
  return {
    signal,
    queryData: {
      onConflict: {
        target,
        action: {
          do: "nothing" as const,
        },
      },
    },
  };
}

export function resolveLocalServiceRegistrySyncTasks() {
  const queryServiceInstanceTask = resolveLocalSyncQueryTask("service_instance");
  const queryServiceInstanceTransportTask = resolveLocalSyncQueryTask(
    "service_instance_transport",
  );
  const queryServiceManifestTask = resolveLocalSyncQueryTask("service_manifest");

  if (
    !queryServiceInstanceTask ||
    !queryServiceInstanceTransportTask ||
    !queryServiceManifestTask
  ) {
    throw new Error(
      "CadenzaDB local sync query tasks are not available. Expected generated local query tasks for service_instance, service_instance_transport, and service_manifest.",
    );
  }

  return {
    queryServiceInstanceTask,
    queryServiceInstanceTransportTask,
    queryServiceManifestTask,
  };
}

export default class CadenzaDB {
  static createCadenzaDBService(options?: {
    dropExisting?: boolean;
    port?: number | undefined;
  }) {
    if (CREATED) {
      return;
    }

    CREATED = true;
    Cadenza.createEphemeralMetaTask("Start throttle sync", () => {
      if (LOCAL_SYNC_INITIALIZED) {
        return false;
      }

      LOCAL_SYNC_INITIALIZED = true;
      Cadenza.log("Starting throttle sync...");
      const {
        queryServiceInstanceTask,
        queryServiceInstanceTransportTask,
        queryServiceManifestTask,
      } = resolveLocalServiceRegistrySyncTasks();

      logLocalSyncDebug("start_throttle_sync", {
        queryServiceInstanceTask: queryServiceInstanceTask.name,
        queryServiceInstanceTransportTask: queryServiceInstanceTransportTask.name,
        queryServiceManifestTask: queryServiceManifestTask.name,
      });

      Cadenza.emit("meta.sync_requested", {
        __syncing: true,
        __reason: "cadenza_db_local_sync_tasks_created",
      });
      logLocalSyncDebug("requested_follow_up_sync", {
        reason: "cadenza_db_local_sync_tasks_created",
      });

      return true;
    }).doOn("global.meta.sync_controller.synced");

    console.log("Creating CadenzaDB service");

    Cadenza.createMetaDatabaseService(
      "CadenzaDB",
      {
        version: 4,
        migrationPolicy: {
          adoptExistingVersion: 1,
          allowDestructive: true,
          transactionalMode: "per_migration",
        },
        migrations: [
          {
            version: 1,
            name: "initial-schema",
            steps: [{ kind: "sql", sql: "SELECT 1;" }],
          },
          {
            version: 2,
            name: "drop-routine-execution-routine-version",
            steps: [
              {
                kind: "dropColumn",
                table: "routine_execution",
                column: "routine_version",
                ifExists: true,
              },
            ],
          },
          {
            version: 3,
            name: "service-manifests-and-inline-task-execution-edges",
            steps: [
              {
                kind: "createTable",
                table: "service_manifest",
                definition: {
                  fields: {
                    service_instance_id: {
                      type: "uuid",
                      primary: true,
                      references: "service_instance(uuid)",
                      onDelete: "cascade",
                      required: true,
                    },
                    service_name: {
                      type: "varchar",
                      references: "service(name)",
                      onDelete: "cascade",
                      required: true,
                      constraints: {
                        maxLength: 100,
                      },
                    },
                    revision: {
                      type: "int",
                      required: true,
                      default: 1,
                    },
                    manifest_hash: {
                      type: "varchar",
                      required: true,
                      constraints: {
                        maxLength: 255,
                      },
                    },
                    published_at: {
                      type: "timestamp",
                      required: true,
                      default: "now()",
                    },
                    manifest: {
                      type: "jsonb",
                      required: true,
                    },
                    created: {
                      type: "timestamp",
                      default: "now()",
                    },
                    modified: {
                      type: "timestamp",
                      default: "now()",
                    },
                    deleted: {
                      type: "boolean",
                      default: false,
                    },
                  },
                  indexes: [["service_name", "published_at"]],
                },
              },
              {
                kind: "dropConstraint",
                table: "signal_emission",
                name: "signal_emission_signal_name_fkey",
                ifExists: true,
              },
              {
                kind: "renameColumn",
                table: "task_execution",
                from: "previous_execution_ids",
                to: "previous_task_execution_ids",
              },
              {
                kind: "dropTable",
                table: "task_execution_map",
                ifExists: true,
                cascade: true,
              },
            ],
          },
          {
            version: 4,
            name: "drop-service-manifest-service-instance-fk",
            steps: [
              {
                kind: "dropConstraint",
                table: "service_manifest",
                name: "service_manifest_service_instance_id_fkey",
                ifExists: true,
              },
            ],
          },
        ],
        tables: {
          service: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 100,
                },
              },
              display_name: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [["is_meta"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "meta.create_service_requested",
                    ["name"],
                  ),
                ],
              },
            },
          },

          database_service: {
            fields: {
              id: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              schema: {
                type: "jsonb",
                required: true,
              },
              description: {
                type: "text",
                default: "",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            uniqueConstraints: [["service_name"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.created_database_service",
                    ["service_name"],
                  ),
                ],
              },
            },
          },

          generated_by_type: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            initialData: {
              fields: ["name", "description"],
              data: [
                ["user", "Task generated by a human user."],
                ["system", "Task generated by the system."],
                ["ai", "Task generated by an AI agent."],
                [
                  "auto-generated from schema",
                  "Task auto-generated from a database schema.",
                ],
                [
                  "auto-generated from UI",
                  "Task auto-generated from UI metadata.",
                ],
              ],
            },
          },

          task: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              description: {
                type: "text",
                default: "''",
              },
              function_string: {
                type: "text",
                required: true,
              },
              tag_id_getter: {
                type: "text",
                default: null,
              },
              layer_index: {
                type: "int",
                default: 0,
                required: true,
                constraints: {
                  check: "layer_index > -1",
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              timeout: {
                type: "int",
                default: 0,
              },
              is_unique: {
                type: "boolean",
                default: false,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              is_sub_meta: {
                type: "boolean",
                default: false,
              },
              is_deputy: {
                type: "boolean",
                default: false,
              },
              is_ephemeral: {
                type: "boolean",
                default: false,
              },
              is_signal: {
                type: "boolean",
                default: false,
              },
              is_throttled: {
                type: "boolean",
                default: false,
              },
              is_debounce: {
                type: "boolean",
                default: false,
              },
              is_hidden: {
                type: "boolean",
                default: false,
              },
              concurrency: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 10000,
                },
                default: 0,
              },
              retry_count: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              retry_delay: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              retry_delay_max: {
                type: "int",
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              retry_delay_factor: {
                type: "decimal",
                constraints: {
                  min: 0.01,
                  max: 100.0,
                  precision: 3,
                  scale: 2,
                },
                default: 1.0,
              },
              input_context_schema: {
                type: "jsonb",
                default: null,
              },
              output_context_schema: {
                type: "jsonb",
                default: null,
              },
              validate_input_context: {
                type: "boolean",
                default: false,
              },
              validate_output_context: {
                type: "boolean",
                default: false,
              },
              signals: {
                type: "jsonb",
                default: "'{}'",
              },
              intents: {
                type: "jsonb",
                default: "'{}'",
              },
              flags: {
                type: "jsonb",
                default: "'{}'",
              },
              generated_by: {
                type: "varchar",
                default: null,
                references: "generated_by_type(name)",
                onDelete: "set default",
                constraints: {
                  maxLength: 50,
                },
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: ["name", "service_name", "version"],
            indexes: [["is_meta", "is_deputy", "generated_by"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.task_created",
                    ["name", "service_name", "version"],
                  ),
                ],
                update: ["global.meta.graph_metadata.task_updated"],
              },
            },
          },

          actor: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              default_key: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 255,
                },
              },
              load_policy: {
                type: "varchar",
                default: "eager",
                constraints: {
                  maxLength: 25,
                },
              },
              write_contract: {
                type: "varchar",
                default: "overwrite",
                constraints: {
                  maxLength: 25,
                },
              },
              runtime_read_guard: {
                type: "varchar",
                default: "none",
                constraints: {
                  maxLength: 25,
                },
              },
              consistency_profile: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 25,
                },
              },
              key_definition: {
                type: "jsonb",
                default: null,
              },
              state_definition: {
                type: "jsonb",
                default: "'{}'",
              },
              retry_policy: {
                type: "jsonb",
                default: "'{}'",
              },
              idempotency_policy: {
                type: "jsonb",
                default: "'{}'",
              },
              session_policy: {
                type: "jsonb",
                default: "'{}'",
              },
              generated_by: {
                type: "varchar",
                default: null,
                references: "generated_by_type(name)",
                onDelete: "set default",
                constraints: {
                  maxLength: 50,
                },
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: ["name", "service_name", "version"],
            indexes: [["service_name", "is_meta"], ["generated_by"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.actor_created",
                    ["name", "service_name", "version"],
                  ),
                ],
                update: ["global.meta.graph_metadata.actor_updated"],
              },
            },
          },

          actor_task_map: {
            fields: {
              actor_name: {
                type: "varchar",
                required: true,
              },
              actor_version: {
                type: "int",
                default: 1,
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              mode: {
                type: "varchar",
                default: "read",
                constraints: {
                  maxLength: 25,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "actor_name",
              "actor_version",
              "task_name",
              "task_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "actor",
                fields: ["actor_name", "service_name", "actor_version"],
                referenceFields: ["name", "service_name", "version"],
              },
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            indexes: [["service_name", "mode", "is_meta"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.actor_task_associated",
                    [
                      "actor_name",
                      "actor_version",
                      "task_name",
                      "task_version",
                      "service_name",
                    ],
                  ),
                ],
              },
            },
          },

          actor_session_state: {
            fields: {
              id: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              actor_name: {
                type: "varchar",
                required: true,
              },
              actor_version: {
                type: "int",
                default: 1,
              },
              actor_key: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 255,
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              durable_state: {
                type: "jsonb",
                default: "'{}'",
                required: true,
              },
              durable_version: {
                type: "int",
                default: 0,
              },
              expires_at: {
                type: "timestamp",
                default: null,
              },
              updated: {
                type: "timestamp",
                default: "now()",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            uniqueConstraints: [["actor_name", "actor_version", "actor_key", "service_name"]],
            foreignKeys: [
              {
                tableName: "actor",
                fields: ["actor_name", "service_name", "actor_version"],
                referenceFields: ["name", "service_name", "version"],
              },
            ],
            indexes: [
              ["actor_name", "actor_key", "service_name"],
              ["updated"],
              ["expires_at"],
            ],
            customSignals: {
              triggers: {
                insert: ["global.meta.graph_metadata.actor_session_state_created"],
                update: ["global.meta.graph_metadata.actor_session_state_updated"],
              },
            },
          },

          directional_task_graph_map: {
            fields: {
              task_name: {
                type: "varchar",
                required: true,
              },
              predecessor_task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              predecessor_task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              predecessor_service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              execution_count: {
                type: "int",
                required: true,
                constraints: {
                  min: 0,
                  max: 2147483647,
                },
                default: 0,
              },
              last_executed: {
                type: "timestamp",
                default: null,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "task_name",
              "predecessor_task_name",
              "task_version",
              "predecessor_task_version",
              "service_name",
              "predecessor_service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "task",
                fields: [
                  "predecessor_task_name",
                  "predecessor_task_version",
                  "predecessor_service_name",
                ],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.task_relationship_created",
                    [
                      "task_name",
                      "predecessor_task_name",
                      "task_version",
                      "predecessor_task_version",
                      "service_name",
                      "predecessor_service_name",
                    ],
                  ),
                ],
                update: ["global.meta.graph_metadata.relationship_executed"],
              },
            },
          },

          routine: {
            fields: {
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              version: {
                type: "int",
                default: 1,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["is_meta"]],
            primaryKey: ["name", "service_name", "version"],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.routine_created",
                    ["name", "service_name", "version"],
                  ),
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.sync_controller.routine_added",
                    ["name", "service_name", "version"],
                  ),
                ],
                update: ["global.meta.graph_metadata.routine_updated"],
              },
            },
          },

          task_to_routine_map: {
            fields: {
              task_name: {
                type: "varchar",
                required: true,
              },
              routine_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              routine_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "task_name",
              "routine_name",
              "task_version",
              "routine_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
              {
                tableName: "routine",
                fields: ["routine_name", "routine_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.task_added_to_routine",
                    [
                      "task_name",
                      "routine_name",
                      "task_version",
                      "routine_version",
                      "service_name",
                    ],
                  ),
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.sync_controller.task_to_routine_map",
                    [
                      "task_name",
                      "routine_name",
                      "task_version",
                      "routine_version",
                      "service_name",
                    ],
                  ),
                ],
              },
            },
          },

          field_type: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              default_constraints: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            initialData: {
              fields: ["name", "description", "default_constraints"],
              data: [
                [
                  "string",
                  "Text data type",
                  '\'{"minLength": 0, "maxLength": 255}\'::jsonb',
                ],
                [
                  "int",
                  "Integer data type",
                  '\'{"min": -2147483648, "max": 2147483647}\'::jsonb',
                ],
                ["jsonb", "JSON binary data type", "'{\"schema\": {}}'::jsonb"],
                ["boolean", "Boolean data type", "'{}'::jsonb"],
                [
                  "decimal",
                  "Decimal number data type",
                  '\'{"min": -9999999999.99, "max": 9999999999.99}\'::jsonb',
                ],
                [
                  "timestamp",
                  "Timestamp data type",
                  '\'{"min": "1970-01-01T00:00:00Z", "max": "9999-12-31T23:59:59Z"}\'::jsonb',
                ],
                ["array", "Array data type", "'{\"items\": {}}'::jsonb"],
                ["object", "Object data type", "'{\"properties\": {}}'::jsonb"],
                [
                  "uuid",
                  "UUID data type",
                  '\'{"pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"}\'::jsonb',
                ],
                [
                  "date",
                  "Date data type",
                  '\'{"min": "1970-01-01", "max": "9999-12-31"}\'::jsonb',
                ],
                [
                  "geo_point",
                  "Geospatial point data type",
                  '\'{"type": "array", "items": [{"type": "number"}, {"type": "number"}]}\'::jsonb',
                ],
                ["bytea", "Binary data type", "'{}'::jsonb"],
                ["any", "Any data type", "'{}'::jsonb"],
              ],
            },
          },

          context_schema: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              version: {
                type: "int",
                required: true,
                default: 1,
              },
              description: {
                type: "text",
                default: "",
              },
              definition: {
                type: "jsonb",
                required: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["service_name"]],
            uniqueConstraints: [["name", "version"]],
          },

          context_schema_field: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              context_schema_id: {
                type: "uuid",
                references: "context_schema(uuid)",
                onDelete: "cascade",
                required: true,
              },
              field_name: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              field_type: {
                type: "varchar",
                references: "field_type(name)",
                onDelete: "set null",
                required: true,
                constraints: {
                  maxLength: 50,
                },
              },
              required: {
                type: "boolean",
                default: false,
              },
              description: {
                type: "text",
                default: "",
              },
              constraints: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            uniqueConstraints: [["context_schema_id", "field_name"]],
            indexes: [["field_type"]],
          },

          routine_execution: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              name: {
                type: "text",
                default: "",
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              meta_context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              result_context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              meta_result_context: {
                type: "jsonb", // TODO: change to bytea?
                default: "'{}'",
              },
              is_scheduled: {
                type: "boolean",
                default: true,
              },
              is_running: {
                type: "boolean",
                default: false,
              },
              is_complete: {
                type: "boolean",
                default: false,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              errored: {
                type: "boolean",
                default: false,
              },
              failed: {
                type: "boolean",
                default: false,
              },
              reached_timeout: {
                type: "boolean",
                default: false,
              },
              progress: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              started: {
                type: "timestamp",
                default: null,
              },
              ended: {
                type: "timestamp",
                default: null,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "service_instance_id",
                "service_name",
                "execution_trace_id",
                "is_meta",
                "errored",
                "failed",
                "is_running",
                "is_complete",
              ],
            ],
          },

          task_execution: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              meta_context: {
                type: "jsonb",
                default: "'{}'",
              },
              result_context: {
                type: "jsonb",
                default: "'{}'",
              },
              meta_result_context: {
                type: "jsonb",
                default: "'{}'",
              },
              split_group_id: {
                type: "uuid",
                default: null,
                description: "For grouping splits for visualization",
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                required: true,
              },
              previous_task_execution_ids: {
                type: "jsonb",
                default: "'[]'",
              },
              is_scheduled: {
                type: "boolean",
                default: true,
              },
              is_running: {
                type: "boolean",
                default: false,
              },
              is_complete: {
                type: "boolean",
                default: false,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              errored: {
                type: "boolean",
                default: false,
              },
              failed: {
                type: "boolean",
                default: false,
              },
              reached_timeout: {
                type: "boolean",
                default: false,
              },
              error_message: {
                type: "text",
                default: null,
              },
              progress: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              signal_emission_id: {
                type: "uuid",
                references: "signal_emission(uuid)",
                onDelete: "cascade",
                default: null,
              },
              inquiry_id: {
                type: "uuid",
                references: "inquiry(uuid)",
                onDelete: "cascade",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              started: {
                type: "timestamp",
                default: null,
              },
              ended: {
                type: "timestamp",
                default: null,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "routine_execution_id",
                "service_instance_id",
                "execution_trace_id",
                "is_meta",
                "errored",
                "failed",
                "is_running",
                "is_complete",
              ],
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          service_manifest: {
            fields: {
              service_instance_id: {
                type: "uuid",
                primary: true,
                required: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              revision: {
                type: "int",
                required: true,
                default: 1,
              },
              manifest_hash: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 255,
                },
              },
              published_at: {
                type: "timestamp",
                required: true,
                default: "now()",
              },
              manifest: {
                type: "jsonb",
                required: true,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["service_name", "published_at"]],
          },

          issuer_type: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 50,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            initialData: {
              fields: ["name", "description"],
              data: [
                ["browser_service", "Issuer from a browser-based service"],
                ["service", "Issuer from a Cadenza service"],
                ["ai_agent", "Issuer from an AI agent"],
                ["tool", "Issuer from a tool or automation"],
                ["dynamic_task", "Issuer from a dynamically generated task"],
              ],
            },
          },

          execution_trace: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              issuer_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                },
                references: "issuer_type(name)",
                onDelete: "restrict",
              },
              issuer_id: {
                type: "uuid",
                required: false,
                default: null,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              meta_context: {
                type: "jsonb",
                default: "'{}'",
              },
              intent: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 255,
                },
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "set null",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              issued_at: {
                type: "timestamp",
                default: "now()",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "issuer_type",
                "issuer_id",
                "service_instance_id",
                "is_meta",
                "deleted",
              ],
            ],
            meta: {
              appendOnly: true,
            },
          },

          service_instance: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              process_pid: {
                type: "int",
                required: true,
              },
              is_primary: {
                type: "boolean",
                default: true,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              is_database: {
                type: "boolean",
                default: false,
              },
              is_frontend: {
                type: "boolean",
                default: false,
              },
              is_blocked: {
                type: "boolean",
                default: false,
              },
              is_non_responsive: {
                type: "boolean",
                default: false,
              },
              is_active: {
                type: "boolean",
                default: true,
              },
              last_active: {
                // TODO
                type: "timestamp",
                default: null,
              },
              health: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "is_non_responsive",
                "is_active",
                "is_blocked",
                "is_primary",
                "service_name",
              ],
            ],
            customSignals: {
              triggers: {
                insert: [
                  "global.meta.service_registry.instance_registered",
                  "meta.service_registry.instance_registered",
                ],
                update: [
                  "global.meta.service_registry.service_handshake",
                  "global.meta.service_registry.service_not_responding",
                  "global.meta.sync_controller.synced",
                  "global.meta.service_registry.deleted",
                ],
              },
            },
          },

          service_instance_transport: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              role: {
                type: "varchar",
                required: true,
                constraints: {
                  oneOf: ["internal", "public"],
                  maxLength: 32,
                },
              },
              origin: {
                type: "text",
                required: true,
              },
              protocols: {
                type: "jsonb",
                default: "'[\"rest\",\"socket\"]'",
              },
              security_profile: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 32,
                },
              },
              auth_strategy: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 64,
                },
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["service_instance_id", "role"], ["role", "origin"]],
            uniqueConstraints: [["service_instance_id", "role", "origin"]],
            customSignals: {
              triggers: {
                insert: [
                  "global.meta.service_registry.transport_registered",
                  "meta.service_registry.transport_registered",
                ],
                update: [
                  "global.meta.service_registry.transport_updated",
                  "meta.service_registry.transport_updated",
                ],
              },
            },
          },

          service_instance_health_snapshot: {
            fields: {
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              cpu: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              memory: {
                type: "bigint",
                default: 0,
              },
              disk: {
                type: "bigint",
                default: 0,
              },
              network_io: {
                type: "bigint",
                default: 0,
              },
              gpu: {
                type: "decimal",
                constraints: {
                  min: 0,
                  max: 1,
                  precision: 3,
                  scale: 2,
                },
                default: 0.0,
              },
              uptime: {
                type: "bigint",
                default: 0,
              },
              latency: {
                type: "bigint",
                default: 0,
              },
              custom_metrics: {
                type: "jsonb",
                default: "'{}'",
              },
              snapshot_time: {
                type: "timestamp",
                default: "now()",
              },
            },
            primaryKey: ["service_instance_id", "snapshot_time"],
          },

          service_to_service_communication_map: {
            fields: {
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              service_instance_client_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              communication_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check: "communication_type IN ('delegation', 'signal')",
                },
              },
              last_executed: {
                // TODO
                type: "timestamp",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                // TODO
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "service_instance_id",
              "service_instance_client_id",
              "communication_type",
            ],
          },

          signal_registry: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 150,
                },
              },
              is_global: {
                type: "boolean",
                default: false,
              },
              domain: {
                type: "varchar",
                default: null,
                constraints: {
                  maxLength: 120,
                },
              },
              action: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 120,
                },
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["is_meta", "domain", "action", "is_global"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.signal_controller.signal_added",
                    ["name"],
                  ),
                ],
              },
            },
          },

          signal_to_task_map: {
            fields: {
              signal_name: {
                type: "varchar",
                required: true,
              },
              is_global: {
                type: "boolean",
                default: false,
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "signal_name",
              "task_name",
              "task_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.task_signal_observed",
                    [
                      "signal_name",
                      "task_name",
                      "task_version",
                      "service_name",
                    ],
                  ),
                ],
                update: [
                  // "meta.graph_metadata.task_unsubscribed_signal",
                  // "*.meta.graph_metadata.task_unsubscribed_signal",
                ],
              },
            },
          },

          signal_emission: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              signal_name: {
                type: "varchar",
                required: true,
              },
              signal_tag: {
                type: "varchar",
                default: null,
              },
              task_name: {
                type: "varchar",
                default: null,
              },
              task_version: {
                type: "int",
                default: null,
              },
              task_execution_id: {
                // circular reference
                // DEFERRABLE INITIALLY IMMEDIATE
                type: "uuid",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                default: null,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              metadata: {
                type: "jsonb",
                default: "'{}'",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              is_metric: {
                type: "boolean",
                default: false,
              },
              emitted_at: {
                type: "timestamp",
                default: "now()",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [
              [
                "signal_name",
                "service_name",
                "task_execution_id",
                "service_instance_id",
                "execution_trace_id",
                "is_meta",
                "emitted_at",
              ],
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            meta: {
              appendOnly: true,
            },
          },

          intent_registry: {
            fields: {
              name: {
                type: "varchar",
                primary: true,
                constraints: {
                  maxLength: 100,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              input: {
                type: "jsonb",
                default: '\'{"type": "object"}\'',
              },
              output: {
                type: "jsonb",
                default: '\'{"type": "object"}\'',
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [["is_meta"]],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.intent_created",
                    ["name"],
                  ),
                ],
                update: ["global.meta.graph_metadata.intent_updated"],
              },
            },
          },

          intent_to_task_map: {
            fields: {
              intent_name: {
                type: "varchar",
                required: true,
                references: "intent_registry(name)",
                onDelete: "cascade",
              },
              task_name: {
                type: "varchar",
                required: true,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            primaryKey: [
              "intent_name",
              "task_name",
              "task_version",
              "service_name",
            ],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
            customSignals: {
              triggers: {
                insert: [
                  buildInsertTriggerWithOnConflictDoNothing(
                    "global.meta.graph_metadata.task_intent_associated",
                    [
                      "intent_name",
                      "task_name",
                      "task_version",
                      "service_name",
                    ],
                  ),
                ],
              },
            },
          },

          inquiry: {
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              name: {
                type: "varchar",
                required: true,
                references: "intent_registry(name)",
                onDelete: "cascade",
              },
              task_name: {
                type: "varchar",
                default: null,
              },
              task_version: {
                type: "int",
                default: null,
              },
              task_execution_id: {
                // circular reference
                // DEFERRABLE INITIALLY IMMEDIATE
                type: "uuid",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                default: null,
              },
              context: {
                type: "jsonb",
                default: "'{}'",
              },
              metadata: {
                type: "jsonb",
                default: "'{}'",
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              sent_at: {
                type: "timestamp",
                default: "now()",
              },
              fulfilled_at: {
                type: "timestamp",
                default: null,
              },
              duration: {
                type: "int",
                default: 0,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [["is_meta", "task_execution_id"]],
            foreignKeys: [
              {
                tableName: "task",
                fields: ["task_name", "task_version", "service_name"],
                referenceFields: ["name", "version", "service_name"],
              },
            ],
          },

          schedule_registry: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              routine_name: {
                type: "varchar",
                default: null,
              },
              task_name: {
                type: "uuid",
                default: null,
              },
              task_version: {
                type: "int",
                default: 1,
              },
              routine_version: {
                type: "int",
                default: 1,
              },
              context_schema_id: {
                type: "uuid",
                references: "context_schema(uuid)",
                onDelete: "cascade",
                default: null,
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              // TODO service_instance_id? we need to know the service instance to schedule on
              schedule_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check:
                    "schedule_type IN ('interval', 'delay', 'timestamp', 'custom')",
                },
              },
              schedule_data: {
                type: "jsonb",
                default: "'{}'",
              },
              is_active: {
                type: "boolean",
                default: true,
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "is_meta",
                "routine_name",
                "task_name",
                "service_name",
                "schedule_type",
                "is_active",
              ],
            ],
            foreignKeys: [
              // { tableName: "task", fields: ["task_name", "task_version", "service_name"], referenceFields: ["name", "version", "service_name"] },
              // { tableName: "routine", fields: ["routine_name", "routine_version", "service_name"], referenceFields: ["name", "version", "service_name"] },
            ],
          },

          execution_tags: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              tag: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              description: {
                type: "text",
                default: "",
              },
              routine_execution_id: {
                type: "uuid",
                references: "routine_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              task_execution_id: {
                type: "uuid",
                references: "task_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              execution_trace_id: {
                type: "uuid",
                references: "execution_trace(uuid)",
                onDelete: "cascade",
                default: null,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            uniqueConstraints: [
              ["tag", "routine_execution_id", "task_execution_id"],
            ],
            indexes: [["service_instance_id", "execution_trace_id"]],
          },

          firewall_rule: {
            // TODO
            fields: {
              uuid: {
                type: "uuid",
                default: "gen_random_uuid()",
                primary: true,
              },
              rule_type: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check:
                    "rule_type IN ('allow', 'deny', 'throttle', 'transform')",
                },
              },
              applies_to: {
                type: "varchar",
                required: true,
                constraints: {
                  maxLength: 50,
                  check: "applies_to IN ('task', 'routine', 'service')",
                },
              },
              applies_to_id: {
                type: "uuid",
                required: true,
              },
              rule: {
                type: "jsonb",
                default: "'{}'",
                constraints: {
                  check: "rule IS NULL OR jsonb_typeof(rule) = 'object'",
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
                constraints: {
                  maxLength: 100,
                },
              },
              is_meta: {
                type: "boolean",
                default: false,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
              modified: {
                type: "timestamp",
                default: "now()",
              },
              deleted: {
                type: "boolean",
                default: false,
              },
            },
            indexes: [
              [
                "is_meta",
                "applies_to",
                "applies_to_id",
                "rule_type",
                "service_name",
              ],
            ],
          },

          system_log: {
            fields: {
              uuid: {
                type: "uuid",
                primary: true,
                default: "gen_random_uuid()",
              },
              message: {
                type: "text",
                default: "",
              },
              level: {
                type: "varchar",
                constraints: {
                  check: "level IN ('info', 'warning', 'error', 'critical')",
                },
              },
              service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                required: true,
              },
              service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                required: true,
              },
              subject_service_name: {
                type: "varchar",
                references: "service(name)",
                onDelete: "cascade",
                default: null,
              },
              subject_service_instance_id: {
                type: "uuid",
                references: "service_instance(uuid)",
                onDelete: "cascade",
                default: null,
              },
              data: {
                type: "jsonb",
                default: "'{}'",
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            indexes: [
              [
                "created",
                "level",
                "service_name",
                "service_instance_id",
                "subject_service_name",
                "subject_service_instance_id",
              ],
            ],
            customSignals: {
              triggers: {
                insert: ["global.meta.system_log.log"],
              },
            },
          },
        },
        meta: {
          dropExisting: options?.dropExisting ?? false,
        },
      } as any,
      "This is the official CadenzaDB database service. It is used to store metadata and execution data from the Cadenza framework.",
      {
        cadenzaDB: { connect: false },
        displayName: "Cadenza DB",
        databaseType: "postgres",
        databaseName: "cadenza_db",
        poolSize: 50,
        port: options?.port ?? parseInt(process.env.HTTP_PORT ?? "8080"),
      },
    );

    ExecutionPersistenceCoordinator.instance;
    registerAuthorityRuntimeStatusTasks();
    const ensureServiceManifestAuthorityTasks = () => {
      if (Cadenza.get("Report service manifest to authority")) {
        return true;
      }

      const localServiceManifestInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_manifest");
      if (!localServiceManifestInsertTask) {
        return false;
      }

      const reportServiceManifestTask = Cadenza.createMetaTask(
        "Report service manifest to authority",
        (ctx) => {
          const snapshot = normalizeServiceManifestSnapshot(ctx);
          if (!snapshot) {
            return false;
          }

          const manifestRow = {
            service_instance_id: snapshot.serviceInstanceId,
            service_name: snapshot.serviceName,
            revision: snapshot.revision,
            manifest_hash: snapshot.manifestHash,
            published_at: snapshot.publishedAt,
            manifest: snapshot,
            modified: snapshot.publishedAt,
            deleted: false,
          };

          return {
            ...ctx,
            __serviceManifestSnapshot: snapshot,
            data: manifestRow,
            queryData: {
              data: manifestRow,
              onConflict: {
                target: ["service_instance_id"],
                action: {
                  do: "update",
                  set: {
                    service_name: "excluded",
                    revision: "excluded",
                    manifest_hash: "excluded",
                    published_at: "excluded",
                    manifest: "excluded",
                    modified: "excluded",
                    deleted: "false",
                  },
                  where: "service_manifest.revision <= excluded.revision",
                },
              },
            },
          };
        },
        "Accepts full static service-manifest snapshots from remote services and routes them into the authority manifest store.",
      ).respondsTo(AUTHORITY_SERVICE_MANIFEST_REPORT_INTENT);

      const finalizeServiceManifestInsertTask = Cadenza.createMetaTask(
        "Finalize service manifest insert",
        (ctx, emit) => {
          const snapshot = normalizeServiceManifestSnapshot(
            ctx.__serviceManifestSnapshot,
          );
          if (!snapshot) {
            return {};
          }

          emit(AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL, {
            serviceName: snapshot.serviceName,
            serviceInstanceId: snapshot.serviceInstanceId,
            revision: snapshot.revision,
            manifestHash: snapshot.manifestHash,
            publishedAt: snapshot.publishedAt,
          });

          return {
            applied: true,
            serviceName: snapshot.serviceName,
            serviceInstanceId: snapshot.serviceInstanceId,
            revision: snapshot.revision,
          };
        },
        "Emits the manifest-derived sync payload after authority upserts a service manifest.",
        {
          isHidden: true,
        },
      );

      reportServiceManifestTask
        .then(localServiceManifestInsertTask)
        .then(finalizeServiceManifestInsertTask);

      return true;
    };

    ensureServiceManifestAuthorityTasks();

    Cadenza.createMetaTask(
      "Ensure authority service manifest flow is registered",
      () => ensureServiceManifestAuthorityTasks(),
      "Registers the authority manifest-report responder once generated local manifest insert tasks are available.",
      {
        register: false,
        isHidden: true,
      },
    ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");

    for (const delayMs of AUTHORITY_SERVICE_MANIFEST_ENSURE_DELAYS_MS) {
      Cadenza.schedule(
        "meta.service_registry.instance_inserted",
        {
          serviceInstance: {
            uuid: Cadenza.serviceRegistry.serviceInstanceId,
            serviceName: Cadenza.serviceRegistry.serviceName,
          },
          __reason: "authority_manifest_flow_startup_ensure",
        },
        delayMs,
      );
    }

    const ensureAuthorityRegistryProjectionTasks = () => {
      if (Cadenza.get("Project persisted authority registry state")) {
        return true;
      }

      let queryServiceInstanceTask;
      let queryServiceInstanceTransportTask;
      let queryServiceManifestTask;
      try {
        ({
          queryServiceInstanceTask,
          queryServiceInstanceTransportTask,
          queryServiceManifestTask,
        } = resolveLocalServiceRegistrySyncTasks());
      } catch {
        return false;
      }

      const normalizeProjectedServiceInstancesTask = Cadenza.createMetaTask(
        "Normalize projected authority service instances",
        (ctx) => ({
          ...ctx,
          serviceInstances: normalizeRowArray(ctx.rows ?? ctx.serviceInstances),
        }),
        "Normalizes persisted service-instance query rows for authority runtime projection.",
        {
          register: false,
          isHidden: true,
        },
      );

      const normalizeProjectedServiceInstanceTransportsTask = Cadenza.createMetaTask(
        "Normalize projected authority service instance transports",
        (ctx) => ({
          ...ctx,
          serviceInstanceTransports: normalizeRowArray(
            ctx.rows ?? ctx.serviceInstanceTransports,
          ),
        }),
        "Normalizes persisted service-instance transport query rows for authority runtime projection.",
        {
          register: false,
          isHidden: true,
        },
      );

      const normalizeProjectedServiceManifestsTask = Cadenza.createMetaTask(
        "Normalize projected authority service manifests",
        (ctx) => ({
          ...ctx,
          serviceManifests: normalizeRowArray(ctx.rows ?? ctx.serviceManifests),
        }),
        "Normalizes persisted service-manifest query rows for authority runtime projection.",
        {
          register: false,
          isHidden: true,
        },
      );

      const requestAuthorityRegistryProjectionTask = Cadenza.createMetaTask(
        "Request authority registry projection replay",
        (ctx) => {
          const reason =
            readString(ctx?.__reason) ||
            readString(ctx?.signal) ||
            "authority_registry_projection";
          Cadenza.debounce(
            META_AUTHORITY_REGISTRY_PROJECTION_EXECUTE,
            { __reason: reason },
            50,
          );
          return {
            requested: true,
            reason,
          };
        },
        "Requests a replay of persisted authority registry rows into runtime state.",
        {
          register: false,
          isHidden: true,
        },
      ).doOn(
        "global.meta.sync_controller.synced",
        META_AUTHORITY_REGISTRY_PROJECTION_REQUESTED,
      );

      const executeAuthorityRegistryProjectionTask = Cadenza.createMetaTask(
        "Execute authority registry projection replay",
        (ctx) => ({
          ...ctx,
        }),
        "Executes the persisted authority registry replay fan-out/fan-in graph.",
        {
          register: false,
          isHidden: true,
          isUnique: true,
        },
      ).doOn(META_AUTHORITY_REGISTRY_PROJECTION_EXECUTE);

      const projectAuthorityRegistryStateTask = Cadenza.createMetaTask(
        "Project persisted authority registry state",
        (ctx, emit) => {
          const serviceInstanceRows = normalizeRowArray(ctx.serviceInstances);
          const transportRows = normalizeRowArray(ctx.serviceInstanceTransports);
          const manifestRows = normalizeRowArray(ctx.serviceManifests);
          const transportsByInstance = new Map<string, Array<Record<string, unknown>>>();

          for (const row of transportRows) {
            const serviceInstanceId = readString(
              row.service_instance_id ?? row.serviceInstanceId,
            );
            if (!serviceInstanceId) {
              continue;
            }

            const existing = transportsByInstance.get(serviceInstanceId) ?? [];
            existing.push(row);
            transportsByInstance.set(serviceInstanceId, existing);
          }

          for (const row of serviceInstanceRows) {
            const uuid = readString(row.uuid);
            if (!uuid) {
              continue;
            }

            emit("global.meta.service_instance.updated", {
              serviceInstance: {
                ...row,
                transports: transportsByInstance.get(uuid) ?? [],
              },
            });
          }

          for (const row of manifestRows) {
            const snapshot = normalizeServiceManifestSnapshot(
              row.manifest && typeof row.manifest === "object" ? row.manifest : row,
            );
            if (!snapshot) {
              continue;
            }

            emit(AUTHORITY_SERVICE_MANIFEST_UPDATED_SIGNAL, {
              serviceName: snapshot.serviceName,
              serviceInstanceId: snapshot.serviceInstanceId,
              revision: snapshot.revision,
              manifestHash: snapshot.manifestHash,
              publishedAt: snapshot.publishedAt,
            });
          }

          logLocalSyncDebug("projected_authority_registry_state", {
            serviceInstances: serviceInstanceRows.length,
            serviceInstanceTransports: transportRows.length,
            serviceManifests: manifestRows.length,
          });

          return {
            projectedServiceInstances: serviceInstanceRows.length,
            projectedServiceInstanceTransports: transportRows.length,
            projectedServiceManifests: manifestRows.length,
          };
        },
        "Replays persisted service registry rows into the authority runtime registry after startup.",
        {
          register: false,
          isHidden: true,
          isUnique: true,
        },
      );

      executeAuthorityRegistryProjectionTask.then(
        queryServiceInstanceTask.then(normalizeProjectedServiceInstancesTask).then(
          projectAuthorityRegistryStateTask,
        ),
        queryServiceInstanceTransportTask.then(
          normalizeProjectedServiceInstanceTransportsTask,
        ).then(projectAuthorityRegistryStateTask),
        queryServiceManifestTask.then(normalizeProjectedServiceManifestsTask).then(
          projectAuthorityRegistryStateTask,
        ),
      );

      for (const delayMs of AUTHORITY_REGISTRY_PROJECTION_STARTUP_DELAYS_MS) {
        Cadenza.schedule(
          META_AUTHORITY_REGISTRY_PROJECTION_REQUESTED,
          {
            __reason: "authority_startup_registry_projection",
          },
          delayMs,
        );
      }

      return requestAuthorityRegistryProjectionTask;
    };

    ensureAuthorityRegistryProjectionTasks();

    Cadenza.createMetaTask(
      "Ensure authority registry projection flow is registered",
      () => ensureAuthorityRegistryProjectionTasks(),
      "Registers the authority persisted-registry projection flow once generated local query tasks are available.",
      {
        register: false,
        isHidden: true,
      },
    ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");

    const localIntentRegistryInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("intent_registry");
    const localIntentToTaskMapInsertTask =
      Cadenza.getLocalCadenzaDBInsertTask("intent_to_task_map");

    if (localIntentRegistryInsertTask && localIntentToTaskMapInsertTask) {
      const buildOnConflictDoNothing = (target: string[]) => ({
        target,
        action: {
          do: "nothing",
        },
      });

      const prepareIntentRegistryAssociationTask = Cadenza.createMetaTask(
        "Prepare direct intent registry insert from task-intent association",
        (ctx: any) => {
          const intentName =
            typeof ctx.data?.intentName === "string" ? ctx.data.intentName : "";

          if (!intentName) {
            return false;
          }

          const intentData = {
            name: intentName,
            isMeta:
              intentName.startsWith("meta.") ||
              intentName.startsWith("meta-") ||
              intentName.startsWith("global.meta."),
          };

          return {
            ...ctx,
            data: intentData,
            onConflict: buildOnConflictDoNothing(["name"]),
            queryData: {
              data: intentData,
              onConflict: buildOnConflictDoNothing(["name"]),
            },
            __intentMapData: ctx.data,
          };
        },
        "Builds a minimal intent_registry row from direct task-intent metadata.",
        {
          register: false,
          isHidden: true,
        },
      );

      const restoreIntentToTaskMapAssociationTask = Cadenza.createMetaTask(
        "Restore direct intent-to-task map insert payload",
        (ctx: any) => {
          const mapData = ctx.__intentMapData;
          const intentName =
            typeof mapData?.intentName === "string" ? mapData.intentName : "";
          const taskName =
            typeof mapData?.taskName === "string" ? mapData.taskName : "";
          const taskVersion = Number.isFinite(Number(mapData?.taskVersion))
            ? Number(mapData.taskVersion)
            : 1;
          const serviceName =
            typeof mapData?.serviceName === "string" ? mapData.serviceName : "";

          if (!intentName || !taskName || !serviceName) {
            return false;
          }

          const row = {
            intentName,
            taskName,
            taskVersion,
            serviceName,
          };

          return {
            ...ctx,
            data: row,
            onConflict: buildOnConflictDoNothing([
              "intent_name",
              "task_name",
              "task_version",
              "service_name",
            ]),
            queryData: {
              data: row,
              onConflict: buildOnConflictDoNothing([
                "intent_name",
                "task_name",
                "task_version",
                "service_name",
              ]),
            },
          };
        },
        "Builds direct intent_to_task_map rows from task-intent metadata.",
        {
          register: false,
          isHidden: true,
        },
      );

      prepareIntentRegistryAssociationTask
        .doOn("global.meta.graph_metadata.task_intent_associated")
        .then(localIntentRegistryInsertTask)
        .then(restoreIntentToTaskMapAssociationTask)
        .then(localIntentToTaskMapInsertTask);
    }

    const ensureAuthorityBootstrapRegistrationTasks = () => {
      const localServiceInstanceInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance");
      const localServiceInstanceTransportInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance_transport");
      if (
        !localServiceInstanceInsertTask ||
        !localServiceInstanceTransportInsertTask
      ) {
        return false;
      }

      if (!Cadenza.get(AUTHORITY_SERVICE_INSTANCE_REGISTER_TASK_NAME)) {
        Cadenza.createMetaTask(
          AUTHORITY_SERVICE_INSTANCE_REGISTER_TASK_NAME,
          (ctx: any) => {
            const row =
              readRecord(ctx?.queryData?.data) ?? readRecord(ctx?.data);
            if (!row) {
              return false;
            }

            return {
              ...ctx,
              data: row,
              queryData: {
                ...(readRecord(ctx?.queryData) ?? {}),
                data: row,
              },
            };
          },
          "Accepts bootstrap service_instance registrations from remote services and routes them into the authority instance store.",
        )
          .respondsTo(AUTHORITY_SERVICE_INSTANCE_REGISTER_INTENT)
          .then(localServiceInstanceInsertTask);
      }

      if (!Cadenza.get(AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_TASK_NAME)) {
        Cadenza.createMetaTask(
          AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_TASK_NAME,
          (ctx: any) => {
            const row =
              readRecord(ctx?.queryData?.data) ?? readRecord(ctx?.data);
            if (!row) {
              return false;
            }

            return {
              ...ctx,
              data: row,
              queryData: {
                ...(readRecord(ctx?.queryData) ?? {}),
                data: row,
              },
            };
          },
          "Accepts bootstrap service_instance_transport registrations from remote services and routes them into the authority transport store.",
        )
          .respondsTo(AUTHORITY_SERVICE_INSTANCE_TRANSPORT_REGISTER_INTENT)
          .then(localServiceInstanceTransportInsertTask);
      }

      return true;
    };

    ensureAuthorityBootstrapRegistrationTasks();

    Cadenza.createMetaTask(
      "Ensure authority bootstrap registration flow is registered",
      () => ensureAuthorityBootstrapRegistrationTasks(),
      "Registers the authority bootstrap registration responders once generated local service-instance insert tasks are available.",
      {
        register: false,
        isHidden: true,
      },
    ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");

    const ensureAuthorityOriginCanonicalizationTasks = () => {
      if (Cadenza.get("Execute service instance origin canonicalization sweep")) {
        return true;
      }

      const localServiceInstanceQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("service_instance");
      const localServiceInstanceInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance");
      const localServiceInstanceTransportInsertTask =
        Cadenza.getLocalCadenzaDBInsertTask("service_instance_transport");
      const localServiceInstanceTransportQueryTask =
        Cadenza.getLocalCadenzaDBQueryTask("service_instance_transport");
      const localServiceInstanceUpdateTask = Cadenza.getLocalCadenzaDBTask(
        "service_instance",
        "update",
      );
      const localServiceInstanceTransportUpdateTask =
        Cadenza.getLocalCadenzaDBTask("service_instance_transport", "update");

      if (
        !localServiceInstanceQueryTask ||
        !localServiceInstanceInsertTask ||
        !localServiceInstanceTransportInsertTask ||
        !localServiceInstanceTransportQueryTask ||
        !localServiceInstanceUpdateTask ||
        !localServiceInstanceTransportUpdateTask
      ) {
        return false;
      }

      Cadenza.createMetaTask(
        "Log local service instance insert for canonicalization debug",
        (ctx: any) => {
          console.log("[CADENZA_DB_CANONICALIZATION] local_instance_insert", {
            uuid: ctx?.data?.uuid ?? ctx?.uuid ?? null,
            serviceName:
              ctx?.data?.service_name ?? ctx?.service_name ?? null,
            isActive: ctx?.data?.is_active ?? ctx?.is_active ?? null,
          });
          return ctx;
        },
        "Debug-only trace for local service_instance inserts reaching authority canonicalization wiring.",
        {
          register: false,
          isHidden: true,
        },
      ).doAfter(localServiceInstanceInsertTask);

      Cadenza.createMetaTask(
        "Log local service instance transport insert for canonicalization debug",
        (ctx: any) => {
          console.log("[CADENZA_DB_CANONICALIZATION] local_transport_insert", {
            uuid: ctx?.data?.uuid ?? ctx?.uuid ?? null,
            serviceInstanceId:
              ctx?.data?.service_instance_id ?? ctx?.service_instance_id ?? null,
            origin: ctx?.data?.origin ?? ctx?.origin ?? null,
          });
          return ctx;
        },
        "Debug-only trace for local service_instance_transport inserts reaching authority canonicalization wiring.",
        {
          register: false,
          isHidden: true,
        },
      ).doAfter(localServiceInstanceTransportInsertTask);

      const localServiceInstanceReconciliationQueryTask =
        localServiceInstanceQueryTask.clone();
      const localServiceInstanceTransportByInstanceQueryTask =
        localServiceInstanceTransportQueryTask.clone();
      const localServiceInstanceTransportlessInstanceQueryTask =
        localServiceInstanceQueryTask.clone();
      const localServiceInstanceTransportLookupTask =
        localServiceInstanceTransportQueryTask.clone();
      const localServiceInstanceTransportReconciliationQueryTask =
        localServiceInstanceTransportQueryTask.clone();
      const localServiceInstanceTransportlessTransportQueryTask =
        localServiceInstanceTransportQueryTask.clone();
      const localServiceInstanceOriginCanonicalizationQueryTask =
        localServiceInstanceQueryTask.clone();
      const localServiceInstanceTransportOriginCanonicalizationQueryTask =
        localServiceInstanceTransportQueryTask.clone();

      const prepareOriginReconciliationLookupTask = Cadenza.createMetaTask(
        "Prepare service instance origin reconciliation lookup",
        (ctx: any) => {
          const descriptor = resolveServiceInstanceTransportTriggerDescriptor(ctx);
          if (!descriptor || descriptor.deleted) {
            return false;
          }

          return {
            ...ctx,
            __originReconciliationTrigger: descriptor,
            queryData: {
              filter: {
                uuid: descriptor.transportId,
              },
            },
          };
        },
        "Loads the authoritative transport row that triggered same-origin reconciliation.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareOriginReconciliationSeedTransportQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin reconciliation seed transport query",
          (ctx: any) => {
            const updateData =
              readRecord(ctx?.queryData?.data) ?? readRecord(ctx?.data);
            if (
              updateData &&
              (updateData.deleted === true ||
                updateData.is_active === false)
            ) {
              return false;
            }

            const instanceId = readString(
              ctx?.queryData?.data?.uuid ??
                ctx?.queryData?.filter?.uuid ??
                ctx?.data?.uuid ??
                ctx?.filter?.uuid ??
                ctx?.uuid ??
                ctx?.__serviceInstanceId,
            );
            if (!instanceId) {
              return false;
            }

            return {
              ...ctx,
              __originReconciliationAuthoritativeInstanceId: instanceId,
              queryData: {
                filter: {
                  service_instance_id: instanceId,
                  deleted: false,
                },
              },
            };
          },
          "Loads undeleted transports for an authoritative service instance so same-origin reconciliation can retry after instance-first writes.",
          {
            register: false,
            isHidden: true,
          },
        );

      const emitOriginReconciliationRequestsFromInstanceTask =
        Cadenza.createUniqueMetaTask(
          "Emit service instance origin reconciliation requests",
          (ctx: any) => {
            const authoritativeInstanceId = readString(
              ctx.__originReconciliationAuthoritativeInstanceId,
            );
            if (!authoritativeInstanceId) {
              return false;
            }

            const transports = Array.isArray(ctx.serviceInstanceTransports)
              ? ctx.serviceInstanceTransports
                  .map(normalizeServiceTransport)
                  .filter(Boolean)
              : [];

            let emitted = 0;
            for (const transport of transports) {
              if (
                !transport ||
                transport.deleted ||
                transport.serviceInstanceId !== authoritativeInstanceId
              ) {
                continue;
              }

              emitted += 1;
              Cadenza.emit(
                META_SERVICE_INSTANCE_ORIGIN_RECONCILIATION_REQUESTED,
                {
                  ...ctx,
                  data: {
                    uuid: transport.uuid,
                    service_instance_id: transport.serviceInstanceId,
                    role: transport.role,
                    origin: transport.origin,
                    deleted: transport.deleted,
                  },
                  queryData: {
                    filter: {
                      uuid: transport.uuid,
                    },
                  },
                },
              );
            }

            return emitted > 0
              ? {
                  ...ctx,
                  emittedOriginReconciliationRequests: emitted,
                }
              : false;
          },
          "Replays same-origin reconciliation from authoritative service_instance writes once their transports exist.",
          {
            register: false,
            isHidden: true,
          },
        );

      const prepareOriginReconciliationScanTask = Cadenza.createMetaTask(
        "Prepare service instance origin reconciliation scan",
        (ctx: any) => {
          const authoritativeTransport = normalizeServiceTransport(
            ctx.serviceInstanceTransports?.[0],
          );

          if (!authoritativeTransport || authoritativeTransport.deleted) {
            return false;
          }

          return {
            ...ctx,
            __originReconciliation: {
              authoritativeInstanceId: authoritativeTransport.serviceInstanceId,
              role: authoritativeTransport.role,
              origin: authoritativeTransport.origin,
            },
          };
        },
        "Captures the exact same-origin transport ownership key from the authoritative row.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareServiceInstanceReconciliationQueryTask = Cadenza.createMetaTask(
        "Prepare service instance origin reconciliation instance query",
        (ctx: any) => ({
          ...ctx,
          queryData: {
            filter: {
              deleted: false,
            },
          },
        }),
        "Loads active and inactive service_instance rows so authority can choose one same-origin owner.",
        {
          register: false,
          isHidden: true,
        },
      );

      const prepareServiceTransportReconciliationQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin reconciliation transport query",
          (ctx: any) => {
            const descriptor = ctx.__originReconciliation;
            if (!descriptor?.role || !descriptor?.origin) {
              return false;
            }

            return {
              ...ctx,
              queryData: {
                filter: {
                  role: descriptor.role,
                  origin: descriptor.origin,
                  deleted: false,
                },
              },
            };
          },
          "Loads matching same-origin transports for authority duplicate reconciliation.",
          {
            register: false,
            isHidden: true,
          },
        );

      const computeOriginReconciliationPlanTask = Cadenza.createUniqueMetaTask(
        "Compute service instance origin reconciliation plan",
        (ctx: any) => {
          let joinedContext: any = { ...ctx };
          for (const joined of Array.isArray(ctx.joinedContexts)
            ? ctx.joinedContexts
            : []) {
            joinedContext = {
              ...joinedContext,
              ...joined,
            };
          }

          const descriptor = joinedContext.__originReconciliation;
          if (!descriptor?.authoritativeInstanceId || !descriptor?.role || !descriptor?.origin) {
            return false;
          }

          const serviceInstances = Array.isArray(joinedContext.serviceInstances)
            ? joinedContext.serviceInstances
                .map(normalizeServiceInstance)
                .filter(Boolean)
            : [];
          const serviceInstanceTransports = Array.isArray(
            joinedContext.serviceInstanceTransports,
          )
            ? joinedContext.serviceInstanceTransports
                .map(normalizeServiceTransport)
                .filter(Boolean)
            : [];
          const authoritativeInstance = serviceInstances.find(
            (instance: ServiceInstanceDescriptor) =>
              instance.uuid === descriptor.authoritativeInstanceId,
          );

          if (!authoritativeInstance?.serviceName) {
            return false;
          }

          const plan = planServiceInstanceOriginReconciliation({
            authoritativeInstanceId: descriptor.authoritativeInstanceId,
            serviceName: authoritativeInstance.serviceName,
            role: descriptor.role,
            origin: descriptor.origin,
            serviceInstances,
            serviceInstanceTransports,
          });

          if (
            plan.retiredInstanceIds.length === 0 &&
            plan.retiredTransportIds.length === 0
          ) {
            return false;
          }

          for (const instanceId of plan.retiredInstanceIds) {
            Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE, {
              __originReconciliationPlan: plan,
              __originReconciliation: descriptor,
              data: {
                is_active: false,
                is_non_responsive: false,
                deleted: false,
              },
              queryData: {
                filter: {
                  uuid: instanceId,
                },
              },
            });
          }

          for (const transportId of plan.retiredTransportIds) {
            Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_TRANSPORT, {
              __originReconciliationPlan: plan,
              __originReconciliation: descriptor,
              __retiredServiceInstanceIds: plan.retiredInstanceIds,
              data: {
                deleted: true,
              },
              queryData: {
                filter: {
                  uuid: transportId,
                },
              },
            });
          }

          for (const instanceId of plan.retiredInstanceIds) {
            Cadenza.emit(META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE, {
              __originReconciliationPlan: plan,
              queryData: {
                filter: {
                  uuid: instanceId,
                },
              },
            });
          }

          return {
            ...joinedContext,
            __originReconciliationPlan: plan,
          };
        },
        "Collapses duplicate same-origin service-instance ownership on authority.",
        {
          register: false,
          isHidden: true,
        },
      );

      Cadenza.createMetaTask(
        "Retire superseded same-origin service instance",
        (ctx: any) => {
          const instanceId = readString(ctx?.queryData?.filter?.uuid);
          if (!instanceId) {
            return false;
          }

          const nextFilter = {
            uuid: instanceId,
          };
          const nextData = {
            is_active: false,
            is_non_responsive: false,
            deleted: false,
          };

          return {
            ...ctx,
            filter: {
              ...(ctx.filter ?? {}),
              ...nextFilter,
            },
            data: {
              ...(ctx.data ?? {}),
              ...nextData,
            },
            queryData: {
              ...(ctx.queryData ?? {}),
              filter: {
                ...(ctx.queryData?.filter ?? ctx.filter ?? {}),
                ...nextFilter,
              },
              data: {
                ...(ctx.queryData?.data ?? ctx.data ?? {}),
                ...nextData,
              },
            },
          };
        },
        "Marks superseded same-origin service instances inactive on authority.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE)
        .then(localServiceInstanceUpdateTask);

      Cadenza.createMetaTask(
        "Delete superseded same-origin service transport",
        (ctx: any) => {
          const transportId = readString(ctx?.queryData?.filter?.uuid);
          if (!transportId) {
            return false;
          }

          const nextFilter = {
            uuid: transportId,
          };
          const nextData = {
            deleted: true,
          };

          return {
            ...ctx,
            filter: {
              ...(ctx.filter ?? {}),
              ...nextFilter,
            },
            data: {
              ...(ctx.data ?? {}),
              ...nextData,
            },
            queryData: {
              ...(ctx.queryData ?? {}),
              filter: {
                ...(ctx.queryData?.filter ?? ctx.filter ?? {}),
                ...nextFilter,
              },
              data: {
                ...(ctx.queryData?.data ?? ctx.data ?? {}),
                ...nextData,
              },
            },
          };
        },
        "Deletes superseded same-origin service transports on authority.",
        {
          register: false,
          isHidden: true,
        },
      )
        .doOn(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_TRANSPORT)
        .then(localServiceInstanceTransportUpdateTask);

      const prepareTransportlessInstanceTransportQueryTask =
        Cadenza.createMetaTask(
          "Prepare transportless service instance transport query",
          (ctx: any) => {
            const instanceId = readString(ctx?.queryData?.filter?.uuid);
            if (!instanceId) {
              return false;
            }

            return {
              ...ctx,
              __transportlessServiceInstanceId: instanceId,
              queryData: {
                filter: {
                  service_instance_id: instanceId,
                  deleted: false,
                },
              },
            };
          },
          "Loads undeleted transports for a retired instance candidate.",
          {
            register: false,
            isHidden: true,
          },
        );

      const prepareTransportlessInstanceQueryTask = Cadenza.createMetaTask(
        "Prepare transportless service instance query",
        (ctx: any) => {
          const instanceId = readString(ctx?.queryData?.filter?.uuid);
          if (!instanceId) {
            return false;
          }

          return {
            ...ctx,
            __transportlessServiceInstanceId: instanceId,
            queryData: {
              filter: {
                uuid: instanceId,
                deleted: false,
              },
            },
          };
        },
        "Loads the retired instance candidate so authority can clear stale active rows with no transports.",
        {
          register: false,
          isHidden: true,
        },
      );

      const retireTransportlessServiceInstanceTask = Cadenza.createUniqueMetaTask(
        "Retire transportless service instance",
        (ctx: any) => {
          let joinedContext: any = { ...ctx };
          for (const joined of Array.isArray(ctx.joinedContexts)
            ? ctx.joinedContexts
            : []) {
            joinedContext = {
              ...joinedContext,
              ...joined,
            };
          }

          const instanceId = readString(
            joinedContext.__transportlessServiceInstanceId ??
              joinedContext.queryData?.filter?.uuid,
          );
          if (!instanceId) {
            return false;
          }

          const undeletedTransports = Array.isArray(
            joinedContext.serviceInstanceTransports,
          )
            ? joinedContext.serviceInstanceTransports
                .map(normalizeServiceTransport)
                .filter(Boolean)
            : [];
          if (undeletedTransports.length > 0) {
            return false;
          }

          const instance = Array.isArray(joinedContext.serviceInstances)
            ? joinedContext.serviceInstances
                .map(normalizeServiceInstance)
                .filter(Boolean)
                .find(
                  (candidate: ServiceInstanceDescriptor) =>
                    candidate.uuid === instanceId,
                )
            : null;
          if (!instance || instance.deleted || !instance.isActive) {
            return false;
          }

          Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE, {
            __transportlessServiceInstanceId: instanceId,
            data: {
              is_active: false,
              is_non_responsive: false,
              deleted: false,
            },
            queryData: {
              filter: {
                uuid: instanceId,
              },
            },
          });

          return {
            ...joinedContext,
            __retiredTransportlessServiceInstanceId: instanceId,
          };
        },
        "Clears stale active instance rows that no longer own any undeleted transports.",
        {
          register: false,
          isHidden: true,
        },
      );

      prepareTransportlessInstanceTransportQueryTask.doOn(
        META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE,
      );
      prepareTransportlessInstanceQueryTask.doOn(
        META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE,
      );
      localServiceInstanceTransportlessTransportQueryTask
        .doAfter(prepareTransportlessInstanceTransportQueryTask)
        .then(retireTransportlessServiceInstanceTask);
      localServiceInstanceTransportlessInstanceQueryTask
        .doAfter(prepareTransportlessInstanceQueryTask)
        .then(retireTransportlessServiceInstanceTask);

      prepareOriginReconciliationLookupTask.doAfter(
        localServiceInstanceTransportInsertTask,
        localServiceInstanceTransportUpdateTask,
      );
      prepareOriginReconciliationLookupTask.doOn(
        META_SERVICE_INSTANCE_ORIGIN_RECONCILIATION_REQUESTED,
      );
      prepareOriginReconciliationSeedTransportQueryTask
        .doAfter(
          localServiceInstanceInsertTask,
        )
        .attachSignal("global.meta.service_instance.created");
      localServiceInstanceTransportByInstanceQueryTask
        .doAfter(prepareOriginReconciliationSeedTransportQueryTask)
        .then(emitOriginReconciliationRequestsFromInstanceTask);
      localServiceInstanceTransportLookupTask.doAfter(
        prepareOriginReconciliationLookupTask,
      );
      prepareOriginReconciliationScanTask.doAfter(
        localServiceInstanceTransportLookupTask,
      );
      prepareServiceInstanceReconciliationQueryTask.doAfter(
        prepareOriginReconciliationScanTask,
      );
      prepareServiceTransportReconciliationQueryTask.doAfter(
        prepareOriginReconciliationScanTask,
      );
      localServiceInstanceReconciliationQueryTask
        .doAfter(prepareServiceInstanceReconciliationQueryTask)
        .then(computeOriginReconciliationPlanTask);
      localServiceInstanceTransportReconciliationQueryTask
        .doAfter(prepareServiceTransportReconciliationQueryTask)
        .then(computeOriginReconciliationPlanTask);

      const requestServiceInstanceOriginCanonicalizationSweepTask =
        Cadenza.createUniqueMetaTask(
          "Request service instance origin canonicalization sweep",
          (ctx: any) => {
            console.log("[CADENZA_DB_CANONICALIZATION] request", {
              reason: ctx?.__reason ?? null,
              attempt: ctx?.__attempt ?? null,
              serviceName: ctx?.data?.service_name ?? ctx?.service_name ?? null,
              transportOrigin: ctx?.data?.origin ?? ctx?.origin ?? null,
            });
            Cadenza.debounce(
              META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_EXECUTE,
              {
                ...ctx,
              },
              100,
            );
            return true;
          },
          "Requests one debounced authority canonicalization sweep for same-origin service-instance ownership.",
          {
            isHidden: true,
          },
        );

      requestServiceInstanceOriginCanonicalizationSweepTask.doOn(
        META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_REQUESTED,
        "global.meta.sync_controller.synced",
        "global.meta.service_instance.created",
        "meta.service_instance.created",
        "global.meta.service_registry.instance_registered",
        "meta.service_registry.instance_registered",
        "global.meta.service_registry.service_handshake",
        "global.meta.service_registry.service_not_responding",
        "global.meta.service_registry.deleted",
        "global.meta.service_instance_transport.created",
        "meta.service_instance_transport.created",
        "global.meta.service_registry.transport_registered",
        "meta.service_registry.transport_registered",
        "global.meta.service_registry.transport_updated",
        "meta.service_registry.transport_updated",
      );
      requestServiceInstanceOriginCanonicalizationSweepTask.doAfter(
        localServiceInstanceInsertTask,
        localServiceInstanceTransportInsertTask,
      );

      const executeServiceInstanceOriginCanonicalizationSweepTask =
        Cadenza.createUniqueMetaTask(
          "Execute service instance origin canonicalization sweep",
          (ctx: any) => {
            console.log("[CADENZA_DB_CANONICALIZATION] execute", {
              reason: ctx?.__reason ?? null,
              attempt: ctx?.__attempt ?? null,
              serviceName: ctx?.data?.service_name ?? ctx?.service_name ?? null,
              transportOrigin: ctx?.data?.origin ?? ctx?.origin ?? null,
            });
            return {
              ...ctx,
            };
          },
          "Executes one canonicalization sweep after the debounced request window closes.",
          {
            isHidden: true,
          },
        ).doOn(META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_EXECUTE);
      executeServiceInstanceOriginCanonicalizationSweepTask.doAfter(
        localServiceInstanceInsertTask,
        localServiceInstanceTransportInsertTask,
      );

      const prepareOriginCanonicalizationInstanceQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin canonicalization instance query",
          (ctx: any) => ({
            ...ctx,
            queryData: {
              filter: {
                deleted: false,
              },
            },
          }),
          "Loads all undeleted service_instance rows for authority same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const normalizeOriginCanonicalizationInstanceRowsTask =
        Cadenza.createMetaTask(
          "Normalize service instance origin canonicalization instance rows",
          (ctx: any) => ({
            ...ctx,
            serviceInstances: normalizeRowArray(ctx.rows ?? ctx.serviceInstances),
          }),
          "Normalizes queried service_instance rows for same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const prepareOriginCanonicalizationTransportQueryTask =
        Cadenza.createMetaTask(
          "Prepare service instance origin canonicalization transport query",
          (ctx: any) => ({
            ...ctx,
            queryData: {
              filter: {
                deleted: false,
              },
            },
          }),
          "Loads all undeleted service_instance_transport rows for authority same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const normalizeOriginCanonicalizationTransportRowsTask =
        Cadenza.createMetaTask(
          "Normalize service instance origin canonicalization transport rows",
          (ctx: any) => ({
            ...ctx,
            serviceInstanceTransports: normalizeRowArray(
              ctx.rows ?? ctx.serviceInstanceTransports,
            ),
          }),
          "Normalizes queried service_instance_transport rows for same-origin canonicalization.",
          {
            register: false,
            isHidden: true,
          },
        );

      const canonicalizeServiceInstanceOriginsTask = Cadenza.createUniqueMetaTask(
        "Canonicalize service instance origins",
        (ctx: any) => {
          let joinedContext: any = { ...ctx };
          for (const joined of Array.isArray(ctx.joinedContexts)
            ? ctx.joinedContexts
            : []) {
            joinedContext = {
              ...joinedContext,
              ...joined,
            };
          }

          const serviceInstances = Array.isArray(joinedContext.serviceInstances)
            ? joinedContext.serviceInstances
                .map(normalizeServiceInstance)
                .filter(Boolean)
            : [];
          const serviceInstanceTransports = Array.isArray(
            joinedContext.serviceInstanceTransports,
          )
            ? joinedContext.serviceInstanceTransports
                .map(normalizeServiceTransport)
                .filter(Boolean)
            : [];

          const plans = collectServiceInstanceOriginReconciliationPlans({
            serviceInstances,
            serviceInstanceTransports,
          });

          console.log("[CADENZA_DB_CANONICALIZATION] plans", {
            serviceInstanceCount: serviceInstances.length,
            serviceTransportCount: serviceInstanceTransports.length,
            planCount: plans.length,
            plans: plans.map((plan) => ({
              serviceName: plan.serviceName ?? null,
              role: plan.role ?? null,
              origin: plan.origin ?? null,
              winningInstanceId: plan.winningInstanceId ?? null,
              retiredInstanceIds: plan.retiredInstanceIds,
              retiredTransportIds: plan.retiredTransportIds,
            })),
          });

          if (!plans.length) {
            return false;
          }

          for (const plan of plans) {
            for (const instanceId of plan.retiredInstanceIds) {
              Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE, {
                __originCanonicalizationPlan: plan,
                data: {
                  is_active: false,
                  is_non_responsive: false,
                  deleted: false,
                },
                queryData: {
                  filter: {
                    uuid: instanceId,
                  },
                },
              });
            }

            for (const transportId of plan.retiredTransportIds) {
              Cadenza.emit(META_RETIRE_SUPERSEDED_SERVICE_INSTANCE_TRANSPORT, {
                __originCanonicalizationPlan: plan,
                __retiredServiceInstanceIds: plan.retiredInstanceIds,
                data: {
                  deleted: true,
                },
                queryData: {
                  filter: {
                    uuid: transportId,
                  },
                },
              });
            }

            for (const instanceId of plan.retiredInstanceIds) {
              Cadenza.emit(META_EVALUATE_TRANSPORTLESS_SERVICE_INSTANCE, {
                __originCanonicalizationPlan: plan,
                queryData: {
                  filter: {
                    uuid: instanceId,
                  },
                },
              });
            }
          }

          return {
            ...joinedContext,
            __originCanonicalizationPlans: plans,
          };
        },
        "Canonicalizes same-origin service-instance ownership from queried authority state.",
        {
          register: false,
          isHidden: true,
        },
      );

      const splitSupersededServiceInstanceRetirementsTask =
        Cadenza.createMetaTask(
          "Split superseded same-origin service instance retirements",
          function* (ctx: any) {
            const plans = Array.isArray(ctx?.__originCanonicalizationPlans)
              ? ctx.__originCanonicalizationPlans
              : [];

            console.log("[CADENZA_DB_CANONICALIZATION] split_instances", {
              planCount: plans.length,
            });

            for (const plan of plans) {
              for (const instanceId of Array.isArray(plan?.retiredInstanceIds)
                ? plan.retiredInstanceIds
                : []) {
                if (!readString(instanceId)) {
                  continue;
                }

                yield {
                  ...ctx,
                  __originCanonicalizationPlan: plan,
                  filter: {
                    uuid: instanceId,
                  },
                  data: {
                    is_active: false,
                    is_non_responsive: false,
                    deleted: false,
                  },
                  queryData: {
                    filter: {
                      uuid: instanceId,
                    },
                    data: {
                      is_active: false,
                      is_non_responsive: false,
                      deleted: false,
                    },
                  },
                };
              }
            }
          },
          "Projects canonicalized same-origin instance retirements directly into local update tasks.",
          {
            register: false,
            isHidden: true,
          },
        );

      const splitSupersededServiceTransportRetirementsTask =
        Cadenza.createMetaTask(
          "Split superseded same-origin service transport retirements",
          function* (ctx: any) {
            const plans = Array.isArray(ctx?.__originCanonicalizationPlans)
              ? ctx.__originCanonicalizationPlans
              : [];

            console.log("[CADENZA_DB_CANONICALIZATION] split_transports", {
              planCount: plans.length,
            });

            for (const plan of plans) {
              for (const transportId of Array.isArray(plan?.retiredTransportIds)
                ? plan.retiredTransportIds
                : []) {
                if (!readString(transportId)) {
                  continue;
                }

                yield {
                  ...ctx,
                  __originCanonicalizationPlan: plan,
                  __retiredServiceInstanceIds: Array.isArray(
                    plan?.retiredInstanceIds,
                  )
                    ? plan.retiredInstanceIds
                    : [],
                  filter: {
                    uuid: transportId,
                  },
                  data: {
                    deleted: true,
                  },
                  queryData: {
                    filter: {
                      uuid: transportId,
                    },
                    data: {
                      deleted: true,
                    },
                  },
                };
              }
            }
          },
          "Projects canonicalized same-origin transport retirements directly into local update tasks.",
          {
            register: false,
            isHidden: true,
          },
        );

      prepareOriginCanonicalizationInstanceQueryTask.doAfter(
        executeServiceInstanceOriginCanonicalizationSweepTask,
      );
      localServiceInstanceOriginCanonicalizationQueryTask
        .doAfter(prepareOriginCanonicalizationInstanceQueryTask)
        .then(normalizeOriginCanonicalizationInstanceRowsTask);
      prepareOriginCanonicalizationTransportQueryTask.doAfter(
        normalizeOriginCanonicalizationInstanceRowsTask,
      );
      localServiceInstanceTransportOriginCanonicalizationQueryTask
        .doAfter(prepareOriginCanonicalizationTransportQueryTask)
        .then(normalizeOriginCanonicalizationTransportRowsTask);
      normalizeOriginCanonicalizationTransportRowsTask.then(
        canonicalizeServiceInstanceOriginsTask,
      );
      canonicalizeServiceInstanceOriginsTask.then(
        splitSupersededServiceInstanceRetirementsTask,
        splitSupersededServiceTransportRetirementsTask,
      );
      splitSupersededServiceInstanceRetirementsTask.then(
        localServiceInstanceUpdateTask,
      );
      splitSupersededServiceTransportRetirementsTask.then(
        localServiceInstanceTransportUpdateTask,
      );

      for (const [index, delayMs] of SERVICE_INSTANCE_ORIGIN_CANONICALIZATION_STARTUP_DELAYS_MS.entries()) {
        Cadenza.schedule(
          META_CANONICALIZE_SERVICE_INSTANCE_ORIGINS_REQUESTED,
          {
            __attempt: index + 1,
            __reason: "cadenza_db_startup",
          },
          delayMs,
        );

      }
      return true;
    };

    ensureAuthorityOriginCanonicalizationTasks();

    Cadenza.createMetaTask(
      "Ensure authority origin canonicalization flow is registered",
      () => ensureAuthorityOriginCanonicalizationTasks(),
      "Registers the authority same-origin canonicalization flow once generated local service-instance tasks are available.",
      {
        register: false,
        isHidden: true,
      },
    ).doOn("meta.service_registry.instance_inserted", "global.meta.sync_controller.synced");
  }
}

if (process.env.NODE_ENV === "production") {
  CadenzaDB.createCadenzaDBService();
}
