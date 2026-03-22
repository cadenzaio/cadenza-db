import Cadenza from "@cadenza.io/service";
import { composeServiceRegistrySyncPayload } from "./serviceRegistrySync";

let CREATED = false;
let LOCAL_SYNC_INITIALIZED = false;
const SYNC_DEBUG_PREFIX = "[CADENZA_DB_SYNC_DEBUG]";
const LOCAL_SYNC_DEBUG_ENABLED =
  typeof process !== "undefined" &&
  typeof process.env === "object" &&
  process.env.CADENZA_DB_SYNC_DEBUG === "true";

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
  const queryIntentToTaskMapTask = resolveLocalSyncQueryTask(
    "intent_to_task_map",
  );
  const querySignalToTaskMapTask = resolveLocalSyncQueryTask(
    "signal_to_task_map",
  );

  if (
    !queryServiceInstanceTask ||
    !queryServiceInstanceTransportTask ||
    !queryIntentToTaskMapTask ||
    !querySignalToTaskMapTask
  ) {
    throw new Error(
      "CadenzaDB local sync query tasks are not available. Expected generated local query tasks for service_instance, service_instance_transport, intent_to_task_map, and signal_to_task_map.",
    );
  }

  return {
    queryServiceInstanceTask,
    queryServiceInstanceTransportTask,
    queryIntentToTaskMapTask,
    querySignalToTaskMapTask,
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
        queryIntentToTaskMapTask,
        querySignalToTaskMapTask,
      } = resolveLocalServiceRegistrySyncTasks();

      logLocalSyncDebug("start_throttle_sync", {
        queryServiceInstanceTask: queryServiceInstanceTask.name,
        queryServiceInstanceTransportTask: queryServiceInstanceTransportTask.name,
        queryIntentToTaskMapTask: queryIntentToTaskMapTask.name,
        querySignalToTaskMapTask: querySignalToTaskMapTask.name,
      });

      const prepareSignalSyncTask = Cadenza.createMetaTask(
        "Prepare for signal sync",
        (ctx) => {
          logLocalSyncDebug("prepare_signal_sync", {
            hasQueryData: typeof ctx.queryData === "object",
            queryData: ctx.queryData ?? null,
          });
          ctx.filter = {
            isGlobal: true,
          };

          return ctx;
        },
      );

      Cadenza.createUniqueMetaTask("Compile sync data and broadcast", (ctx) => {
        let joinedContext: any = {};
        ctx.joinedContexts.forEach((joined: any) => {
          joinedContext = { ...joinedContext, ...joined };
        });

        const syncPayload = composeServiceRegistrySyncPayload(joinedContext);
        syncPayload.__broadcast = true;
        logLocalSyncDebug("compile_sync_data", {
          serviceInstances: syncPayload.serviceInstances?.length ?? 0,
          intentToTaskMaps: syncPayload.intentToTaskMaps?.length ?? 0,
          signalToTaskMaps: syncPayload.signalToTaskMaps?.length ?? 0,
        });
        return syncPayload;
      })
        .doAfter(
          Cadenza.createMetaTask(
            "Forward service instance sync",
            (ctx) => {
              logLocalSyncDebug("forward_service_instance_sync", {
                rowCount: ctx.rowCount ?? null,
                serviceInstances: ctx.serviceInstances?.length ?? 0,
              });
              return ctx.__syncing;
            },
          ).doAfter(queryServiceInstanceTask),
          Cadenza.createMetaTask(
            "Forward service transport sync",
            (ctx) => {
              logLocalSyncDebug("forward_service_transport_sync", {
                rowCount: ctx.rowCount ?? null,
                serviceInstanceTransports:
                  ctx.serviceInstanceTransports?.length ?? 0,
              });
              return ctx.__syncing;
            },
          ).doAfter(queryServiceInstanceTransportTask),
          Cadenza.createMetaTask(
            "Forward intent to task map sync",
            (ctx) => {
              logLocalSyncDebug("forward_intent_to_task_map_sync", {
                rowCount: ctx.rowCount ?? null,
                intentToTaskMaps: ctx.intentToTaskMaps?.length ?? 0,
              });
              return ctx.__syncing;
            },
          ).doAfter(queryIntentToTaskMapTask),
          Cadenza.createMetaTask(
            "Forward signal to task map sync",
            (ctx) => {
              logLocalSyncDebug("forward_signal_to_task_map_sync", {
                rowCount: ctx.rowCount ?? null,
                signalToTaskMaps: ctx.signalToTaskMaps?.length ?? 0,
              });
              return ctx.__syncing;
            },
          ).doAfter(querySignalToTaskMapTask.doAfter(prepareSignalSyncTask)),
        )
        .emits("global.meta.cadenza_db.gathered_sync_data");

      Cadenza.createMetaRoutine("Sync services", [
        queryServiceInstanceTask,
        queryServiceInstanceTransportTask,
        queryIntentToTaskMapTask,
        prepareSignalSyncTask,
      ]).doOn("meta.cadenza_db.sync_tick");

      Cadenza.interval(
        "meta.cadenza_db.sync_tick",
        { __syncing: true },
        60000,
        true,
      );

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
        version: 1,
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
              routine_version: {
                type: "int",
                default: null,
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
              previous_routine_execution: {
                type: "uuid",
                references: "routine_execution(uuid)",
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
                "service_instance_id",
                "service_name",
                "routine_version",
                "execution_trace_id",
                "is_meta",
                "errored",
                "failed",
                "is_running",
                "is_complete",
                "previous_routine_execution",
              ],
            ],
            customSignals: {
              triggers: {
                insert: [
                  "global.meta.graph_metadata.routine_execution_created",
                ],
                update: [
                  "global.meta.graph_metadata.routine_execution_started",
                  "global.meta.graph_metadata.routine_execution_ended",
                  // TODO progress
                ],
              },
            },
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
              previous_execution_ids: {
                type: "jsonb",
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
            customSignals: {
              triggers: {
                insert: ["global.meta.graph_metadata.task_execution_created"],
                update: [
                  "global.meta.graph_metadata.task_execution_started",
                  "global.meta.graph_metadata.task_execution_ended",
                  // TODO: progress
                ],
              },
            },
          },

          task_execution_map: {
            fields: {
              task_execution_id: {
                type: "uuid",
                references: "task_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              previous_task_execution_id: {
                type: "uuid",
                references: "task_execution(uuid)",
                onDelete: "cascade",
                required: true,
              },
              created: {
                type: "timestamp",
                default: "now()",
              },
            },
            primaryKey: ["task_execution_id", "previous_task_execution_id"],
            customSignals: {
              triggers: {
                insert: ["global.meta.graph_metadata.task_execution_mapped"],
              },
            },
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
            customSignals: {
              triggers: {
                insert: ["global.meta.graph_metadata.execution_trace_created"],
              },
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
            customIntents: {
              query: [
                {
                  intent: "meta-service-registry-full-sync",
                  description:
                    "Collect data required for distributed service registry full sync.",
                  input: {
                    type: "object",
                    properties: {
                      syncScope: {
                        type: "string",
                        constraints: {
                          oneOf: ["service-registry-full-sync"],
                        },
                      },
                    },
                  },
                },
              ],
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
            customIntents: {
              query: [
                {
                  intent: "meta-service-registry-full-sync",
                  description:
                    "Collect data required for distributed service registry full sync.",
                  input: {
                    type: "object",
                    properties: {
                      syncScope: {
                        type: "string",
                        constraints: {
                          oneOf: ["service-registry-full-sync"],
                        },
                      },
                    },
                  },
                },
              ],
            },
          },

          service_instance_health_snapshot: {
            // TODO
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
            customSignals: {
              triggers: {
                insert: ["global.meta.fetch.service_communication_established"],
              },
            },
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
                references: "signal_registry(name)",
                onDelete: "cascade",
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
            customIntents: {
              query: [
                {
                  intent: "meta-service-registry-full-sync",
                  description:
                    "Collect data required for distributed service registry full sync.",
                  input: {
                    type: "object",
                    properties: {
                      syncScope: {
                        type: "string",
                        constraints: {
                          oneOf: ["service-registry-full-sync"],
                        },
                      },
                    },
                  },
                },
              ],
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
                references: "signal_registry(name)",
                onDelete: "cascade",
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
            customSignals: {
              triggers: {
                insert: ["global.sub_meta.signal_controller.signal_emitted"],
              },
            },
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
            customIntents: {
              query: [
                {
                  intent: "meta-service-registry-full-sync",
                  description:
                    "Collect data required for distributed service registry full sync.",
                  input: {
                    type: "object",
                    properties: {
                      syncScope: {
                        type: "string",
                        constraints: {
                          oneOf: ["service-registry-full-sync"],
                        },
                      },
                    },
                  },
                },
              ],
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
            customSignals: {
              triggers: {
                insert: ["global.meta.graph_metadata.inquiry_created"],
                update: ["global.meta.graph_metadata.inquiry_updated"],
              },
            },
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
      },
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
  }
}

if (process.env.NODE_ENV === "production") {
  CadenzaDB.createCadenzaDBService();
}
