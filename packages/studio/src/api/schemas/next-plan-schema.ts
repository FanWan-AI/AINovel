/**
 * Schema types and validation for the next-plan preview API.
 * POST /api/books/:id/next-plan
 */

export interface NextPlanInput {
  readonly brief?: string;
}

export interface NextPlanResult {
  readonly goal: string;
  readonly conflicts: ReadonlyArray<string>;
  readonly chapterNumber: number;
}

export interface NextPlanResponse {
  readonly plan: NextPlanResult;
}

export interface NextPlanValidationError {
  readonly field: string;
  readonly message: string;
}

export interface NextPlanValidationSuccess {
  readonly ok: true;
  readonly value: NextPlanInput;
}

export interface NextPlanValidationFailure {
  readonly ok: false;
  readonly errors: NextPlanValidationError[];
}

export type NextPlanValidation = NextPlanValidationSuccess | NextPlanValidationFailure;

/**
 * Validates the request body for POST /api/books/:id/next-plan.
 * `brief` is optional; if provided it must be a non-empty string.
 * An empty payload `{}` or `null` body is treated as "no brief provided" and is valid.
 */
export function validateNextPlanInput(body: unknown): NextPlanValidation {
  // Treat missing/null body as empty object — no brief
  if (body === null || body === undefined) {
    return { ok: true, value: {} };
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      errors: [{ field: "body", message: "Request body must be a JSON object" }],
    };
  }

  const raw = body as Record<string, unknown>;
  const errors: NextPlanValidationError[] = [];

  if (raw["brief"] !== undefined && raw["brief"] !== null) {
    if (typeof raw["brief"] !== "string") {
      errors.push({ field: "brief", message: "brief must be a string" });
    } else if (raw["brief"].trim().length === 0) {
      errors.push({ field: "brief", message: "brief must not be blank" });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      brief: typeof raw["brief"] === "string" ? raw["brief"].trim() : undefined,
    },
  };
}
