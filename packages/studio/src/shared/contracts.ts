/**
 * Shared TypeScript contracts for Studio API/UI communication.
 * Ported from PR #96 (Te9ui1a) — prevents client/server type drift.
 */

// --- Health ---

export interface HealthStatus {
  readonly status: "ok";
  readonly projectRoot: string;
  readonly projectConfigFound: boolean;
  readonly envFound: boolean;
  readonly projectEnvFound: boolean;
  readonly globalConfigFound: boolean;
  readonly bookCount: number;
  readonly provider: string | null;
  readonly model: string | null;
}

// --- Books ---

export interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly platform: string;
  readonly genre: string;
  readonly targetChapters: number;
  readonly chapters: number;
  readonly chapterCount: number;
  readonly lastChapterNumber: number;
  readonly totalWords: number;
  readonly approvedChapters: number;
  readonly pendingReview: number;
  readonly pendingReviewChapters: number;
  readonly failedReview: number;
  readonly failedChapters: number;
  readonly recentRunStatus?: string | null;
  readonly updatedAt: string;
}

export interface BookDetail extends BookSummary {
  readonly createdAt: string;
  readonly chapterWordCount: number;
  readonly language: "zh" | "en" | null;
}

// --- Chapters ---

export interface ChapterSummary {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssueCount: number;
  readonly updatedAt: string;
  readonly fileName: string | null;
}

export interface ChapterDetail extends ChapterSummary {
  readonly auditIssues: ReadonlyArray<string>;
  readonly reviewNote?: string;
  readonly content: string;
}

export interface SaveChapterPayload {
  readonly content: string;
}

// --- Truth Files ---

export interface TruthFileSummary {
  readonly name: string;
  readonly label: string;
  readonly exists: boolean;
  readonly path: string;
  readonly optional: boolean;
  readonly available: boolean;
}

export interface TruthFileDetail extends TruthFileSummary {
  readonly content: string | null;
}

// --- Review ---

export interface ReviewActionPayload {
  readonly chapterNumber: number;
  readonly reason?: string;
}

// --- Runs ---

export type RunAction = "draft" | "audit" | "revise" | "write-next";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface RunLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface RunActionPayload {
  readonly chapterNumber?: number;
}

export interface StudioRun {
  readonly id: string;
  readonly bookId: string;
  readonly chapter: number | null;
  readonly chapterNumber: number | null;
  readonly action: RunAction;
  readonly status: RunStatus;
  readonly stage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly logs: ReadonlyArray<RunLogEntry>;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RunStreamEvent {
  readonly type: "snapshot" | "status" | "stage" | "log";
  readonly runId: string;
  readonly run?: StudioRun;
  readonly status?: RunStatus;
  readonly stage?: string;
  readonly log?: RunLogEntry;
  readonly result?: unknown;
  readonly error?: string;
}

// --- API Error Response ---

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

// --- Brief (v2 CreateFlow) ---

export type CreateMode = "simple" | "pro";

export interface CreativeBrief {
  readonly title: string;
  readonly coreGenres: string[];
  readonly positioning: string;
  readonly worldSetting: string;
  readonly protagonist: string;
  readonly mainConflict: string;
  readonly endingDirection?: string;
  readonly styleRules: string[];
  readonly forbiddenPatterns: string[];
  readonly targetAudience?: string;
  readonly platformIntent?: string;
}

export interface NormalizeBriefRequest {
  readonly mode: CreateMode;
  readonly title: string;
  readonly rawInput: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
}

export interface NormalizeBriefResponse {
  readonly briefId: string;
  readonly normalizedBrief: CreativeBrief;
}

export interface ConfirmCreateResponse {
  readonly status: "creating";
  readonly bookId: string;
}

// --- Runtime Center ---

export type RuntimeEventSource = "daemon" | "pipeline" | "system" | "agent" | "user-action";
export type RuntimeEventLevel = "info" | "warn" | "error";

export interface RuntimeEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly source: RuntimeEventSource;
  readonly level: RuntimeEventLevel;
  readonly event: string;
  readonly data: unknown;
  readonly bookId?: string;
}

export interface RuntimeOverview {
  readonly daemonRunning: boolean;
  readonly sseClientCount: number;
  readonly recentErrorCount: number;
  readonly eventCount: number;
}

export interface RuntimeEventsResponse {
  readonly entries: ReadonlyArray<RuntimeEvent>;
  readonly total: number;
}

export interface RuntimeClearResponse {
  readonly ok: true;
  readonly cleared: number;
}
