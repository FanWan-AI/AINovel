/**
 * Validation schema for the brief normalize API.
 * Uses plain TypeScript validation to avoid adding new dependencies.
 */

export interface NormalizeBriefInput {
  readonly mode: "simple" | "pro";
  readonly title: string;
  readonly rawInput: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
}

export interface NormalizeBriefValidationError {
  readonly field: string;
  readonly message: string;
}

export interface NormalizeBriefValidationResult {
  readonly ok: true;
  readonly value: NormalizeBriefInput;
}

export interface NormalizeBriefValidationFailure {
  readonly ok: false;
  readonly errors: NormalizeBriefValidationError[];
}

export type NormalizeBriefValidation =
  | NormalizeBriefValidationResult
  | NormalizeBriefValidationFailure;

export function validateNormalizeBriefInput(body: unknown): NormalizeBriefValidation {
  const errors: NormalizeBriefValidationError[] = [];

  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      errors: [{ field: "body", message: "Request body must be a JSON object" }],
    };
  }

  const raw = body as Record<string, unknown>;

  // mode: required, must be "simple" or "pro"
  if (raw["mode"] === undefined || raw["mode"] === null) {
    errors.push({ field: "mode", message: "mode is required" });
  } else if (raw["mode"] !== "simple" && raw["mode"] !== "pro") {
    errors.push({ field: "mode", message: 'mode must be "simple" or "pro"' });
  }

  // title: required, non-empty string, max 80 chars
  if (raw["title"] === undefined || raw["title"] === null) {
    errors.push({ field: "title", message: "title is required" });
  } else if (typeof raw["title"] !== "string" || raw["title"].trim().length === 0) {
    errors.push({ field: "title", message: "title must be a non-empty string" });
  } else if (raw["title"].trim().length > 80) {
    errors.push({ field: "title", message: "title must not exceed 80 characters" });
  }

  // rawInput: required, non-empty string, max 12000 chars
  if (raw["rawInput"] === undefined || raw["rawInput"] === null) {
    errors.push({ field: "rawInput", message: "rawInput is required" });
  } else if (typeof raw["rawInput"] !== "string" || raw["rawInput"].trim().length === 0) {
    errors.push({ field: "rawInput", message: "rawInput must be a non-empty string" });
  } else if (raw["rawInput"].length > 12000) {
    errors.push({ field: "rawInput", message: "rawInput must not exceed 12000 characters" });
  }

  // platform: optional string
  if (raw["platform"] !== undefined && raw["platform"] !== null && typeof raw["platform"] !== "string") {
    errors.push({ field: "platform", message: "platform must be a string" });
  }

  // language: optional, must be "zh" or "en" if provided
  if (raw["language"] !== undefined && raw["language"] !== null) {
    if (raw["language"] !== "zh" && raw["language"] !== "en") {
      errors.push({ field: "language", message: 'language must be "zh" or "en"' });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      mode: raw["mode"] as "simple" | "pro",
      title: (raw["title"] as string).trim(),
      rawInput: raw["rawInput"] as string,
      platform: raw["platform"] as string | undefined,
      language: (raw["language"] as "zh" | "en" | undefined) ?? undefined,
    },
  };
}
