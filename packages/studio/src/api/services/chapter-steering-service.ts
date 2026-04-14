/**
 * ChapterSteering service — persists per-book writing preference templates
 * (章节干预偏好) so users set them once and they are reused for every next chapter.
 *
 * Storage: books/{bookId}/steering-prefs.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFileError } from "../errors.js";

/** Current schema version — bump when adding breaking changes. */
export const STEERING_PREFS_SCHEMA_VERSION = 1 as const;

/** Maximum length for free-text fields to prevent abuse. */
const MAX_INSTRUCTIONS_LENGTH = 2000;
const MAX_STYLE_LENGTH = 500;

export interface ChapterSteeringPrefs {
  /** Schema version for forward-compat checks. */
  readonly schemaVersion: typeof STEERING_PREFS_SCHEMA_VERSION;
  /** ISO 8601 timestamp of the last update. */
  readonly updatedAt: string;
  /** Preferred word count per chapter. */
  readonly wordCount?: number;
  /** Writing style notes (e.g. "紧张、快节奏、多对话"). */
  readonly style?: string;
  /** Free-text instructions passed as externalContext to the pipeline. */
  readonly instructions?: string;
}

/** Allowed fields accepted from the client (excludes server-set fields). */
export interface ChapterSteeringPrefsInput {
  readonly wordCount?: number;
  readonly style?: string;
  readonly instructions?: string;
}

export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

/**
 * Validates a raw client-supplied input object.
 * Returns `{ ok: true, value }` on success or `{ ok: false, errors }` on failure.
 */
export function validateSteeringPrefsInput(
  raw: unknown,
): { ok: true; value: ChapterSteeringPrefsInput } | { ok: false; errors: ValidationError[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: "body", message: "Request body must be a JSON object." }] };
  }

  const body = raw as Record<string, unknown>;
  const errors: ValidationError[] = [];

  const { wordCount, style, instructions } = body;

  if (wordCount !== undefined) {
    if (typeof wordCount !== "number" || !Number.isInteger(wordCount) || wordCount < 100 || wordCount > 20000) {
      errors.push({ field: "wordCount", message: "wordCount must be an integer between 100 and 20000." });
    }
  }

  if (style !== undefined) {
    if (typeof style !== "string") {
      errors.push({ field: "style", message: "style must be a string." });
    } else if (style.length > MAX_STYLE_LENGTH) {
      errors.push({ field: "style", message: `style must not exceed ${MAX_STYLE_LENGTH} characters.` });
    }
  }

  if (instructions !== undefined) {
    if (typeof instructions !== "string") {
      errors.push({ field: "instructions", message: "instructions must be a string." });
    } else if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      errors.push({ field: "instructions", message: `instructions must not exceed ${MAX_INSTRUCTIONS_LENGTH} characters.` });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      ...(wordCount !== undefined ? { wordCount: wordCount as number } : {}),
      ...(style !== undefined ? { style: (style as string).trim() } : {}),
      ...(instructions !== undefined ? { instructions: (instructions as string).trim() } : {}),
    },
  };
}

/**
 * Loads steering preferences from `books/{bookId}/steering-prefs.json`.
 * Returns `null` when no preferences have been saved yet.
 */
export async function loadSteeringPrefs(bookDir: string): Promise<ChapterSteeringPrefs | null> {
  const filePath = join(bookDir, "steering-prefs.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as ChapterSteeringPrefs;
  } catch (e) {
    if (isMissingFileError(e)) return null;
    throw e;
  }
}

/**
 * Persists steering preferences to `books/{bookId}/steering-prefs.json`.
 * Creates the book directory if it does not exist yet.
 */
export async function saveSteeringPrefs(
  bookDir: string,
  input: ChapterSteeringPrefsInput,
  now = new Date().toISOString(),
): Promise<ChapterSteeringPrefs> {
  await mkdir(bookDir, { recursive: true });

  const prefs: ChapterSteeringPrefs = {
    schemaVersion: STEERING_PREFS_SCHEMA_VERSION,
    updatedAt: now,
    ...input,
  };

  const filePath = join(bookDir, "steering-prefs.json");
  await writeFile(filePath, JSON.stringify(prefs, null, 2), "utf-8");
  return prefs;
}
