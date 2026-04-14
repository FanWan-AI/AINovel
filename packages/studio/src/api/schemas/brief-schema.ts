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

/** Maximum allowed length for rawInput after normalization. */
export const RAW_INPUT_MAX_LENGTH = 12000;

/** Maximum allowed length for title after normalization. */
export const TITLE_MAX_LENGTH = 80;

/**
 * Maximum length for a single paragraph in rawInput.
 * Paragraphs exceeding this limit are truncated at the nearest sentence
 * boundary to preserve semantic meaning.
 */
export const PARAGRAPH_MAX_LENGTH = 2000;

/**
 * Normalizes text by:
 * 1. Normalizing line endings (CRLF/CR → LF)
 * 2. Converting full-width ASCII punctuation to half-width equivalents
 *    (e.g., ！→!, ？→?, ，→,) while preserving Chinese-specific punctuation
 *    (。、『』「」【】《》〈〉) as-is.
 * 3. Collapsing sequences of horizontal whitespace (spaces/tabs) to a
 *    single space within each line.
 * 4. Trimming leading/trailing whitespace from each line.
 * 5. Collapsing more than two consecutive blank lines into two.
 * 6. Trimming the overall result.
 */
export function normalizeBriefText(text: string): string {
  // 1. Normalize line endings
  let result = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 2. Convert full-width ASCII punctuation to half-width
  //    Covers common characters typed in full-width IME mode.
  result = result
    .replace(/！/g, "!")
    .replace(/？/g, "?")
    .replace(/；/g, ";")
    .replace(/：/g, ":")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .replace(/〔/g, "[")
    .replace(/〕/g, "]")
    .replace(/\u201C/g, '"')
    .replace(/\u201D/g, '"')
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/　/g, " "); // full-width space → regular space

  // 3 & 4. Collapse horizontal whitespace and trim each line
  result = result
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");

  // 5. Collapse more than two consecutive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  // 6. Trim overall
  return result.trim();
}

/**
 * Normalizes a paragraph by truncating it at the nearest sentence boundary
 * (。! ? . \n) if it exceeds PARAGRAPH_MAX_LENGTH, to avoid semantic loss
 * from mid-sentence cuts.
 */
function normalizeParagraph(paragraph: string): string {
  if (paragraph.length <= PARAGRAPH_MAX_LENGTH) {
    return paragraph;
  }

  // Try to find the last sentence boundary before the limit
  const truncated = paragraph.slice(0, PARAGRAPH_MAX_LENGTH);
  const boundaryMatch = /[。!?.\n][^。!?.\n]*$/.exec(truncated);
  if (boundaryMatch) {
    return truncated.slice(0, boundaryMatch.index + 1).trim();
  }

  // No boundary found — hard truncate
  return truncated.trim();
}

/**
 * Normalizes rawInput text including per-paragraph length capping.
 * Applies normalizeBriefText first, then enforces PARAGRAPH_MAX_LENGTH
 * on each paragraph, and finally enforces RAW_INPUT_MAX_LENGTH on the
 * total result.
 */
export function normalizeRawInput(rawInput: string): string {
  const normalized = normalizeBriefText(rawInput);

  // Normalize overly long paragraphs
  const paragraphs = normalized.split("\n\n").map(normalizeParagraph);
  const joined = paragraphs.join("\n\n");

  // Final hard cap to stay within max length
  if (joined.length > RAW_INPUT_MAX_LENGTH) {
    return joined.slice(0, RAW_INPUT_MAX_LENGTH).trim();
  }

  return joined;
}

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

  // title: required, non-empty string, max 80 chars (after normalization)
  let normalizedTitle = "";
  if (raw["title"] === undefined || raw["title"] === null) {
    errors.push({ field: "title", message: "title is required" });
  } else if (typeof raw["title"] !== "string") {
    errors.push({ field: "title", message: "title must be a non-empty string" });
  } else {
    normalizedTitle = normalizeBriefText(raw["title"]);
    if (normalizedTitle.length === 0) {
      errors.push({ field: "title", message: "title must be a non-empty string" });
    } else if (normalizedTitle.length > TITLE_MAX_LENGTH) {
      errors.push({ field: "title", message: `title must not exceed ${TITLE_MAX_LENGTH} characters` });
    }
  }

  // rawInput: required, non-empty string
  let normalizedRawInput = "";
  if (raw["rawInput"] === undefined || raw["rawInput"] === null) {
    errors.push({ field: "rawInput", message: "rawInput is required" });
  } else if (typeof raw["rawInput"] !== "string") {
    errors.push({ field: "rawInput", message: "rawInput must be a non-empty string" });
  } else {
    normalizedRawInput = normalizeRawInput(raw["rawInput"]);
    if (normalizedRawInput.length === 0) {
      errors.push({ field: "rawInput", message: "rawInput must be a non-empty string" });
    }
    // Note: normalizeRawInput already enforces RAW_INPUT_MAX_LENGTH, so no
    // rejection here — overly long input is truncated at paragraph boundaries.
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
      title: normalizedTitle,
      rawInput: normalizedRawInput,
      platform: raw["platform"] as string | undefined,
      language: (raw["language"] as "zh" | "en" | undefined) ?? undefined,
    },
  };
}
