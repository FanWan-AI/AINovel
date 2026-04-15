import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  StateManager,
  PipelineRunner,
  createLLMClient,
  createLogger,
  computeAnalytics,
  loadProjectConfig,
  type PipelineConfig,
  type ProjectConfig,
  type RunPlan,
  type LogSink,
  type LogEntry,
} from "@actalk/inkos-core";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";
import { buildStudioBookConfig } from "./book-create.js";
import { confirmCreateBook, briefToExternalContext } from "./services/create-flow-service.js";
import type { ConfirmCreateRequest } from "./schemas/create-flow-schema.js";
import { validateNormalizeBriefInput } from "./schemas/brief-schema.js";
import { normalizeBrief } from "./services/brief-service.js";
import { validateNextPlanInput } from "./schemas/next-plan-schema.js";
import { previewNextPlan, PlanLowConfidenceError } from "./services/next-plan-service.js";
import { validateWriteNextInput } from "./schemas/write-next-schema.js";
import { buildWriteNextExternalContext, buildWriteNextContextFromPlan } from "./services/write-next-service.js";
import { BookCreateRunStore } from "./lib/run-store.js";
import { runtimeEventStore, deriveRuntimeEvent } from "./lib/runtime-event-store.js";
import {
  loadSteeringPrefs,
  saveSteeringPrefs,
  validateSteeringPrefsInput,
} from "./services/chapter-steering-service.js";
import {
  validateRuntimeEventsQuery,
  RUNTIME_EVENTS_DEFAULT_LIMIT,
  RUNTIME_EVENTS_MAX_LIMIT,
  type RuntimeEventSource,
  type RuntimeEventLevel,
} from "./schemas/runtime-schema.js";
import { validateDaemonPlanRequest, validateDaemonStartRequest } from "./schemas/daemon-plan-schema.js";
import {
  validateChapterRunListQuery,
  type ChapterRunActionType,
  type ChapterRunRecord,
} from "./schemas/chapter-run-schema.js";
import { ChapterRunStore, inferRunDecision } from "./lib/chapter-run-store.js";
import type {
  RuntimeEvent,
  RuntimeOverview,
  RuntimeEventsResponse,
  RuntimeClearResponse,
  DaemonSessionSummary,
  DaemonSessionState,
  DaemonSessionErrorSummary,
} from "../shared/contracts.js";

// --- Event bus for SSE ---

type EventHandler = (event: string, data: unknown) => void;
const subscribers = new Set<EventHandler>();
const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();
// Runtime lifecycle actions emitted for human-readable run narration in Studio.
type RuntimeAction = "revise" | "rewrite" | "anti-detect" | "resync" | "plan" | "compose" | "write-next";
// Common lifecycle stages for runtime actions.
type RuntimeActionStage = "start" | "progress" | "success" | "fail" | "unchanged";
const NO_REVISIONS_APPLIED_MESSAGE = "No revisions were applied.";
const NO_TRUTH_ARTIFACT_UPDATES_MESSAGE = "No truth artifacts required updates.";
const BRIEF_TRACE_MAX_ITEMS = 8;
const WRITING_GOVERNANCE_SCHEMA_VERSION = 1;
const WRITING_STYLE_TEMPLATE_VALUES = ["narrative-balance", "dialogue-driven", "cinematic"] as const;
const REVIEW_STRICTNESS_BASELINE_VALUES = ["balanced", "strict", "strict-plus"] as const;
const ANTI_AI_TRACE_STRENGTH_VALUES = ["medium", "high", "max"] as const;

type WritingStyleTemplate = (typeof WRITING_STYLE_TEMPLATE_VALUES)[number];
type ReviewStrictnessBaseline = (typeof REVIEW_STRICTNESS_BASELINE_VALUES)[number];
type AntiAiTraceStrength = (typeof ANTI_AI_TRACE_STRENGTH_VALUES)[number];

interface WritingGovernanceSettings {
  readonly schemaVersion: number;
  readonly styleTemplate: WritingStyleTemplate;
  readonly reviewStrictnessBaseline: ReviewStrictnessBaseline;
  readonly antiAiTraceStrength: AntiAiTraceStrength;
  readonly updatedAt: string;
  readonly extensions?: Record<string, unknown>;
}

interface WritingGovernanceValidationError {
  readonly field: string;
  readonly message: string;
}

interface BriefTraceEntry {
  readonly text: string;
  readonly matched: boolean;
}

interface ChapterRunDiffData {
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
  readonly briefTrace: ReadonlyArray<BriefTraceEntry>;
  readonly pendingApproval: boolean;
}

interface ManualCandidateRevision {
  readonly content: string;
  readonly wordCount: number;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly status: "ready-for-review" | "audit-failed";
  readonly auditIssues: ReadonlyArray<string>;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: unknown;
}

function normalizeWritingGovernanceSettings(raw: unknown, fallbackUpdatedAt = ""): WritingGovernanceSettings {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const styleTemplate = WRITING_STYLE_TEMPLATE_VALUES.includes(source.styleTemplate as WritingStyleTemplate)
    ? source.styleTemplate as WritingStyleTemplate
    : "narrative-balance";
  const reviewStrictnessBaseline = REVIEW_STRICTNESS_BASELINE_VALUES.includes(source.reviewStrictnessBaseline as ReviewStrictnessBaseline)
    ? source.reviewStrictnessBaseline as ReviewStrictnessBaseline
    : "balanced";
  const antiAiTraceStrength = ANTI_AI_TRACE_STRENGTH_VALUES.includes(source.antiAiTraceStrength as AntiAiTraceStrength)
    ? source.antiAiTraceStrength as AntiAiTraceStrength
    : "medium";
  const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim().length > 0
    ? source.updatedAt
    : fallbackUpdatedAt;
  const extensions = typeof source.extensions === "object" && source.extensions !== null && !Array.isArray(source.extensions)
    ? source.extensions as Record<string, unknown>
    : undefined;
  return {
    schemaVersion: WRITING_GOVERNANCE_SCHEMA_VERSION,
    styleTemplate,
    reviewStrictnessBaseline,
    antiAiTraceStrength,
    updatedAt,
    ...(extensions ? { extensions } : {}),
  };
}

type WritingGovernanceInput = {
  styleTemplate?: WritingStyleTemplate;
  reviewStrictnessBaseline?: ReviewStrictnessBaseline;
  antiAiTraceStrength?: AntiAiTraceStrength;
  extensions?: Record<string, unknown>;
};

function validateWritingGovernanceInput(raw: unknown): { ok: true; value: WritingGovernanceInput } | { ok: false; errors: WritingGovernanceValidationError[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: "body", message: "Request body must be a JSON object." }] };
  }
  const body = raw as Record<string, unknown>;
  const errors: WritingGovernanceValidationError[] = [];
  const result: WritingGovernanceInput = {};

  if (body.styleTemplate !== undefined) {
    if (!WRITING_STYLE_TEMPLATE_VALUES.includes(body.styleTemplate as WritingStyleTemplate)) {
      errors.push({ field: "styleTemplate", message: `styleTemplate must be one of ${WRITING_STYLE_TEMPLATE_VALUES.join(", ")}.` });
    } else {
      result.styleTemplate = body.styleTemplate as WritingStyleTemplate;
    }
  }

  if (body.reviewStrictnessBaseline !== undefined) {
    if (!REVIEW_STRICTNESS_BASELINE_VALUES.includes(body.reviewStrictnessBaseline as ReviewStrictnessBaseline)) {
      errors.push({
        field: "reviewStrictnessBaseline",
        message: `reviewStrictnessBaseline must be one of ${REVIEW_STRICTNESS_BASELINE_VALUES.join(", ")}.`,
      });
    } else {
      result.reviewStrictnessBaseline = body.reviewStrictnessBaseline as ReviewStrictnessBaseline;
    }
  }

  if (body.antiAiTraceStrength !== undefined) {
    if (!ANTI_AI_TRACE_STRENGTH_VALUES.includes(body.antiAiTraceStrength as AntiAiTraceStrength)) {
      errors.push({
        field: "antiAiTraceStrength",
        message: `antiAiTraceStrength must be one of ${ANTI_AI_TRACE_STRENGTH_VALUES.join(", ")}.`,
      });
    } else {
      result.antiAiTraceStrength = body.antiAiTraceStrength as AntiAiTraceStrength;
    }
  }

  if (body.extensions !== undefined) {
    if (typeof body.extensions !== "object" || body.extensions === null || Array.isArray(body.extensions)) {
      errors.push({ field: "extensions", message: "extensions must be an object." });
    } else {
      result.extensions = body.extensions as Record<string, unknown>;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: result };
}

function broadcast(event: string, data: unknown): void {
  runtimeEventStore.append(deriveRuntimeEvent(event, data));
  for (const handler of subscribers) {
    handler(event, data);
  }
}

function normalizeBriefValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTraceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？；：、“”‘’"'`~!?,.;:\-_=+()[\]{}<>/\\|]/g, "");
}

function extractBriefSegments(brief: string | undefined): string[] {
  if (!brief) return [];
  const entries = brief
    .split(/[\n，。；;、]/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const deduped = [...new Set(entries)];
  return deduped.slice(0, BRIEF_TRACE_MAX_ITEMS);
}

function buildBriefTrace(
  appliedBrief: string | undefined,
  beforeContent: string | null,
  afterContent: string | null,
  decision: "applied" | "unchanged" | "failed" | null | undefined,
): BriefTraceEntry[] {
  const segments = extractBriefSegments(appliedBrief);
  if (segments.length === 0) return [];

  const normalizedBefore = normalizeTraceText(beforeContent ?? "");
  const normalizedAfter = normalizeTraceText(afterContent ?? "");
  const defaultMatched = decision === "applied";

  return segments.map((text, index) => {
    const normalized = normalizeTraceText(text);
    if (!normalized) {
      return { text, matched: defaultMatched && index === 0 };
    }
    if (decision === "unchanged") {
      return { text, matched: false };
    }
    const hitInAfter = normalizedAfter.includes(normalized);
    const hitInBefore = normalizedBefore.includes(normalized);
    return { text, matched: hitInAfter && (!hitInBefore || normalizedBefore !== normalizedAfter) };
  });
}

// --- V2 confirm run-state store ---
const bookCreateRunStore = new BookCreateRunStore();

// --- Server factory ---

export function createStudioServer(initialConfig: ProjectConfig, root: string) {
  const app = new Hono();
  const state = new StateManager(root);
  const chapterRunStore = new ChapterRunStore((bookId) => state.bookDir(bookId));
  let cachedConfig = initialConfig;

  // --- Runtime event log ---
  const runtimeEvents: RuntimeEvent[] = [];
  let runtimeEventIdCounter = 0;
  let sseClientCount = 0;

  function deriveEventSource(event: string): RuntimeEventSource {
    if (event.startsWith("daemon:")) return "daemon";
    if (event.startsWith("agent:")) return "agent";
    if (event === "log") return "pipeline";
    if (event.startsWith("llm:")) return "system";
    return "pipeline";
  }

  function deriveEventLevel(event: string, data: unknown): RuntimeEventLevel {
    // Explicit payload level wins over suffix heuristics so semantic fail events
    // can use `:fail` with `level: "error"` consistently.
    if (typeof data === "object" && data !== null) {
      const lvl = (data as Record<string, unknown>)["level"];
      if (lvl === "info") return "info";
      if (lvl === "error") return "error";
      if (lvl === "warn") return "warn";
    }
    if (event.endsWith(":error")) return "error";
    return "info";
  }

  function pushRuntimeEvent(event: string, data: unknown): void {
    const dataObj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const bookId = typeof dataObj["bookId"] === "string" ? dataObj["bookId"] : undefined;
    const entry: RuntimeEvent = {
      id: String(++runtimeEventIdCounter),
      timestamp: new Date().toISOString(),
      source: deriveEventSource(event),
      level: deriveEventLevel(event, data),
      event,
      data,
      ...(bookId !== undefined ? { bookId } : {}),
    };
    runtimeEvents.push(entry);
    if (runtimeEvents.length > RUNTIME_EVENTS_MAX_LIMIT) {
      runtimeEvents.splice(0, runtimeEvents.length - RUNTIME_EVENTS_MAX_LIMIT);
    }
  }

  // Register a subscriber that captures all broadcast events into the runtime event log
  const runtimeLogHandler: EventHandler = (event, data) => {
    pushRuntimeEvent(event, data);
  };
  subscribers.add(runtimeLogHandler);

  app.use("/*", cors());

  // Structured error handler — ApiError returns typed JSON, others return 500
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } },
      500,
    );
  });

  // BookId validation middleware — blocks path traversal on all book routes
  app.use("/api/books/:id/*", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });
  app.use("/api/books/:id", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });

  // Logger sink that broadcasts to SSE
  const sseSink: LogSink = {
    write(entry: LogEntry): void {
      broadcast("log", { level: entry.level, tag: entry.tag, message: entry.message });
    },
  };

  async function loadCurrentProjectConfig(
    options?: { readonly requireApiKey?: boolean },
  ): Promise<ProjectConfig> {
    const freshConfig = await loadProjectConfig(root, options);
    cachedConfig = freshConfig;
    return freshConfig;
  }

  async function buildPipelineConfig(
    overrides?: Partial<Pick<PipelineConfig, "externalContext">>,
  ): Promise<PipelineConfig> {
    const currentConfig = await loadCurrentProjectConfig();
    const logger = createLogger({ tag: "studio", sinks: [sseSink] });
    return {
      client: createLLMClient(currentConfig.llm),
      model: currentConfig.llm.model,
      projectRoot: root,
      defaultLLMConfig: currentConfig.llm,
      modelOverrides: currentConfig.modelOverrides,
      notifyChannels: currentConfig.notify,
      logger,
      onStreamProgress: (progress) => {
        if (progress.status === "streaming") {
          broadcast("llm:progress", {
            elapsedMs: progress.elapsedMs,
            totalChars: progress.totalChars,
            chineseChars: progress.chineseChars,
          });
        }
      },
      externalContext: overrides?.externalContext,
    };
  }

  async function readLatestChapterSnippet(bookId: string, chapterNumber: number): Promise<string> {
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const prefix = `${String(chapterNumber).padStart(4, "0")}_`;
    try {
      const files = await readdir(chaptersDir);
      const target = files.find((file) => file.startsWith(prefix) && file.endsWith(".md"));
      if (!target) return "";
      const raw = await readFile(join(chaptersDir, target), "utf-8");
      const cleaned = raw
        .replace(/^#.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
      return cleaned.slice(0, 220);
    } catch {
      return "";
    }
  }

  async function buildFallbackNextPlan(bookId: string, brief?: string): Promise<{
    goal: string;
    conflicts: string[];
    chapterNumber: number;
  }> {
    const chapters = await state.loadChapterIndex(bookId);
    const chapterNumber = await state.getNextChapterNumber(bookId);
    const latest = chapters.length > 0
      ? [...chapters].sort((a, b) => b.number - a.number)[0]
      : undefined;

    const briefText = brief?.trim();
    const latestTitle = latest?.title?.trim();
    const latestNumber = latest?.number;
    const latestSnippet = latest ? await readLatestChapterSnippet(bookId, latest.number) : "";

    const goal = briefText
      ? `围绕“${briefText.slice(0, 48)}”推进本章主线，并让主角做出一个不可逆选择。`
      : latestTitle && latestNumber
        ? `承接第${latestNumber}章《${latestTitle}》的后果，推进主角本章核心目标并触发代价。`
        : "为主角建立本章明确目标，并在章末制造一个可持续推进的悬念。";

    const conflicts: string[] = [];
    if (latestTitle && latestNumber) {
      conflicts.push(`连续性冲突：第${latestNumber}章《${latestTitle}》留下的问题必须在本章正面回应。`);
    }
    if (latestSnippet) {
      conflicts.push(`情节冲突：围绕“${latestSnippet.slice(0, 40)}...”引发新的阻力，避免重复上一章推进方式。`);
    }
    if (briefText) {
      conflicts.push(`目标冲突：主角想完成“${briefText.slice(0, 36)}”，但关键阻拦者会在本章中段介入。`);
    }
    conflicts.push("代价冲突：若本章目标失败，主角将失去一项已获得优势（关系、资源或主动权）。");

    return {
      goal,
      conflicts,
      chapterNumber,
    };
  }

  async function resolveNextChapterNumber(bookId: string): Promise<number | undefined> {
    try {
      const chapterNumber = await state.getNextChapterNumber(bookId);
      return Number.isFinite(chapterNumber) ? chapterNumber : undefined;
    } catch {
      return undefined;
    }
  }

  function emitActionEvent(
    action: RuntimeAction,
    stage: RuntimeActionStage,
    payload: {
      readonly bookId: string;
      readonly chapterNumber?: number;
      readonly briefUsed: boolean;
      readonly error?: string;
      readonly details?: Record<string, unknown>;
    },
  ): void {
    const eventPayload: Record<string, unknown> = {
      action,
      bookId: payload.bookId,
      chapterNumber: payload.chapterNumber,
      // Keep `chapter` during migration for UI code still reading the legacy field.
      chapter: payload.chapterNumber,
      briefUsed: payload.briefUsed,
      level: stage === "fail" ? "error" : "info",
      stage,
      ...payload.details,
    };
    if (payload.error) {
      eventPayload.error = payload.error;
      eventPayload.message = payload.error;
    }
    broadcast(`${action}:${stage}`, eventPayload);
  }

  function toChapterRunResponse(run: ChapterRunRecord): Record<string, unknown> {
    return {
      runId: run.runId,
      bookId: run.bookId,
      chapter: run.chapter,
      actionType: run.actionType,
      status: run.status,
      decision: run.decision,
      appliedBrief: run.appliedBrief,
      unchangedReason: run.unchangedReason,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
    };
  }

  async function readChapterContentSnapshot(bookId: string, chapterNumber: number): Promise<string | null> {
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const chapterPrefix = String(chapterNumber).padStart(4, "0");
    try {
      const files = await readdir(chaptersDir);
      const target = files
        .filter((file) => file.startsWith(chapterPrefix) && file.endsWith(".md"))
        .sort()[0];
      if (!target) return null;
      return await readFile(join(chaptersDir, target), "utf-8");
    } catch {
      return null;
    }
  }

  function isManualCandidateRevision(value: unknown): value is ManualCandidateRevision {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (typeof record["content"] !== "string") return false;
    if (typeof record["wordCount"] !== "number") return false;
    if (typeof record["updatedState"] !== "string") return false;
    if (typeof record["updatedLedger"] !== "string") return false;
    if (typeof record["updatedHooks"] !== "string") return false;
    if (record["status"] !== "ready-for-review" && record["status"] !== "audit-failed") return false;
    if (!Array.isArray(record["auditIssues"])) return false;
    return true;
  }

  function extractCandidateRevision(run: ChapterRunRecord): ManualCandidateRevision | null {
    for (const event of [...run.events].reverse()) {
      if (event.type !== "success" && event.type !== "fail") continue;
      const data = event.data as Record<string, unknown> | undefined;
      if (!data) continue;
      const candidate = data["candidateRevision"];
      if (isManualCandidateRevision(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function shouldSkipTruthFileUpdate(value: string | undefined): boolean {
    const trimmed = value?.trim();
    if (!trimmed) return true;
    if (/^\(.*未更新.*\)$/.test(trimmed)) return true;
    if (/^\(.*not\s+updated.*\)$/i.test(trimmed)) return true;
    return false;
  }

  async function applyApprovedCandidateRevision(params: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly candidate: ManualCandidateRevision;
  }): Promise<void> {
    const { bookId, chapterNumber, candidate } = params;
    const bookDir = state.bookDir(bookId);
    const chapterIndex = await state.loadChapterIndex(bookId);
    const chapterMeta = chapterIndex.find((chapter) => chapter.number === chapterNumber);
    if (!chapterMeta) {
      throw new Error(`Chapter ${chapterNumber} not found in index`);
    }

    const chaptersDir = join(bookDir, "chapters");
    const chapterPrefix = String(chapterNumber).padStart(4, "0");
    const chapterFiles = await readdir(chaptersDir);
    const chapterFile = chapterFiles.find((file) => file.startsWith(chapterPrefix) && file.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found`);
    }
    const chapterPath = join(chaptersDir, chapterFile);

    const currentRaw = await readFile(chapterPath, "utf-8").catch(() => "");
    const firstLine = currentRaw.split(/\r?\n/)[0]?.trim() ?? "";
    const heading = firstLine.startsWith("# ") ? firstLine : `# 第${chapterNumber}章 ${chapterMeta.title}`;
    await writeFile(chapterPath, `${heading}\n\n${candidate.content}`, "utf-8");

    const storyDir = join(bookDir, "story");
    if (!shouldSkipTruthFileUpdate(candidate.updatedState)) {
      await writeFile(join(storyDir, "current_state.md"), candidate.updatedState, "utf-8");
    }
    if (!shouldSkipTruthFileUpdate(candidate.updatedLedger)) {
      await writeFile(join(storyDir, "particle_ledger.md"), candidate.updatedLedger, "utf-8");
    }
    if (!shouldSkipTruthFileUpdate(candidate.updatedHooks)) {
      await writeFile(join(storyDir, "pending_hooks.md"), candidate.updatedHooks, "utf-8");
    }

    const now = new Date().toISOString();
    const updatedIndex = chapterIndex.map((chapter) =>
      chapter.number === chapterNumber
        ? {
            ...chapter,
            status: candidate.status,
            wordCount: candidate.wordCount,
            updatedAt: now,
            auditIssues: [...candidate.auditIssues],
            lengthWarnings: candidate.lengthWarnings ? [...candidate.lengthWarnings] : [],
            ...(candidate.lengthTelemetry ? { lengthTelemetry: candidate.lengthTelemetry as never } : {}),
          }
        : chapter,
    );
    await state.saveChapterIndex(bookId, updatedIndex);
    const snapshotState = (state as unknown as {
      snapshotState?: (bookId: string, chapterNumber: number) => Promise<void>;
    }).snapshotState;
    if (typeof snapshotState === "function") {
      await snapshotState.call(state, bookId, chapterNumber).catch(() => undefined);
    }
  }

  function parseDiffData(run: ChapterRunRecord): ChapterRunDiffData {
    const terminalEvent = [...run.events]
      .reverse()
      .find((event) => event.type === "success" || event.type === "fail");
    const raw = terminalEvent?.data as Record<string, unknown> | undefined;
    const beforeContent = typeof raw?.["beforeContent"] === "string" ? raw["beforeContent"] : null;
    const afterContent = typeof raw?.["afterContent"] === "string" ? raw["afterContent"] : null;
    const rawTrace = Array.isArray(raw?.["briefTrace"]) ? raw["briefTrace"] : [];
    const briefTrace = rawTrace.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const traceItem = entry as Record<string, unknown>;
      const text = typeof traceItem["text"] === "string" ? String(traceItem["text"]) : "";
      const matched = traceItem["matched"] === true;
      return text ? [{ text, matched }] : [];
    });
    const pendingApproval = run.decision === "unchanged" && extractCandidateRevision(run) !== null;
    return {
      beforeContent,
      afterContent,
      briefTrace: briefTrace.length > 0
        ? briefTrace
        : buildBriefTrace(run.appliedBrief ?? undefined, beforeContent, afterContent, run.decision),
      pendingApproval,
    };
  }

  async function completeChapterRun(input: {
    readonly bookId: string;
    readonly runId: string;
    readonly status: "succeeded" | "failed";
    readonly decision?: "applied" | "unchanged" | "failed" | null;
    readonly unchangedReason?: string | null;
    readonly error?: string;
    readonly message?: string;
    readonly data?: Record<string, unknown>;
  }): Promise<void> {
    await chapterRunStore.completeRun({
      bookId: input.bookId,
      runId: input.runId,
      status: input.status,
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
      ...(input.unchangedReason !== undefined ? { unchangedReason: input.unchangedReason } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
  }

  // --- Books ---

  app.get("/api/books", async (c) => {
    const bookIds = await state.listBooks();
    const books = await Promise.all(
      bookIds.map(async (id) => {
        const book = await state.loadBookConfig(id);
        const nextChapter = await state.getNextChapterNumber(id);
        return { ...book, chaptersWritten: nextChapter - 1 };
      }),
    );
    return c.json({ books });
  });

  app.get("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const book = await state.loadBookConfig(id);
      const chapters = await state.loadChapterIndex(id);
      const nextChapter = await state.getNextChapterNumber(id);
      return c.json({ book, chapters, nextChapter });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Genres ---

  app.get("/api/genres", async (c) => {
    const { listAvailableGenres, readGenreProfile } = await import("@actalk/inkos-core");
    const rawGenres = await listAvailableGenres(root);
    const genres = await Promise.all(
      rawGenres.map(async (g) => {
        try {
          const { profile } = await readGenreProfile(root, g.id);
          return { ...g, language: profile.language ?? "zh" };
        } catch {
          return { ...g, language: "zh" };
        }
      }),
    );
    return c.json({ genres });
  });

  // --- Book Create ---

  app.post("/api/books/create", async (c) => {
    const body = await c.req.json<{
      title: string;
      genre: string;
      language?: string;
      platform?: string;
      chapterWordCount?: number;
      targetChapters?: number;
    }>();

    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig(body, now);
    const bookId = bookConfig.id;
    const bookDir = state.bookDir(bookId);

    try {
      await access(join(bookDir, "book.json"));
      await access(join(bookDir, "story", "story_bible.md"));
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    } catch {
      // The target book is not fully initialized yet, so creation can continue.
    }

    broadcast("book:creating", { bookId, title: body.title });
    bookCreateStatus.set(bookId, { status: "creating" });

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    pipeline.initBook(bookConfig).then(
      () => {
        bookCreateStatus.delete(bookId);
        broadcast("book:created", { bookId });
      },
      (e) => {
        const error = e instanceof Error ? e.message : String(e);
        bookCreateStatus.set(bookId, { status: "error", error });
        broadcast("book:error", { bookId, error });
      },
    );

    return c.json({ status: "creating", bookId });
  });

  // --- V2: Brief Normalize ---

  app.post("/api/v2/books/create/brief/normalize", async (c) => {
    const body = await c.req.json().catch(() => null);
    const validation = validateNormalizeBriefInput(body);

    if (!validation.ok) {
      return c.json(
        { code: "BRIEF_VALIDATION_FAILED", errors: validation.errors },
        422,
      );
    }

    const result = normalizeBrief(validation.value);
    return c.json(result);
  });

  // --- Book Create v2 ---

  app.post("/api/v2/books/create/confirm", async (c) => {
    const body = await c.req.json<ConfirmCreateRequest>();

    if (!body.bookConfig?.title) {
      return c.json({ error: "bookConfig.title is required" }, 400);
    }
    if (!body.bookConfig?.genre) {
      return c.json({ error: "bookConfig.genre is required" }, 400);
    }

    const externalContext = body.brief ? briefToExternalContext(body.brief) : undefined;
    const pipeline = new PipelineRunner(await buildPipelineConfig({ externalContext }));

    try {
      const { bookId } = await confirmCreateBook(body, {
        bookDir: (id) => state.bookDir(id),
        broadcast,
        bookCreateStatus,
        runStore: bookCreateRunStore,
        initBook: (bookConfig) => pipeline.initBook(bookConfig),
      });
      return c.json({ status: "creating", bookId });
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "BOOK_CREATE_CONFLICT") {
        return c.json({ error: e.message }, 409);
      }
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/books/:id/create-status", async (c) => {
    const id = c.req.param("id");
    const status = bookCreateStatus.get(id);
    if (!status) {
      return c.json({ status: "missing" });
    }
    return c.json(status);
  });

  // --- Chapters ---

  app.get("/api/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);
      const content = await readFile(join(chaptersDir, match), "utf-8");
      return c.json({ chapterNumber: num, filename: match, content });
    } catch {
      return c.json({ error: "Chapter not found" }, 404);
    }
  });

  // --- Chapter Save ---

  app.put("/api/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const { content } = await c.req.json<{ content: string }>();

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(join(chaptersDir, match), content, "utf-8");
      return c.json({ ok: true, chapterNumber: num });
    } catch (e) {
      return c.json({ error: `Failed to write configuration: ${String(e)}` }, 500);
    }
  });

  // --- Truth files ---

  const STORY_FILE_PATTERN = /^[A-Za-z0-9._-]+$/;
  const isSafeStoryFileName = (file: string): boolean => {
    if (!file || !STORY_FILE_PATTERN.test(file)) return false;
    if (file !== basename(file)) return false;
    return file.endsWith(".md") || file.endsWith(".json");
  };

  app.get("/api/books/:id/truth/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");

    if (!isSafeStoryFileName(file)) {
      return c.json({ error: "Invalid truth file" }, 400);
    }

    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(join(bookDir, "story", file), "utf-8");
      return c.json({ file, content });
    } catch {
      return c.json({ file, content: null });
    }
  });

  // --- Analytics ---

  app.get("/api/books/:id/analytics", async (c) => {
    const id = c.req.param("id");
    try {
      const chapters = await state.loadChapterIndex(id);
      return c.json(computeAnalytics(id, chapters));
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Actions ---

  app.post("/api/books/:id/next-plan", async (c) => {
    const id = c.req.param("id");
    const rawBody = await c.req.json<unknown>().catch(() => ({}));
    const validation = validateNextPlanInput(rawBody);

    if (!validation.ok) {
      return c.json({ code: "NEXT_PLAN_VALIDATION_FAILED", errors: validation.errors }, 422);
    }

    const appliedBrief = normalizeBriefValue(validation.value.brief);
    const briefUsed = appliedBrief !== undefined;
    emitActionEvent("plan", "start", { bookId: id, briefUsed });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: appliedBrief,
      }));
      const plan = await previewNextPlan(id, validation.value, {
        planChapter: (bookId, context) => pipeline.planChapter(bookId, context),
      });
      emitActionEvent("plan", "success", {
        bookId: id,
        chapterNumber: typeof plan.chapterNumber === "number" ? plan.chapterNumber : undefined,
        briefUsed,
      });
      return c.json({ plan });
    } catch (e) {
      if (e instanceof PlanLowConfidenceError) {
        const fallbackPlan = await buildFallbackNextPlan(id, appliedBrief);
        emitActionEvent("plan", "success", {
          bookId: id,
          chapterNumber: fallbackPlan.chapterNumber,
          briefUsed,
          details: { fallback: true },
        });
        return c.json({
          plan: fallbackPlan,
          warning: { code: "PLAN_LOW_CONFIDENCE_FALLBACK", message: e.message },
        });
      }
      emitActionEvent("plan", "fail", {
        bookId: id,
        briefUsed,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({ error: { code: "PLAN_FAILED", message: e instanceof Error ? e.message : String(e) } }, 500);
    }
  });

  app.post("/api/books/:id/write-next", async (c) => {
    const id = c.req.param("id");
    const rawBody = await c.req.json().catch(() => null);

    const validation = validateWriteNextInput(rawBody);
    if (!validation.ok) {
      return c.json({ code: "WRITE_NEXT_VALIDATION_FAILED", errors: validation.errors }, 422);
    }

    const { wordCount, mode, planInput, ...steeringInput } = validation.value;
    const directBrief = normalizeBriefValue((steeringInput as { brief?: unknown }).brief);
    const planBrief = normalizeBriefValue(planInput);
    const briefUsed = directBrief !== undefined || planBrief !== undefined;
    const chapterNumber = await resolveNextChapterNumber(id);
    const resolvePlanOrFallbackChapterNumber = (plan: { chapterNumber?: unknown }): number | undefined =>
      typeof plan.chapterNumber === "number" ? plan.chapterNumber : chapterNumber;
    emitActionEvent("write-next", "start", {
      bookId: id,
      chapterNumber,
      briefUsed,
    });

    // Shared SSE callbacks used by all mode branches.
    type WriteResult = { chapterNumber: number; status: string; title: string; wordCount: number };
    const onWriteComplete = (result: WriteResult): void => {
      emitActionEvent("compose", "success", {
        bookId: id,
        chapterNumber: result.chapterNumber,
        briefUsed,
        details: { status: result.status, title: result.title, wordCount: result.wordCount },
      });
      emitActionEvent("write-next", "success", {
        bookId: id,
        chapterNumber: result.chapterNumber,
        briefUsed,
        details: { status: result.status, title: result.title, wordCount: result.wordCount },
      });
    };
    const onWriteError = (e: unknown): void => {
      const error = e instanceof Error ? e.message : String(e);
      emitActionEvent("compose", "fail", {
        bookId: id,
        chapterNumber,
        briefUsed,
        error,
      });
      emitActionEvent("write-next", "fail", {
        bookId: id,
        chapterNumber,
        briefUsed,
        error,
      });
    };

    if (mode === "ai-plan") {
      // AI-plan mode: run the plan stage first, then write using the plan result as context.
      // planInput (optional) is passed to planChapter as additional planning context.
      // Both steps are fire-and-forget; progress is pushed via SSE.
      const planPipeline = new PipelineRunner(await buildPipelineConfig());
      emitActionEvent("plan", "start", {
        bookId: id,
        chapterNumber,
        briefUsed: planBrief !== undefined,
      });
      planPipeline.planChapter(id, planInput)
        .then(async (plan) => {
          const planChapterNumber = resolvePlanOrFallbackChapterNumber(plan);
          emitActionEvent("plan", "success", {
            bookId: id,
            chapterNumber: planChapterNumber,
            briefUsed: planBrief !== undefined,
          });
          const externalContext = buildWriteNextContextFromPlan(plan, steeringInput);
          emitActionEvent("compose", "start", {
            bookId: id,
            chapterNumber: planChapterNumber,
            briefUsed,
          });
          const writePipeline = new PipelineRunner(await buildPipelineConfig({ externalContext }));
          return writePipeline.writeNextChapter(id, wordCount);
        }, (e) => {
          emitActionEvent("plan", "fail", {
            bookId: id,
            chapterNumber,
            briefUsed: planBrief !== undefined,
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        })
        .then(onWriteComplete, onWriteError);
    } else if (mode === "quick") {
      // Quick mode: write directly without any context injection.
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      emitActionEvent("compose", "start", {
        bookId: id,
        chapterNumber,
        briefUsed,
      });
      pipeline.writeNextChapter(id, wordCount).then(onWriteComplete, onWriteError);
    } else {
      // manual-plan or legacy (no mode): build externalContext from steering fields.
      const externalContext = buildWriteNextExternalContext(steeringInput);
      const pipeline = new PipelineRunner(await buildPipelineConfig({ externalContext }));
      emitActionEvent("compose", "start", {
        bookId: id,
        chapterNumber,
        briefUsed,
      });
      pipeline.writeNextChapter(id, wordCount).then(onWriteComplete, onWriteError);
    }

    return c.json({ status: "writing", bookId: id });
  });

  app.post("/api/books/:id/draft", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number; context?: string }>().catch(() => ({ wordCount: undefined, context: undefined }));

    broadcast("draft:start", { bookId: id });

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    pipeline.writeDraft(id, body.context, body.wordCount).then(
      (result) => {
        broadcast("draft:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        broadcast("draft:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
      },
    );

    return c.json({ status: "drafting", bookId: id });
  });

  app.post("/api/books/:id/chapters/:num/approve", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);

    try {
      const index = await state.loadChapterIndex(id);
      const updated = index.map((ch) =>
        ch.number === num ? { ...ch, status: "approved" as const } : ch,
      );
      await state.saveChapterIndex(id, updated);
      return c.json({ ok: true, chapterNumber: num, status: "approved" });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/books/:id/chapters/:num/reject", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);

    try {
      const index = await state.loadChapterIndex(id);
      const target = index.find((ch) => ch.number === num);
      if (!target) {
        return c.json({ error: `Chapter ${num} not found` }, 404);
      }

      const rollbackTarget = num - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      return c.json({
        ok: true,
        chapterNumber: num,
        status: "rejected",
        rolledBackTo: rollbackTarget,
        discarded,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- SSE ---

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      sseClientCount++;
      const handler: EventHandler = (event, data) => {
        stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      subscribers.add(handler);

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" });
      }, 30000);

      stream.onAbort(() => {
        sseClientCount--;
        subscribers.delete(handler);
        clearInterval(keepAlive);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // --- Project info ---

  app.get("/api/project", async (c) => {
    const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
    // Check if language was explicitly set in inkos.json (not just the schema default)
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const languageExplicit = "language" in raw && raw.language !== "";

    return c.json({
      name: currentConfig.name,
      language: currentConfig.language,
      languageExplicit,
      model: currentConfig.llm.model,
      provider: currentConfig.llm.provider,
      baseUrl: currentConfig.llm.baseUrl,
      stream: currentConfig.llm.stream,
      temperature: currentConfig.llm.temperature,
      maxTokens: currentConfig.llm.maxTokens,
    });
  });

  // --- Config editing ---

  app.put("/api/project", async (c) => {
    const updates = await c.req.json<Record<string, unknown>>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      // Merge LLM settings
      if (updates.temperature !== undefined) {
        existing.llm.temperature = updates.temperature;
      }
      if (updates.maxTokens !== undefined) {
        existing.llm.maxTokens = updates.maxTokens;
      }
      if (updates.stream !== undefined) {
        existing.llm.stream = updates.stream;
      }
      if (updates.language === "zh" || updates.language === "en") {
        existing.language = updates.language;
      }
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/project/writing-governance", async (c) => {
    try {
      const configPath = join(root, "inkos.json");
      const raw = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
      const settings = normalizeWritingGovernanceSettings(raw.writingGovernance, "");
      return c.json({ settings });
    } catch (e) {
      return c.json({ error: `Failed to read writing governance settings: ${String(e)}` }, 500);
    }
  });

  app.put("/api/project/writing-governance", async (c) => {
    const body = await c.req.json().catch(() => null);
    const validation = validateWritingGovernanceInput(body);
    if (!validation.ok) {
      return c.json({ errors: validation.errors }, 400);
    }
    try {
      const configPath = join(root, "inkos.json");
      const existing = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
      const baseSettings = normalizeWritingGovernanceSettings(existing.writingGovernance, "");
      const nextSettings = {
        ...baseSettings,
        ...validation.value,
        updatedAt: new Date().toISOString(),
      };
      existing.writingGovernance = nextSettings;
      await writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true, settings: nextSettings });
    } catch (e) {
      return c.json({ error: `Failed to save writing governance settings: ${String(e)}` }, 500);
    }
  });

  // --- Truth files browser ---

  app.get("/api/books/:id/truth", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const storyDir = join(bookDir, "story");
    try {
      const files = await readdir(storyDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".json"));
      const result = await Promise.all(
        mdFiles.map(async (f) => {
          const content = await readFile(join(storyDir, f), "utf-8");
          return { name: f, size: content.length, preview: content.slice(0, 200) };
        }),
      );
      return c.json({ files: result });
    } catch {
      return c.json({ files: [] });
    }
  });

  // --- Daemon control ---

  let schedulerInstance: import("@actalk/inkos-core").Scheduler | null = null;
  let activeRunPlan: RunPlan | undefined;
  let activePlanId: string | undefined;
  const daemonPlans = new Map<string, RunPlan>();
  const activeDaemonStates = new Set<DaemonSessionState>(["planning", "running", "paused"]);
  let daemonSession: DaemonSessionSummary = {
    state: "idle",
    running: false,
    updatedAt: new Date().toISOString(),
    completedCount: 0,
    failedCount: 0,
  };

  function updateDaemonSession(
    state: DaemonSessionState,
    options?: Partial<Omit<DaemonSessionSummary, "state" | "running" | "updatedAt">>,
  ): DaemonSessionSummary {
    daemonSession = {
      ...daemonSession,
      ...(options ?? {}),
      state,
      running: activeDaemonStates.has(state),
      updatedAt: new Date().toISOString(),
    };
    return daemonSession;
  }

  app.get("/api/daemon/session", (c) => {
    return c.json(daemonSession);
  });

  app.get("/api/daemon", (c) => {
    return c.json({
      running: daemonSession.running,
    });
  });

  const daemonError = (code: string, message: string) =>
    ({ error: { code, message } }) as const;

  const buildSchedulerConfig = async (plan?: RunPlan) => {
    const currentConfig = await loadCurrentProjectConfig();
    const schedule = plan?.schedule;
    const writeCron = schedule?.everyMinutes ? `*/${Math.max(1, schedule.everyMinutes)} * * * *` : currentConfig.daemon.schedule.writeCron;
    const cooldownAfterChapterMs = schedule?.cooldownSeconds !== undefined
      ? Math.max(0, schedule.cooldownSeconds) * 1000
      : currentConfig.daemon.cooldownAfterChapterMs;
    const maxConcurrentBooks = plan?.maxConcurrentBooks ?? currentConfig.daemon.maxConcurrentBooks;
    return {
      ...(await buildPipelineConfig()),
      radarCron: currentConfig.daemon.schedule.radarCron,
      writeCron,
      maxConcurrentBooks,
      chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
      retryDelayMs: currentConfig.daemon.retryDelayMs,
      cooldownAfterChapterMs,
      maxChaptersPerDay: currentConfig.daemon.maxChaptersPerDay,
      onChapterComplete: (bookId: string, chapter: number, status: string) => {
        updateDaemonSession("running", {
          currentBookId: bookId,
          currentChapter: chapter,
          completedCount: (daemonSession.completedCount ?? 0) + 1,
        });
        broadcast("daemon:chapter", { bookId, chapter, status });
      },
      onError: (bookId: string, error: Error) => {
        updateDaemonSession("error", {
          currentBookId: bookId === "scheduler" ? daemonSession.currentBookId : bookId,
          failedCount: (daemonSession.failedCount ?? 0) + 1,
          lastError: { message: error.message, timestamp: new Date().toISOString() },
        });
        broadcast("daemon:error", { bookId, error: error.message });
      },
    };
  };

  const startDaemonWithPlan = async (plan: RunPlan | undefined, planId: string | undefined) => {
    const { Scheduler } = await import("@actalk/inkos-core");
    const scheduler = new Scheduler(await buildSchedulerConfig(plan));
    schedulerInstance = scheduler;
    activeRunPlan = plan;
    activePlanId = planId;
    const activeBookIds = plan?.bookScope.type === "book-list" ? plan.bookScope.bookIds : undefined;
    const currentBookId = activeBookIds?.[0];
    updateDaemonSession("running", {
      mode: plan?.mode ?? "managed-default",
      activePlanId: planId,
      activeBookIds,
      currentBookId,
      currentChapter: undefined,
      completedCount: 0,
      failedCount: 0,
      lastError: undefined,
    });
    broadcast("daemon:started", { ...(planId !== undefined ? { planId } : {}), mode: plan?.mode ?? "managed-default" });
    void scheduler.start(plan).catch((e) => {
      const error = e instanceof Error ? e : new Error(String(e));
      if (schedulerInstance === scheduler) {
        scheduler.stop();
        schedulerInstance = null;
        broadcast("daemon:stopped", {});
      }
      updateDaemonSession("error", {
        failedCount: (daemonSession.failedCount ?? 0) + 1,
        lastError: { message: error.message, timestamp: new Date().toISOString() },
      });
      broadcast("daemon:error", { bookId: "scheduler", error: error.message });
    });
  };

  app.post("/api/daemon/plan", async (c) => {
    const rawBody = await c.req.json<unknown>().catch(() => null);
    const validation = validateDaemonPlanRequest(rawBody);
    if (!validation.ok) {
      return c.json({ code: "DAEMON_PLAN_VALIDATION_FAILED", errors: validation.errors }, 422);
    }

    const incomingPlan = validation.value.plan;
    const planId = validation.value.planId ?? `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const updated = daemonPlans.has(planId);
    daemonPlans.set(planId, incomingPlan);
    return c.json({ ok: true, planId, updated, plan: incomingPlan });
  });

  app.post("/api/daemon/start", async (c) => {
    const rawBody = await c.req.json<unknown>().catch(() => null);
    const validation = validateDaemonStartRequest(rawBody);
    if (!validation.ok) {
      return c.json({ code: "DAEMON_START_VALIDATION_FAILED", errors: validation.errors }, 422);
    }

    if (daemonSession.running) {
      return c.json(daemonError("DAEMON_ALREADY_RUNNING", "Daemon already running."), 409);
    }

    const requestedPlanId = validation.value.planId;
    const requestedPlan = requestedPlanId !== undefined ? daemonPlans.get(requestedPlanId) : undefined;
    if (requestedPlanId !== undefined && requestedPlan === undefined) {
      return c.json(daemonError("DAEMON_PLAN_NOT_FOUND", `Daemon plan "${requestedPlanId}" not found.`), 404);
    }

    updateDaemonSession("planning", {
      mode: requestedPlan?.mode ?? "managed-default",
      activePlanId: requestedPlanId,
    });
    try {
      await startDaemonWithPlan(requestedPlan, requestedPlanId);
      return c.json({
        ok: true,
        running: true,
        ...(requestedPlanId !== undefined ? { planId: requestedPlanId } : {}),
        ...(requestedPlan !== undefined ? { mode: requestedPlan.mode } : { mode: "managed-default" }),
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      updateDaemonSession("error", {
        lastError: { message: error.message, timestamp: new Date().toISOString() },
      });
      return c.json(daemonError("DAEMON_START_FAILED", error.message), 500);
    }
  });

  app.post("/api/daemon/pause", (c) => {
    if (daemonSession.state !== "running") {
      return c.json(daemonError("DAEMON_NOT_RUNNING", "Daemon is not running."), 409);
    }
    schedulerInstance?.stop();
    schedulerInstance = null;
    updateDaemonSession("paused");
    broadcast("daemon:paused", { ...(activePlanId !== undefined ? { planId: activePlanId } : {}) });
    return c.json({ ok: true, running: daemonSession.running, state: "paused" });
  });

  app.post("/api/daemon/resume", async (c) => {
    if (daemonSession.state !== "paused") {
      return c.json(daemonError("DAEMON_NOT_PAUSED", "Daemon is not paused."), 409);
    }
    updateDaemonSession("planning");
    try {
      await startDaemonWithPlan(activeRunPlan, activePlanId);
      broadcast("daemon:resumed", { ...(activePlanId !== undefined ? { planId: activePlanId } : {}) });
      return c.json({ ok: true, running: true, state: "running", ...(activePlanId !== undefined ? { planId: activePlanId } : {}) });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      updateDaemonSession("error", {
        lastError: { message: error.message, timestamp: new Date().toISOString() },
      });
      return c.json(daemonError("DAEMON_RESUME_FAILED", error.message), 500);
    }
  });

  app.post("/api/daemon/stop", (c) => {
    if (daemonSession.state === "idle" || daemonSession.state === "stopped" || daemonSession.state === "error") {
      return c.json(daemonError("DAEMON_NOT_ACTIVE", "Daemon is not active."), 409);
    }
    schedulerInstance?.stop();
    schedulerInstance = null;
    updateDaemonSession("stopped");
    broadcast("daemon:stopped", {});
    return c.json({ ok: true, running: false });
  });

  // --- Logs (deprecated — use /api/runtime/events instead) ---

  app.get("/api/logs", async (c) => {
    const logPath = join(root, "inkos.log");
    try {
      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").slice(-100);
      const entries = lines.map((line) => {
        try { return JSON.parse(line); } catch { return { message: line }; }
      });
      return c.json({ entries, deprecated: true });
    } catch {
      return c.json({ entries: [], deprecated: true });
    }
  });

  // --- Runtime center ---

  app.get("/api/runtime/status", (c) => {
    const recentErrorCount = runtimeEvents.filter((e) => e.level === "error").length;
    const overview: RuntimeOverview = {
      daemonRunning: daemonSession.running,
      sseClientCount,
      recentErrorCount,
      eventCount: runtimeEvents.length,
    };
    return c.json(overview);
  });

  app.get("/api/runtime/events", (c) => {
    const raw = {
      source: c.req.query("source"),
      level: c.req.query("level"),
      bookId: c.req.query("bookId"),
      limit: c.req.query("limit"),
    };

    const validation = validateRuntimeEventsQuery(raw);
    if (!validation.ok) {
      return c.json({ code: "RUNTIME_EVENTS_VALIDATION_FAILED", errors: validation.errors }, 422);
    }

    const { source, level, bookId, limit } = validation.value;

    let filtered = runtimeEvents;
    if (source !== undefined) {
      filtered = filtered.filter((e) => e.source === source);
    }
    if (level !== undefined) {
      filtered = filtered.filter((e) => e.level === level);
    }
    if (bookId !== undefined) {
      filtered = filtered.filter((e) => e.bookId === bookId);
    }

    const total = filtered.length;
    const entries = filtered.slice(-limit);

    const response: RuntimeEventsResponse = { entries, total };
    return c.json(response);
  });

  app.get("/api/books/:id/chapter-runs", async (c) => {
    const id = c.req.param("id");
    const validation = validateChapterRunListQuery({
      chapter: c.req.query("chapter"),
      limit: c.req.query("limit"),
    });
    if (!validation.ok) {
      return c.json({ code: "CHAPTER_RUNS_VALIDATION_FAILED", errors: validation.errors }, 422);
    }

    const runs = await chapterRunStore.listRuns(id, validation.value);
    return c.json({ runs: runs.map((run) => toChapterRunResponse(run)) });
  });

  app.get("/api/books/:id/chapter-runs/:runId", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    const run = await chapterRunStore.getRun(id, runId);
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json(toChapterRunResponse(run));
  });

  app.get("/api/books/:id/chapter-runs/:runId/events", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    const events = await chapterRunStore.getRunEvents(id, runId);
    if (!events) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json({ runId, events });
  });

  app.get("/api/books/:id/chapter-runs/:runId/diff", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    const run = await chapterRunStore.getRun(id, runId);
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    const diff = parseDiffData(run);
    const unchangedReason = run.decision === "unchanged"
      ? (run.unchangedReason ?? NO_REVISIONS_APPLIED_MESSAGE)
      : run.unchangedReason;
    return c.json({
      ...toChapterRunResponse(run),
      beforeContent: diff.beforeContent,
      afterContent: diff.afterContent,
      briefTrace: diff.briefTrace,
      pendingApproval: diff.pendingApproval,
      unchangedReason,
    });
  });

  app.post("/api/books/:id/chapter-runs/:runId/approve", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    const run = await chapterRunStore.getRun(id, runId);
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    if (run.status !== "succeeded" || run.decision !== "unchanged") {
      return c.json({ error: "Only unchanged succeeded runs can be approved" }, 409);
    }

    const candidate = extractCandidateRevision(run);
    if (!candidate) {
      return c.json({ error: "No candidate revision available for approval" }, 409);
    }

    try {
      await applyApprovedCandidateRevision({
        bookId: id,
        chapterNumber: run.chapter,
        candidate,
      });

      const diff = parseDiffData(run);
      await completeChapterRun({
        bookId: id,
        runId,
        status: "succeeded",
        decision: "applied",
        unchangedReason: null,
        message: "Candidate revision approved by user.",
        data: {
          beforeContent: diff.beforeContent,
          afterContent: candidate.content,
          briefTrace: diff.briefTrace,
          approvedFromUnchangedRun: true,
        },
      });

      const action: RuntimeAction = run.actionType === "rewrite"
        ? "rewrite"
        : run.actionType === "anti-detect"
          ? "anti-detect"
          : "revise";
      emitActionEvent(action, "success", {
        bookId: id,
        chapterNumber: run.chapter,
        briefUsed: run.appliedBrief !== null,
        details: {
          approvedFromRunId: runId,
          decision: "applied",
          message: "Candidate revision approved by user.",
        },
      });

      return c.json({
        ok: true,
        runId,
        chapter: run.chapter,
        decision: "applied",
        message: "Candidate revision approved and persisted.",
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/books/:id/chapter-runs/:runId", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    const removed = await chapterRunStore.deleteRun(id, runId);
    if (!removed) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json({ ok: true, runId });
  });

  app.post("/api/runtime/clear", (c) => {
    const cleared = runtimeEvents.length;
    runtimeEvents.splice(0, runtimeEvents.length);
    runtimeEventIdCounter = 0;
    const response: RuntimeClearResponse = { ok: true, cleared };
    return c.json(response);
  });

  // --- Agent chat ---

  app.post("/api/agent", async (c) => {
    const { instruction } = await c.req.json<{ instruction: string }>();
    if (!instruction?.trim()) {
      return c.json({ error: "No instruction provided" }, 400);
    }

    broadcast("agent:start", { instruction });

    try {
      const { runAgentLoop } = await import("@actalk/inkos-core");

      const result = await runAgentLoop(
        await buildPipelineConfig(),
        instruction
      );

      broadcast("agent:complete", { instruction, response: result });
      return c.json({ response: result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      broadcast("agent:error", { instruction, error: msg });
      return c.json({ response: msg });
    }
  });

  // --- Language setup ---

  app.post("/api/project/language", async (c) => {
    const { language } = await c.req.json<{ language: "zh" | "en" }>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      existing.language = language;
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true, language });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Audit ---

  app.post("/api/books/:id/audit/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);

    broadcast("audit:start", { bookId: id, chapter: chapterNum });
    try {
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const currentConfig = await loadCurrentProjectConfig();
      const { ContinuityAuditor } = await import("@actalk/inkos-core");
      const auditor = new ContinuityAuditor({
        client: createLLMClient(currentConfig.llm),
        model: currentConfig.llm.model,
        projectRoot: root,
        bookId: id,
      });
      const result = await auditor.auditChapter(bookDir, content, chapterNum, book.genre);
      broadcast("audit:complete", { bookId: id, chapter: chapterNum, passed: result.passed });
      return c.json(result);
    } catch (e) {
      broadcast("audit:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Revise ---

  app.post("/api/books/:id/revise/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { mode?: string; brief?: string } = await c.req
      .json<{ mode?: string; brief?: string }>()
      .catch(() => ({ mode: "spot-fix" }));
    const reviseMode = (body.mode ?? "spot-fix") as "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";

    const appliedBrief = normalizeBriefValue(body.brief);
    const briefUsed = appliedBrief !== undefined;
    const actionType: ChapterRunActionType = reviseMode === "anti-detect" ? "anti-detect" : "revise";
    let chapterRunId: string | undefined;
    const beforeContent = await readChapterContentSnapshot(id, chapterNum);

    try {
      const chapterRun = await chapterRunStore.createRun({
        bookId: id,
        chapter: chapterNum,
        actionType,
        appliedBrief,
      });
      chapterRunId = chapterRun.runId;
      const action: RuntimeAction = reviseMode === "anti-detect" ? "anti-detect" : "revise";
      emitActionEvent(action, "start", {
        bookId: id,
        chapterNumber: chapterNum,
        briefUsed,
      });
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: appliedBrief,
      }));
      pipeline.reviseDraft(
        id,
        chapterNum,
        reviseMode,
      ).then(
        async (result) => {
          const decision = inferRunDecision("succeeded", result.applied);
          const candidateRevision = result.candidateRevision;
          const afterContent = decision === "unchanged" && candidateRevision
            ? candidateRevision.content
            : await readChapterContentSnapshot(id, chapterNum);
          const briefTrace = buildBriefTrace(appliedBrief, beforeContent, afterContent, decision);
          const unmatchedBrief = briefUsed && briefTrace.length > 0 && briefTrace.every((item) => !item.matched);
          const pendingApproval = decision === "unchanged" && Boolean(candidateRevision);
          const unchangedReason = decision === "unchanged"
            ? ((result.unchangedReason ?? result.skippedReason ?? "").trim() || NO_REVISIONS_APPLIED_MESSAGE)
            : null;
          emitActionEvent(action, decision === "unchanged" ? "unchanged" : "success", {
            bookId: id,
            chapterNumber: chapterNum,
            briefUsed,
            details: {
              fixedCount: result.fixedIssues.length,
              status: result.status,
              ...(decision === "unchanged" && unmatchedBrief ? { reasonCode: "brief-unmatched" } : {}),
              ...(pendingApproval ? { reasonCode: "pending-approval" } : {}),
              ...(decision === "unchanged" ? { message: unchangedReason } : {}),
            },
          });
          await completeChapterRun({
            bookId: id,
            runId: chapterRun.runId,
            status: "succeeded",
            decision,
            unchangedReason,
            data: {
              fixedCount: result.fixedIssues.length,
              status: result.status,
              beforeContent,
              afterContent,
              briefTrace,
              pendingApproval,
              ...(candidateRevision ? { candidateRevision } : {}),
            },
          });
        },
        async (e) => {
          const error = e instanceof Error ? e.message : String(e);
          // Keep stack traces in server console for actionable debugging.
          // Runtime event payload stays concise for UI.
          console.error("[studio][revise] failed", e);
          emitActionEvent(action, "fail", {
            bookId: id,
            chapterNumber: chapterNum,
            briefUsed,
            error,
          });
          await completeChapterRun({
            bookId: id,
            runId: chapterRun.runId,
            status: "failed",
            error,
            message: error,
          });
        },
      );
      return c.json({
        status: "revising",
        runId: chapterRunId,
        bookId: id,
        chapter: chapterNum,
        mode: reviseMode,
        appliedBrief: appliedBrief ?? null,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const action: RuntimeAction = reviseMode === "anti-detect" ? "anti-detect" : "revise";
      emitActionEvent(action, "fail", {
        bookId: id,
        chapterNumber: chapterNum,
        briefUsed,
        error,
      });
      if (chapterRunId) {
        await completeChapterRun({
          bookId: id,
          runId: chapterRunId,
          status: "failed",
          error,
          message: error,
        });
      }
      return c.json({ error: String(e), ...(chapterRunId ? { runId: chapterRunId } : {}) }, 500);
    }
  });

  // --- Steering Preferences ---

  app.get("/api/books/:id/steering-prefs", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const prefs = await loadSteeringPrefs(bookDir);
      return c.json({ prefs });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.put("/api/books/:id/steering-prefs", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const raw = await c.req.json().catch(() => null);
    const result = validateSteeringPrefsInput(raw);
    if (!result.ok) {
      return c.json({ errors: result.errors }, 400);
    }
    try {
      const prefs = await saveSteeringPrefs(bookDir, result.value);
      return c.json({ ok: true, prefs });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Export ---

  app.get("/api/books/:id/export", async (c) => {
    const id = c.req.param("id");
    const format = (c.req.query("format") ?? "txt") as string;
    const approvedOnly = c.req.query("approvedOnly") === "true";
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const book = await state.loadBookConfig(id);
      const index = await state.loadChapterIndex(id);
      const approvedNums = new Set(
        approvedOnly ? index.filter((ch) => ch.status === "approved").map((ch) => ch.number) : [],
      );

      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();

      const filteredFiles = approvedOnly
        ? mdFiles.filter((f) => approvedNums.has(parseInt(f.slice(0, 4), 10)))
        : mdFiles;

      const contents = await Promise.all(
        filteredFiles.map((f) => readFile(join(chaptersDir, f), "utf-8")),
      );

      if (format === "epub") {
        // Basic EPUB: XHTML container
        const chapters = contents.map((content, i) => {
          const title = content.match(/^#\s+(.+)$/m)?.[1] ?? `Chapter ${i + 1}`;
          const html = content.split("\n").filter((l) => !l.startsWith("#")).map((l) => l.trim() ? `<p>${l}</p>` : "").join("\n");
          return { title, html };
        });
        const toc = chapters.map((ch, i) => `<li><a href="#ch${i}">${ch.title}</a></li>`).join("\n");
        const body = chapters.map((ch, i) => `<h2 id="ch${i}">${ch.title}</h2>\n${ch.html}`).join("\n<hr/>\n");
        const epub = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${book.title}</title><style>body{font-family:serif;max-width:40em;margin:auto;padding:2em;line-height:1.8}h2{margin-top:3em}</style></head><body><h1>${book.title}</h1><nav><ol>${toc}</ol></nav><hr/>${body}</body></html>`;
        return new Response(epub, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Disposition": `attachment; filename="${id}.html"`,
          },
        });
      }
      if (format === "md") {
        const body = contents.join("\n\n---\n\n");
        return new Response(body, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${id}.md"`,
          },
        });
      }
      // Default: txt
      const body = contents.join("\n\n");
      return new Response(body, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${id}.txt"`,
        },
      });
    } catch {
      return c.json({ error: "Export failed" }, 500);
    }
  });

  // --- Export to file (save to project dir) ---

  app.post("/api/books/:id/export-save", async (c) => {
    const id = c.req.param("id");
    const { format, approvedOnly } = await c.req.json<{ format?: string; approvedOnly?: boolean }>().catch(() => ({ format: "txt", approvedOnly: false }));
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const fmt = format ?? "txt";

    try {
      const book = await state.loadBookConfig(id);
      const index = await state.loadChapterIndex(id);
      const approvedNums = new Set(
        approvedOnly ? index.filter((ch) => ch.status === "approved").map((ch) => ch.number) : [],
      );

      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const filteredFiles = approvedOnly
        ? mdFiles.filter((f) => approvedNums.has(parseInt(f.slice(0, 4), 10)))
        : mdFiles;
      const contents = await Promise.all(
        filteredFiles.map((f) => readFile(join(chaptersDir, f), "utf-8")),
      );

      const { writeFile: writeFileFs } = await import("node:fs/promises");
      let outputPath: string;
      let body: string;

      if (fmt === "md") {
        body = contents.join("\n\n---\n\n");
        outputPath = join(bookDir, `${id}.md`);
      } else if (fmt === "epub") {
        const chapters = contents.map((content, i) => {
          const title = content.match(/^#\s+(.+)$/m)?.[1] ?? `Chapter ${i + 1}`;
          const html = content.split("\n").filter((l) => !l.startsWith("#")).map((l) => l.trim() ? `<p>${l}</p>` : "").join("\n");
          return { title, html };
        });
        const toc = chapters.map((ch, i) => `<li><a href="#ch${i}">${ch.title}</a></li>`).join("\n");
        const chapterHtml = chapters.map((ch, i) => `<h2 id="ch${i}">${ch.title}</h2>\n${ch.html}`).join("\n<hr/>\n");
        body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${book.title}</title><style>body{font-family:serif;max-width:40em;margin:auto;padding:2em;line-height:1.8}h2{margin-top:3em}</style></head><body><h1>${book.title}</h1><nav><ol>${toc}</ol></nav><hr/>${chapterHtml}</body></html>`;
        outputPath = join(bookDir, `${id}.html`);
      } else {
        body = contents.join("\n\n");
        outputPath = join(bookDir, `${id}.txt`);
      }

      await writeFileFs(outputPath, body, "utf-8");
      return c.json({ ok: true, path: outputPath, format: fmt, chapters: filteredFiles.length });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre detail + copy ---

  app.get("/api/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    try {
      const { readGenreProfile } = await import("@actalk/inkos-core");
      const { profile, body } = await readGenreProfile(root, genreId);
      return c.json({ profile, body });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });

  app.post("/api/genres/:id/copy", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }
    try {
      const { getBuiltinGenresDir } = await import("@actalk/inkos-core");
      const { mkdir: mkdirFs, copyFile } = await import("node:fs/promises");
      const builtinDir = getBuiltinGenresDir();
      const projectGenresDir = join(root, "genres");
      await mkdirFs(projectGenresDir, { recursive: true });
      await copyFile(join(builtinDir, `${genreId}.md`), join(projectGenresDir, `${genreId}.md`));
      return c.json({ ok: true, path: `genres/${genreId}.md` });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Model overrides ---

  app.get("/api/project/model-overrides", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ overrides: raw.modelOverrides ?? {} });
  });

  app.put("/api/project/model-overrides", async (c) => {
    const { overrides } = await c.req.json<{ overrides: Record<string, unknown> }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.modelOverrides = overrides;
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- Notify channels ---

  app.get("/api/project/notify", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ channels: raw.notify ?? [] });
  });

  app.put("/api/project/notify", async (c) => {
    const { channels } = await c.req.json<{ channels: unknown[] }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.notify = channels;
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- AIGC Detection ---

  app.post("/api/books/:id/detect/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { analyzeAITells } = await import("@actalk/inkos-core");
      const result = analyzeAITells(content);
      return c.json({ chapterNumber: chapterNum, ...result });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth file edit ---

  app.put("/api/books/:id/truth/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    if (!isSafeStoryFileName(file)) {
      return c.json({ error: "Invalid truth file" }, 400);
    }
    const { content } = await c.req.json<{ content: string }>();
    const bookDir = state.bookDir(id);
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(join(bookDir, "story"), { recursive: true });
    await writeFileFs(join(bookDir, "story", file), content, "utf-8");
    return c.json({ ok: true });
  });

  // =============================================
  // NEW ENDPOINTS — CLI parity
  // =============================================

  // --- Book Delete ---

  app.delete("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(bookDir, { recursive: true, force: true });
      broadcast("book:deleted", { bookId: id });
      return c.json({ ok: true, bookId: id });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Update ---

  app.put("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    const updates = await c.req.json<{
      chapterWordCount?: number;
      targetChapters?: number;
      status?: string;
      language?: string;
    }>();
    try {
      const book = await state.loadBookConfig(id);
      const updated = {
        ...book,
        ...(updates.chapterWordCount !== undefined ? { chapterWordCount: Number(updates.chapterWordCount) } : {}),
        ...(updates.targetChapters !== undefined ? { targetChapters: Number(updates.targetChapters) } : {}),
        ...(updates.status !== undefined ? { status: updates.status as typeof book.status } : {}),
        ...(updates.language !== undefined ? { language: updates.language as "zh" | "en" } : {}),
        updatedAt: new Date().toISOString(),
      };
      await state.saveBookConfig(id, updated);
      return c.json({ ok: true, book: updated });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Write Rewrite (specific chapter) ---

  app.post("/api/books/:id/rewrite/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    const appliedBrief = normalizeBriefValue(body.brief);
    const briefUsed = appliedBrief !== undefined;
    let chapterRunId: string | undefined;
    const beforeContent = await readChapterContentSnapshot(id, chapterNum);
    try {
      const chapterRun = await chapterRunStore.createRun({
        bookId: id,
        chapter: chapterNum,
        actionType: "rewrite",
        appliedBrief,
      });
      chapterRunId = chapterRun.runId;
      emitActionEvent("rewrite", "start", {
        bookId: id,
        chapterNumber: chapterNum,
        briefUsed,
      });
      const rollbackTarget = chapterNum - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: appliedBrief,
      }));
      pipeline.writeNextChapter(id).then(
        async (result) => {
          const afterContent = await readChapterContentSnapshot(id, chapterNum);
          const briefTrace = buildBriefTrace(appliedBrief, beforeContent, afterContent, "applied");
          emitActionEvent("rewrite", "success", {
            bookId: id,
            chapterNumber: result.chapterNumber,
            briefUsed,
            details: { title: result.title, wordCount: result.wordCount },
          });
          await completeChapterRun({
            bookId: id,
            runId: chapterRun.runId,
            status: "succeeded",
            decision: "applied",
            data: {
              title: result.title,
              wordCount: result.wordCount,
              beforeContent,
              afterContent,
              briefTrace,
            },
          });
        },
        async (e) => {
          const error = e instanceof Error ? e.message : String(e);
          emitActionEvent("rewrite", "fail", {
            bookId: id,
            chapterNumber: chapterNum,
            briefUsed,
            error,
          });
          await completeChapterRun({
            bookId: id,
            runId: chapterRun.runId,
            status: "failed",
            error,
            message: error,
          });
        },
      );
      return c.json({ status: "rewriting", runId: chapterRunId, bookId: id, chapter: chapterNum, rolledBackTo: rollbackTarget, discarded, appliedBrief: appliedBrief ?? null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      emitActionEvent("rewrite", "fail", {
        bookId: id,
        chapterNumber: chapterNum,
        briefUsed,
        error,
      });
      if (chapterRunId) {
        await completeChapterRun({
          bookId: id,
          runId: chapterRunId,
          status: "failed",
          error,
          message: error,
        });
      }
      return c.json({ error: String(e), ...(chapterRunId ? { runId: chapterRunId } : {}) }, 500);
    }
  });

  app.post("/api/books/:id/resync/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));
    const appliedBrief = normalizeBriefValue(body.brief);
    const briefUsed = appliedBrief !== undefined;
    let chapterRunId: string | undefined;
    const beforeContent = await readChapterContentSnapshot(id, chapterNum);

    try {
      const chapterRun = await chapterRunStore.createRun({
        bookId: id,
        chapter: chapterNum,
        actionType: "resync",
        appliedBrief,
      });
      chapterRunId = chapterRun.runId;
      emitActionEvent("resync", "start", {
        bookId: id,
        chapterNumber: chapterNum,
        briefUsed,
      });
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: appliedBrief,
      }));
      const resyncChapterArtifacts = (
        pipeline as PipelineRunner & {
          resyncChapterArtifacts?: (bookId: string, chapterNumber?: number) => Promise<unknown>;
        }
      ).resyncChapterArtifacts;

      if (typeof resyncChapterArtifacts !== "function") {
        const message = "Current @actalk/inkos-core build does not support chapter resync.";
        emitActionEvent("resync", "fail", {
          bookId: id,
          chapterNumber: chapterNum,
          briefUsed,
          error: message,
        });
        await completeChapterRun({
          bookId: id,
          runId: chapterRun.runId,
          status: "failed",
          error: message,
          message,
        });
        return c.json({ error: message, runId: chapterRunId }, 501);
      }

      const result = await resyncChapterArtifacts.call(pipeline, id, chapterNum);
      const revised = (result as { revised?: unknown } | null | undefined)?.revised;
      const decision = inferRunDecision("succeeded", revised);
      const afterContent = await readChapterContentSnapshot(id, chapterNum);
      const briefTrace = buildBriefTrace(appliedBrief, beforeContent, afterContent, decision);
      emitActionEvent("resync", "success", {
        bookId: id,
        chapterNumber: chapterNum,
        briefUsed,
        details: {
          decision,
          ...(decision === "unchanged" ? { message: NO_TRUTH_ARTIFACT_UPDATES_MESSAGE } : {}),
        },
      });
      await completeChapterRun({
        bookId: id,
        runId: chapterRun.runId,
        status: "succeeded",
        decision,
        unchangedReason: decision === "unchanged" ? NO_TRUTH_ARTIFACT_UPDATES_MESSAGE : null,
        data: {
          beforeContent,
          afterContent,
          briefTrace,
        },
      });
      if (result && typeof result === "object") {
        return c.json({ ...(result as Record<string, unknown>), runId: chapterRunId, appliedBrief: appliedBrief ?? null });
      }
      return c.json({ ok: true, result, runId: chapterRunId, appliedBrief: appliedBrief ?? null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      emitActionEvent("resync", "fail", {
        bookId: id,
        chapterNumber: chapterNum,
        briefUsed,
        error,
      });
      if (chapterRunId) {
        await completeChapterRun({
          bookId: id,
          runId: chapterRunId,
          status: "failed",
          error,
          message: error,
        });
      }
      return c.json({ error: String(e), ...(chapterRunId ? { runId: chapterRunId } : {}) }, 500);
    }
  });

  // --- Detect All chapters ---

  app.post("/api/books/:id/detect-all", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const { analyzeAITells } = await import("@actalk/inkos-core");

      const results = await Promise.all(
        mdFiles.map(async (f) => {
          const num = parseInt(f.slice(0, 4), 10);
          const content = await readFile(join(chaptersDir, f), "utf-8");
          const result = analyzeAITells(content);
          return { chapterNumber: num, filename: f, ...result };
        }),
      );
      return c.json({ bookId: id, results });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect Stats ---

  app.get("/api/books/:id/detect/stats", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadDetectionHistory, analyzeDetectionInsights } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const history = await loadDetectionHistory(bookDir);
      const insights = analyzeDetectionInsights(history);
      return c.json(insights);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre Create ---

  app.post("/api/genres/create", async (c) => {
    const body = await c.req.json<{
      id: string; name: string; language?: string;
      chapterTypes?: string[]; fatigueWords?: string[];
      numericalSystem?: boolean; powerScaling?: boolean; eraResearch?: boolean;
      pacingRule?: string; satisfactionTypes?: string[]; auditDimensions?: number[];
      body?: string;
    }>();

    if (!body.id || !body.name) {
      return c.json({ error: "id and name are required" }, 400);
    }
    if (/[/\\\0]/.test(body.id) || body.id.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${body.id}"`);
    }

    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const frontmatter = [
      "---",
      `name: ${body.name}`,
      `id: ${body.id}`,
      `language: ${body.language ?? "zh"}`,
      `chapterTypes: ${JSON.stringify(body.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(body.fatigueWords ?? [])}`,
      `numericalSystem: ${body.numericalSystem ?? false}`,
      `powerScaling: ${body.powerScaling ?? false}`,
      `eraResearch: ${body.eraResearch ?? false}`,
      `pacingRule: "${body.pacingRule ?? ""}"`,
      `satisfactionTypes: ${JSON.stringify(body.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(body.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${body.id}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: body.id });
  });

  // --- Genre Edit ---

  app.put("/api/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const body = await c.req.json<{ profile: Record<string, unknown>; body: string }>();
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const p = body.profile;
    const frontmatter = [
      "---",
      `name: ${p.name ?? genreId}`,
      `id: ${p.id ?? genreId}`,
      `language: ${p.language ?? "zh"}`,
      `chapterTypes: ${JSON.stringify(p.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(p.fatigueWords ?? [])}`,
      `numericalSystem: ${p.numericalSystem ?? false}`,
      `powerScaling: ${p.powerScaling ?? false}`,
      `eraResearch: ${p.eraResearch ?? false}`,
      `pacingRule: "${p.pacingRule ?? ""}"`,
      `satisfactionTypes: ${JSON.stringify(p.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(p.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${genreId}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: genreId });
  });

  // --- Genre Delete (project-level only) ---

  app.delete("/api/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const filePath = join(root, "genres", `${genreId}.md`);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(filePath);
      return c.json({ ok: true, id: genreId });
    } catch (e) {
      return c.json({ error: `Genre "${genreId}" not found in project` }, 404);
    }
  });

  // --- Style Analyze ---

  app.post("/api/style/analyze", async (c) => {
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    try {
      const { analyzeStyle } = await import("@actalk/inkos-core");
      const profile = analyzeStyle(text, sourceName ?? "unknown");
      return c.json(profile);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Style Import to Book ---

  app.post("/api/books/:id/style/import", async (c) => {
    const id = c.req.param("id");
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();

    broadcast("style:start", { bookId: id });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.generateStyleGuide(id, text, sourceName ?? "unknown");
      broadcast("style:complete", { bookId: id });
      return c.json({ ok: true, result });
    } catch (e) {
      broadcast("style:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Chapters ---

  app.post("/api/books/:id/import/chapters", async (c) => {
    const id = c.req.param("id");
    const { text, splitRegex } = await c.req.json<{ text: string; splitRegex?: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    broadcast("import:start", { bookId: id, type: "chapters" });
    try {
      const { splitChapters } = await import("@actalk/inkos-core");
      const chapters = [...splitChapters(text, splitRegex)];

      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.importChapters({ bookId: id, chapters });
      broadcast("import:complete", { bookId: id, type: "chapters", count: result.importedCount });
      return c.json(result);
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Canon ---

  app.post("/api/books/:id/import/canon", async (c) => {
    const id = c.req.param("id");
    const { fromBookId } = await c.req.json<{ fromBookId: string }>();
    if (!fromBookId) return c.json({ error: "fromBookId is required" }, 400);

    broadcast("import:start", { bookId: id, type: "canon" });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importCanon(id, fromBookId);
      broadcast("import:complete", { bookId: id, type: "canon" });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Init ---

  app.post("/api/fanfic/init", async (c) => {
    const body = await c.req.json<{
      title: string; sourceText: string; sourceName?: string;
      mode?: string; genre?: string; platform?: string;
      targetChapters?: number; chapterWordCount?: number; language?: string;
    }>();
    if (!body.title || !body.sourceText) {
      return c.json({ error: "title and sourceText are required" }, 400);
    }

    const now = new Date().toISOString();
    const bookId = body.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").slice(0, 30);

    const bookConfig = {
      id: bookId,
      title: body.title,
      platform: (body.platform ?? "other") as "other",
      genre: (body.genre ?? "other") as "xuanhuan",
      status: "outlining" as const,
      targetChapters: body.targetChapters ?? 100,
      chapterWordCount: body.chapterWordCount ?? 3000,
      fanficMode: (body.mode ?? "canon") as "canon",
      ...(body.language ? { language: body.language as "zh" | "en" } : {}),
      createdAt: now,
      updatedAt: now,
    };

    broadcast("fanfic:start", { bookId, title: body.title });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.initFanficBook(bookConfig, body.sourceText, body.sourceName ?? "source", (body.mode ?? "canon") as "canon");
      broadcast("fanfic:complete", { bookId });
      return c.json({ ok: true, bookId });
    } catch (e) {
      broadcast("fanfic:error", { bookId, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Show (read canon) ---

  app.get("/api/books/:id/fanfic", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(join(bookDir, "story", "fanfic_canon.md"), "utf-8");
      return c.json({ bookId: id, content });
    } catch {
      return c.json({ bookId: id, content: null });
    }
  });

  // --- Fanfic Refresh ---

  app.post("/api/books/:id/fanfic/refresh", async (c) => {
    const id = c.req.param("id");
    const { sourceText, sourceName } = await c.req.json<{ sourceText: string; sourceName?: string }>();
    if (!sourceText?.trim()) return c.json({ error: "sourceText is required" }, 400);

    broadcast("fanfic:refresh:start", { bookId: id });
    try {
      const book = await state.loadBookConfig(id);
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importFanficCanon(id, sourceText, sourceName ?? "source", (book.fanficMode ?? "canon") as "canon");
      broadcast("fanfic:refresh:complete", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("fanfic:refresh:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Radar Scan ---

  app.post("/api/radar/scan", async (c) => {
    broadcast("radar:start", {});
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.runRadar();
      broadcast("radar:complete", { result });
      return c.json(result);
    } catch (e) {
      broadcast("radar:error", { error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Doctor (environment health check) ---

  app.get("/api/doctor", async (c) => {
    const { existsSync } = await import("node:fs");
    const { GLOBAL_ENV_PATH } = await import("@actalk/inkos-core");

    const checks = {
      inkosJson: existsSync(join(root, "inkos.json")),
      projectEnv: existsSync(join(root, ".env")),
      globalEnv: existsSync(GLOBAL_ENV_PATH),
      booksDir: existsSync(join(root, "books")),
      llmConnected: false,
      bookCount: 0,
    };

    try {
      const books = await state.listBooks();
      checks.bookCount = books.length;
    } catch { /* ignore */ }

    try {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const client = createLLMClient(currentConfig.llm);
      const { chatCompletion } = await import("@actalk/inkos-core");
      await chatCompletion(client, currentConfig.llm.model, [{ role: "user", content: "ping" }], { maxTokens: 5 });
      checks.llmConnected = true;
    } catch { /* ignore */ }

    return c.json(checks);
  });

  return app;
}

// --- Standalone runner ---

export async function startStudioServer(
  root: string,
  port = 4567,
  options?: { readonly staticDir?: string },
): Promise<void> {
  const config = await loadProjectConfig(root);

  const app = createStudioServer(config, root);

  // Serve frontend static files — single process for API + frontend
  if (options?.staticDir) {
    const { readFile: readFileFs } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const { existsSync } = await import("node:fs");

    // Serve static assets (js, css, etc.)
    app.get("/assets/*", async (c) => {
      const filePath = joinPath(options.staticDir!, c.req.path);
      try {
        const content = await readFileFs(filePath);
        const ext = filePath.split(".").pop() ?? "";
        const contentTypes: Record<string, string> = {
          js: "application/javascript",
          css: "text/css",
          svg: "image/svg+xml",
          png: "image/png",
          ico: "image/x-icon",
          json: "application/json",
        };
        return new Response(content, {
          headers: { "Content-Type": contentTypes[ext] ?? "application/octet-stream" },
        });
      } catch {
        return c.notFound();
      }
    });

    // SPA fallback — serve index.html for all non-API routes
    const indexPath = joinPath(options.staticDir!, "index.html");
    if (existsSync(indexPath)) {
      const indexHtml = await readFileFs(indexPath, "utf-8");
      app.get("*", (c) => {
        if (c.req.path.startsWith("/api/")) return c.notFound();
        return c.html(indexHtml);
      });
    }
  }

  console.log(`NovaScribe Studio running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}
