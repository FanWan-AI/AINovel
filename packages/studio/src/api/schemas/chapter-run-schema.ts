export const CHAPTER_RUN_SCHEMA_VERSION = 1;
export const CHAPTER_RUN_DEFAULT_LIMIT = 20;
export const CHAPTER_RUN_MAX_LIMIT = 100;

export type ChapterRunActionType = "revise" | "rewrite" | "anti-detect" | "resync";
export type ChapterRunStatus = "running" | "succeeded" | "failed";
export type ChapterRunDecision = "applied" | "unchanged" | "failed";

export interface ChapterRunEvent {
  readonly index: number;
  readonly runId: string;
  readonly timestamp: string;
  readonly type: "start" | "success" | "fail";
  readonly status: ChapterRunStatus;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

export interface ChapterRunRecord {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly bookId: string;
  readonly chapter: number;
  readonly actionType: ChapterRunActionType;
  readonly status: ChapterRunStatus;
  readonly decision: ChapterRunDecision | null;
  readonly appliedBrief: string | null;
  readonly unchangedReason: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly events: readonly ChapterRunEvent[];
}

export interface ChapterRunListQuery {
  readonly chapter?: number;
  readonly limit: number;
}

export interface ChapterRunValidationError {
  readonly field: string;
  readonly message: string;
}

export type ChapterRunListValidation =
  | { readonly ok: true; readonly value: ChapterRunListQuery }
  | { readonly ok: false; readonly errors: ChapterRunValidationError[] };

export function validateChapterRunListQuery(params: Record<string, string | undefined>): ChapterRunListValidation {
  const errors: ChapterRunValidationError[] = [];
  let chapter: number | undefined;

  if (params["chapter"] !== undefined && params["chapter"] !== "") {
    const parsedChapter = Number(params["chapter"]);
    if (!Number.isInteger(parsedChapter) || parsedChapter < 1) {
      errors.push({ field: "chapter", message: "chapter must be a positive integer" });
    } else {
      chapter = parsedChapter;
    }
  }

  let limit = CHAPTER_RUN_DEFAULT_LIMIT;
  if (params["limit"] !== undefined && params["limit"] !== "") {
    const parsedLimit = Number(params["limit"]);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      errors.push({ field: "limit", message: "limit must be a positive integer" });
    } else {
      limit = Math.min(parsedLimit, CHAPTER_RUN_MAX_LIMIT);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { chapter, limit } };
}
