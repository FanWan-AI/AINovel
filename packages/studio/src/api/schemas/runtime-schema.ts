/**
 * Validation schema for the runtime center query API.
 * Uses plain TypeScript validation to avoid adding new dependencies.
 */

export type RuntimeEventSource = "daemon" | "pipeline" | "system" | "agent" | "user-action";
export type RuntimeEventLevel = "info" | "warn" | "error";

export const RUNTIME_EVENT_SOURCES: readonly RuntimeEventSource[] = [
  "daemon",
  "pipeline",
  "system",
  "agent",
  "user-action",
];

export const RUNTIME_EVENT_LEVELS: readonly RuntimeEventLevel[] = ["info", "warn", "error"];

export const RUNTIME_EVENTS_DEFAULT_LIMIT = 100;
export const RUNTIME_EVENTS_MAX_LIMIT = 500;

export interface RuntimeEventsQuery {
  readonly source?: RuntimeEventSource;
  readonly level?: RuntimeEventLevel;
  readonly bookId?: string;
  readonly limit: number;
}

export interface RuntimeEventsValidationError {
  readonly field: string;
  readonly message: string;
}

export interface RuntimeEventsValidationResult {
  readonly ok: true;
  readonly value: RuntimeEventsQuery;
}

export interface RuntimeEventsValidationFailure {
  readonly ok: false;
  readonly errors: RuntimeEventsValidationError[];
}

export type RuntimeEventsValidation =
  | RuntimeEventsValidationResult
  | RuntimeEventsValidationFailure;

/**
 * Validates and parses query parameters for GET /api/runtime/events.
 */
export function validateRuntimeEventsQuery(params: Record<string, string | undefined>): RuntimeEventsValidation {
  const errors: RuntimeEventsValidationError[] = [];

  // source: optional, must be one of the valid sources
  let source: RuntimeEventSource | undefined;
  if (params["source"] !== undefined && params["source"] !== "") {
    if (!RUNTIME_EVENT_SOURCES.includes(params["source"] as RuntimeEventSource)) {
      errors.push({
        field: "source",
        message: `source must be one of: ${RUNTIME_EVENT_SOURCES.join(", ")}`,
      });
    } else {
      source = params["source"] as RuntimeEventSource;
    }
  }

  // level: optional, must be one of the valid levels
  let level: RuntimeEventLevel | undefined;
  if (params["level"] !== undefined && params["level"] !== "") {
    if (!RUNTIME_EVENT_LEVELS.includes(params["level"] as RuntimeEventLevel)) {
      errors.push({
        field: "level",
        message: `level must be one of: ${RUNTIME_EVENT_LEVELS.join(", ")}`,
      });
    } else {
      level = params["level"] as RuntimeEventLevel;
    }
  }

  // bookId: optional string
  const bookId = params["bookId"] !== undefined && params["bookId"] !== "" ? params["bookId"] : undefined;

  // limit: optional integer, defaults to RUNTIME_EVENTS_DEFAULT_LIMIT
  let limit = RUNTIME_EVENTS_DEFAULT_LIMIT;
  if (params["limit"] !== undefined && params["limit"] !== "") {
    const parsed = Number(params["limit"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push({ field: "limit", message: "limit must be a positive integer" });
    } else {
      limit = Math.min(parsed, RUNTIME_EVENTS_MAX_LIMIT);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { source, level, bookId, limit } };
}
