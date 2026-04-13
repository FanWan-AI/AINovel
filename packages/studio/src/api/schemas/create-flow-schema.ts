/**
 * Schema types for the CreateFlow v2 confirm API.
 * POST /api/v2/books/create/confirm
 */

export type CreateMode = "simple" | "pro";

export interface CreativeBrief {
  readonly title: string;
  readonly coreGenres?: string[];
  readonly positioning?: string;
  readonly worldSetting?: string;
  readonly protagonist?: string;
  readonly mainConflict?: string;
  readonly endingDirection?: string;
  readonly styleRules?: string[];
  readonly forbiddenPatterns?: string[];
  readonly [key: string]: unknown;
}

export interface ConfirmCreateBookConfig {
  readonly title: string;
  readonly genre: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
  readonly chapterWordCount?: number;
  readonly targetChapters?: number;
}

export interface ConfirmCreateRequest {
  readonly mode?: CreateMode;
  readonly briefId?: string;
  readonly brief?: CreativeBrief;
  readonly bookConfig: ConfirmCreateBookConfig;
}

export interface ConfirmCreateResponse {
  readonly status: "creating";
  readonly bookId: string;
}
