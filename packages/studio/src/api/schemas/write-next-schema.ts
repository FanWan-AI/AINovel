/**
 * Validation schema for the write-next steering API.
 * Uses plain TypeScript validation to avoid adding new dependencies.
 */

export type WriteNextPace = "slow" | "balanced" | "fast";

/** Controls which planning path is used before writing the next chapter. */
export type WriteNextMode = "ai-plan" | "manual-plan" | "quick";

export interface WriteNextInput {
  /** Planning mode. Defaults to legacy steering-field behaviour when omitted. */
  readonly mode?: WriteNextMode;
  readonly wordCount?: number;
  readonly brief?: string;
  readonly chapterGoal?: string;
  readonly mustInclude?: string[];
  readonly mustAvoid?: string[];
  readonly pace?: WriteNextPace;
  /** Natural-language context fed to the AI planner when mode="ai-plan". */
  readonly planInput?: string;
}

export interface WriteNextValidationError {
  readonly field: string;
  readonly message: string;
}

export interface WriteNextValidationResult {
  readonly ok: true;
  readonly value: WriteNextInput;
}

export interface WriteNextValidationFailure {
  readonly ok: false;
  readonly errors: WriteNextValidationError[];
}

export type WriteNextValidation =
  | WriteNextValidationResult
  | WriteNextValidationFailure;

const VALID_PACES: ReadonlySet<string> = new Set(["slow", "balanced", "fast"]);
const VALID_MODES: ReadonlySet<string> = new Set(["ai-plan", "manual-plan", "quick"]);

function validateOptionalNonEmptyString(
  field: string,
  value: unknown,
  errors: WriteNextValidationError[],
): void {
  if (value !== undefined && value !== null) {
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push({ field, message: `${field} must be a non-empty string` });
    }
  }
}

function validateOptionalStringArray(
  field: string,
  value: unknown,
  errors: WriteNextValidationError[],
): void {
  if (value !== undefined && value !== null) {
    if (!Array.isArray(value)) {
      errors.push({ field, message: `${field} must be an array of strings` });
    } else {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string" || (value[i] as string).trim().length === 0) {
          errors.push({ field: `${field}[${i}]`, message: `each item in ${field} must be a non-empty string` });
        }
      }
    }
  }
}

/**
 * Validates the write-next request body. All fields are optional —
 * an empty body is valid (backward-compatible with legacy wordCount-only calls).
 */
export function validateWriteNextInput(body: unknown): WriteNextValidation {
  // Accept an absent or null body as an empty payload (backward compat)
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
  const errors: WriteNextValidationError[] = [];

  // wordCount: optional positive integer
  if (raw["wordCount"] !== undefined && raw["wordCount"] !== null) {
    if (typeof raw["wordCount"] !== "number" || !Number.isInteger(raw["wordCount"]) || raw["wordCount"] <= 0) {
      errors.push({ field: "wordCount", message: "wordCount must be a positive integer" });
    }
  }

  // mode: optional enum
  if (raw["mode"] !== undefined && raw["mode"] !== null) {
    if (typeof raw["mode"] !== "string" || !VALID_MODES.has(raw["mode"])) {
      errors.push({ field: "mode", message: 'mode must be one of "ai-plan", "manual-plan", or "quick"' });
    }
  }

  // brief: optional non-empty string
  validateOptionalNonEmptyString("brief", raw["brief"], errors);

  // chapterGoal: optional non-empty string
  validateOptionalNonEmptyString("chapterGoal", raw["chapterGoal"], errors);

  // mustInclude: optional array of non-empty strings
  validateOptionalStringArray("mustInclude", raw["mustInclude"], errors);

  // mustAvoid: optional array of non-empty strings
  validateOptionalStringArray("mustAvoid", raw["mustAvoid"], errors);

  // pace: optional enum
  if (raw["pace"] !== undefined && raw["pace"] !== null) {
    if (typeof raw["pace"] !== "string" || !VALID_PACES.has(raw["pace"])) {
      errors.push({ field: "pace", message: 'pace must be one of "slow", "balanced", or "fast"' });
    }
  }

  // planInput: optional non-empty string (used when mode="ai-plan")
  validateOptionalNonEmptyString("planInput", raw["planInput"], errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      mode: raw["mode"] as WriteNextMode | undefined,
      wordCount: raw["wordCount"] as number | undefined,
      brief: raw["brief"] as string | undefined,
      chapterGoal: raw["chapterGoal"] as string | undefined,
      mustInclude: raw["mustInclude"] as string[] | undefined,
      mustAvoid: raw["mustAvoid"] as string[] | undefined,
      pace: raw["pace"] as WriteNextPace | undefined,
      planInput: raw["planInput"] as string | undefined,
    },
  };
}
