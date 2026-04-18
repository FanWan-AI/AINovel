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
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
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
import {
  evaluateAssistantPolicy,
  type AssistantPolicyBudgetInput,
  type AssistantPolicyPlanStep,
} from "./services/assistant-policy-service.js";
import {
  authorizeAssistantSkillPlan,
  listAssistantSkills,
} from "./services/assistant-skill-registry-service.js";
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
import {
  validateDaemonPlanRequest,
  validateDaemonStartRequest,
  type DaemonPlanBookScope,
} from "./schemas/daemon-plan-schema.js";
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
const ASSISTANT_EVALUATE_FAILED_RUN_FALLBACK_MESSAGE = "运行失败，需人工复核。";
const ASSISTANT_EVALUATE_UNCHANGED_RUN_FALLBACK_MESSAGE = "未应用修订，建议人工复核。";
const ASSISTANT_DELETE_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const ASSISTANT_DELETE_PREVIEW_TTL_MS = 5 * 60 * 1000;
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

type AssistantPlanIntent = "audit" | "audit_and_optimize" | "write_next" | "generate_structure";
type AssistantPlanRiskLevel = "low" | "medium" | "high";
type AssistantPlanScope = DaemonPlanBookScope;

interface AssistantPlanStep {
  readonly stepId: string;
  readonly action: string;
  readonly bookId?: string;
  readonly bookIds?: ReadonlyArray<string>;
  readonly chapter?: number;
  readonly mode?: string;
}

interface AssistantExecuteStepRef {
  readonly stepId: string;
  readonly action: "audit" | "revise" | "re-audit";
  readonly bookId: string;
  readonly chapter: number;
  readonly mode?: string;
}

interface AssistantTaskStepSnapshot {
  readonly stepId: string;
  readonly action?: string;
  readonly runId?: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

interface AssistantTaskSnapshot {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly currentStepId?: string;
  readonly steps: Record<string, AssistantTaskStepSnapshot>;
  readonly lastUpdatedAt: string;
  readonly error?: string;
  readonly retryContext?: Record<string, unknown>;
}

interface AssistantTaskSnapshotStore {
  readonly version: 1;
  readonly updatedAt: string;
  readonly tasks: ReadonlyArray<AssistantTaskSnapshot>;
}

const ASSISTANT_TASK_SNAPSHOT_STORE_FILE = ".inkos/assistant-task-snapshots.json";
const ASSISTANT_TASK_SNAPSHOT_PERSIST_DEBOUNCE_MS = 150;

function parseAssistantTaskStepStatus(input: unknown): AssistantTaskStepSnapshot["status"] | null {
  if (input === "running" || input === "succeeded" || input === "failed") {
    return input;
  }
  return null;
}

function normalizeAssistantTaskStepSnapshot(input: unknown, fallbackStepId?: string): AssistantTaskStepSnapshot | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const stepId = typeof payload.stepId === "string" ? payload.stepId : fallbackStepId;
  const status = parseAssistantTaskStepStatus(payload.status);
  if (!stepId || !status) {
    return null;
  }
  return {
    stepId,
    status,
    ...(typeof payload.action === "string" ? { action: payload.action } : {}),
    ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
    ...(typeof payload.startedAt === "string" ? { startedAt: payload.startedAt } : {}),
    ...(typeof payload.finishedAt === "string" ? { finishedAt: payload.finishedAt } : {}),
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
  };
}

function parseAssistantTaskStatus(input: unknown): AssistantTaskSnapshot["status"] | null {
  if (input === "running" || input === "succeeded" || input === "failed") {
    return input;
  }
  return null;
}

function normalizeAssistantTaskSnapshot(input: unknown, fallbackTaskId?: string): AssistantTaskSnapshot | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const taskId = typeof payload.taskId === "string" ? payload.taskId : fallbackTaskId;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  const status = parseAssistantTaskStatus(payload.status);
  const lastUpdatedAt = typeof payload.lastUpdatedAt === "string" ? payload.lastUpdatedAt : "";
  if (!taskId || !sessionId || !status || !lastUpdatedAt) {
    return null;
  }
  const rawSteps = typeof payload.steps === "object" && payload.steps !== null && !Array.isArray(payload.steps) ? payload.steps : {};
  const steps = Object.entries(rawSteps).reduce<Record<string, AssistantTaskStepSnapshot>>((acc, [stepId, value]) => {
    const normalized = normalizeAssistantTaskStepSnapshot(value, stepId);
    if (normalized) {
      acc[normalized.stepId] = normalized;
    }
    return acc;
  }, {});
  const retryContext = typeof payload.retryContext === "object" && payload.retryContext !== null && !Array.isArray(payload.retryContext)
    ? payload.retryContext as Record<string, unknown>
    : undefined;
  return {
    taskId,
    sessionId,
    status,
    ...(typeof payload.currentStepId === "string" ? { currentStepId: payload.currentStepId } : {}),
    steps,
    lastUpdatedAt,
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    ...(retryContext ? { retryContext } : {}),
  };
}

function parseAssistantTaskSnapshotStore(input: unknown): AssistantTaskSnapshotStore {
  const tasks = new Map<string, AssistantTaskSnapshot>();
  const collect = (snapshot: AssistantTaskSnapshot) => {
    const previous = tasks.get(snapshot.taskId);
    if (!previous || previous.lastUpdatedAt < snapshot.lastUpdatedAt) {
      tasks.set(snapshot.taskId, snapshot);
    }
  };
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const payload = input as Record<string, unknown>;
    if (Array.isArray(payload.tasks)) {
      payload.tasks.forEach((entry) => {
        const normalized = normalizeAssistantTaskSnapshot(entry);
        if (normalized) collect(normalized);
      });
    }
    Object.entries(payload).forEach(([taskId, value]) => {
      if (taskId === "version" || taskId === "updatedAt" || taskId === "tasks") {
        return;
      }
      const normalized = normalizeAssistantTaskSnapshot(value, taskId);
      if (normalized) collect(normalized);
    });
  }
  const ordered = [...tasks.values()].sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: ordered,
  };
}

interface AssistantEvaluateScopeChapter {
  readonly type: "chapter";
  readonly bookId: string;
  readonly chapter: number;
}

interface AssistantEvaluateScopeBook {
  readonly type: "book";
  readonly bookId: string;
}

type AssistantEvaluateScope = AssistantEvaluateScopeChapter | AssistantEvaluateScopeBook;

interface AssistantEvaluateEvidence {
  readonly source: string;
  readonly excerpt: string;
  readonly reason: string;
}

type AssistantCrudReadDimension = "book" | "volume" | "chapter" | "character" | "hook";

interface AssistantCrudEvidence {
  readonly source: string;
  readonly locator: string;
  readonly excerpt: string;
}

interface AssistantCrudDeletePreview {
  readonly target: "chapter" | "run";
  readonly bookId: string;
  readonly impactSummary: string;
  readonly evidence: ReadonlyArray<AssistantCrudEvidence>;
  readonly previewId: string;
  readonly confirmBy: string;
}

interface AssistantCrudDeleteRecoveryEntry {
  readonly restoreId: string;
  readonly target: "chapter" | "run";
  readonly bookId: string;
  readonly chapter?: number;
  readonly runId?: string;
  readonly chapterFileName?: string;
  readonly chapterContent?: string;
  readonly deletedAt: string;
  readonly recoverBefore: string;
  readonly restoredAt?: string;
}

interface AssistantCrudDeleteRecoveryStore {
  readonly version: 1;
  readonly entries: AssistantCrudDeleteRecoveryEntry[];
}

interface AssistantEvaluateDimensions {
  readonly continuity: number;
  readonly readability: number;
  readonly styleConsistency: number;
  readonly aiTraceRisk: number;
}

interface AssistantEvaluateReport {
  readonly overallScore: number;
  readonly dimensions: AssistantEvaluateDimensions;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<AssistantEvaluateEvidence>;
}

interface AssistantOptimizeIteration {
  readonly iteration: number;
  readonly stepId: string;
  readonly runId?: string;
  readonly score?: number;
  readonly status: "running" | "succeeded" | "failed";
  readonly reason?: string;
}

const ASSISTANT_AUDIT_PATTERN = /审计|审核|审一下|审下|审一审|检查|audit|review/iu;
const ASSISTANT_OPTIMIZE_PATTERN = /修复|优化|optimi[sz]e|fix|改写/iu;
const ASSISTANT_WRITE_NEXT_PATTERN = /写下一章|继续写|续写|write[-\s]?next|continue\s*writing/iu;
const ASSISTANT_GENERATE_STRUCTURE_PATTERN = /生成.*结构|初始化.*大纲|蓝图|generate.*structure|create.*outline/iu;
const ASSISTANT_CRUD_READ_PATTERN = /查询|查看|检索|read|search/iu;
const ASSISTANT_CRUD_DELETE_PATTERN = /删除|delete/iu;
const ASSISTANT_CRUD_RESTORE_PATTERN = /恢复|restore/iu;
const ASSISTANT_CRUD_DIMENSION_VOLUME_PATTERN = /卷|volume/iu;
const ASSISTANT_CRUD_DIMENSION_CHAPTER_PATTERN = /章|chapter/iu;
const ASSISTANT_CRUD_DIMENSION_CHARACTER_PATTERN = /角色|character/iu;
const ASSISTANT_CRUD_DIMENSION_HOOK_PATTERN = /伏笔|hook/iu;
const ASSISTANT_CRUD_RUN_ID_PATTERN = /(run[_-][a-z0-9-]+)/iu;
const ASSISTANT_CRUD_RESTORE_ID_PATTERN = /(asst_restore_[a-z0-9]+)/iu;
const ASSISTANT_INTERNAL_API_BASE = "http://localhost";
const ASSISTANT_CHAPTER_ZH_PATTERN = /第\s*(\d+)\s*章/u;
const ASSISTANT_CHAPTER_EN_PATTERN = /chapter\s*(\d+)/iu;
const ASSISTANT_MODEL_IDENTITY_PATTERN = /(你是.*模型|什么模型|哪个模型|model|provider|llm|deep\s*seek|deepseek|mimo|openai|anthropic)/iu;
const ASSISTANT_VAGUE_PROMPT_PATTERN = /^[\s?？!！,，.。]+$/u;
const ASSISTANT_REVISE_INTENT_PATTERN = /改一下|改成|修改|调整|修一下|润色|重写|修订|rewrite|revise|spot-fix|polish|rework|anti-detect/iu;

interface AssistantToolOutcome {
  readonly name: string;
  readonly parsed?: Record<string, unknown>;
  readonly raw: string;
}

function parseAssistantToolOutcome(name: string, raw: string): AssistantToolOutcome {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { name, parsed: parsed as Record<string, unknown>, raw };
    }
  } catch {
    // fallthrough: keep raw text only
  }
  return { name, raw };
}

function buildGroundedAssistantResponse(
  prompt: string,
  toolOutcomes: ReadonlyArray<AssistantToolOutcome>,
  fallback: string,
): string {
  if (!ASSISTANT_REVISE_INTENT_PATTERN.test(prompt)) {
    return fallback;
  }

  const reviseOutcomes = toolOutcomes.filter((item) => item.name === "revise_chapter");
  if (reviseOutcomes.length === 0) {
    return fallback;
  }

  const lastRevise = reviseOutcomes[reviseOutcomes.length - 1];
  const parsed = lastRevise.parsed;
  if (!parsed) {
    return fallback;
  }

  const error = typeof parsed.error === "string" ? parsed.error.trim() : "";
  if (error.length > 0) {
    return `修订未完成：${error}`;
  }

  const chapterNumber = typeof parsed.chapterNumber === "number" ? parsed.chapterNumber : undefined;
  const status = typeof parsed.status === "string" ? parsed.status : undefined;
  const decision = typeof parsed.decision === "string" ? parsed.decision : undefined;
  const wordCount = typeof parsed.wordCount === "number" ? parsed.wordCount : undefined;
  const mode = typeof parsed.actionType === "string" ? parsed.actionType : undefined;

  const chapterLabel = chapterNumber !== undefined ? `第${chapterNumber}章` : "目标章节";
  const detailParts = [
    mode ? `模式：${mode}` : undefined,
    status ? `状态：${status}` : undefined,
    decision ? `决策：${decision}` : undefined,
    wordCount !== undefined ? `字数：${wordCount}` : undefined,
  ].filter((item): item is string => Boolean(item));

  const details = detailParts.length > 0 ? `（${detailParts.join("，")}）` : "";
  return `已完成${chapterLabel}修订${details}。如需，我可以继续按你的新要求再做一轮定向改写。`;
}

function buildAssistantModelIdentityReply(config: ProjectConfig): string {
  const llm = config.llm;
  const provider = llm.provider || "unknown";
  const model = llm.model || "unknown";
  const baseUrl = llm.baseUrl || "";
  const overrideCount = Object.keys(config.modelOverrides ?? {}).length;
  const endpointHint = baseUrl.length > 0 ? `，baseUrl=${baseUrl}` : "";
  const overrideHint = overrideCount > 0
    ? `。另外已配置 ${overrideCount} 个角色模型覆盖`
    : "";
  return `当前项目真实配置是 provider=${provider}，model=${model}${endpointHint}${overrideHint}。`;
}

function parseAssistantChapterFromInput(input: string): number | undefined {
  const zhMatch = input.match(ASSISTANT_CHAPTER_ZH_PATTERN);
  if (zhMatch?.[1]) return Number.parseInt(zhMatch[1], 10);
  const enMatch = input.match(ASSISTANT_CHAPTER_EN_PATTERN);
  if (enMatch?.[1]) return Number.parseInt(enMatch[1], 10);
  return undefined;
}

function parseAssistantCrudDimensionFromInput(input: string): AssistantCrudReadDimension {
  if (ASSISTANT_CRUD_DIMENSION_HOOK_PATTERN.test(input)) return "hook";
  if (ASSISTANT_CRUD_DIMENSION_CHARACTER_PATTERN.test(input)) return "character";
  if (ASSISTANT_CRUD_DIMENSION_VOLUME_PATTERN.test(input)) return "volume";
  if (ASSISTANT_CRUD_DIMENSION_CHAPTER_PATTERN.test(input)) return "chapter";
  return "book";
}

function resolveAssistantPlanIntent(input: string): AssistantPlanIntent | null {
  const normalized = input.trim();
  if (!normalized) return null;
  // "写下一章" takes priority — "自审" in a write context means write+audit, not audit-only
  if (ASSISTANT_WRITE_NEXT_PATTERN.test(normalized)) {
    return "write_next";
  }
  if (ASSISTANT_AUDIT_PATTERN.test(normalized) && ASSISTANT_OPTIMIZE_PATTERN.test(normalized)) {
    return "audit_and_optimize";
  }
  if (ASSISTANT_OPTIMIZE_PATTERN.test(normalized)) {
    return "audit_and_optimize";
  }
  if (ASSISTANT_AUDIT_PATTERN.test(normalized)) {
    return "audit";
  }
  if (ASSISTANT_GENERATE_STRUCTURE_PATTERN.test(normalized)) {
    return "generate_structure";
  }
  return null;
}

function parseAssistantPlanScope(rawScope: unknown): { ok: true; scope: AssistantPlanScope } | { ok: false; errors: Array<{ field: string; message: string }> } {
  const validation = validateDaemonPlanRequest({
    plan: {
      mode: "managed-default",
      bookScope: rawScope,
    },
  });
  if (!validation.ok) {
    const scopeErrors = validation.errors
      .filter((error) => error.field.startsWith("plan.bookScope"))
      .map((error) => ({
        field: error.field.replace(/^plan\.bookScope/, "scope"),
        message: error.message,
      }));
    return {
      ok: false,
      errors: scopeErrors.length > 0
        ? scopeErrors
        : [{
            field: "scope",
            message: "scope must be { type: 'all-active' } or { type: 'book-list', bookIds: string[] }",
          }],
    };
  }
  return { ok: true, scope: validation.value.plan.bookScope };
}

function parseAssistantPolicyBudget(
  rawBudget: unknown,
): { ok: true; value?: AssistantPolicyBudgetInput } | { ok: false; errors: Array<{ field: string; message: string }> } {
  if (rawBudget === undefined) return { ok: true };
  if (typeof rawBudget !== "object" || rawBudget === null || Array.isArray(rawBudget)) {
    return { ok: false, errors: [{ field: "budget", message: "budget must be an object" }] };
  }
  const budget = rawBudget as Record<string, unknown>;
  const spent = typeof budget.spent === "number" ? budget.spent : Number.NaN;
  const limit = typeof budget.limit === "number" ? budget.limit : Number.NaN;
  const errors: Array<{ field: string; message: string }> = [];
  if (!Number.isFinite(spent) || spent < 0) {
    errors.push({ field: "budget.spent", message: "budget.spent must be a non-negative number" });
  }
  if (!Number.isFinite(limit) || limit < 0) {
    errors.push({ field: "budget.limit", message: "budget.limit must be a non-negative number" });
  }
  const currency = typeof budget.currency === "string" ? budget.currency.trim() : "";
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      spent,
      limit,
      ...(currency ? { currency } : {}),
    },
  };
}

function parseAssistantPolicyPermissions(
  rawPermissions: unknown,
): { ok: true; value?: string[] } | { ok: false; errors: Array<{ field: string; message: string }> } {
  if (rawPermissions === undefined) return { ok: true };
  if (!Array.isArray(rawPermissions)) {
    return { ok: false, errors: [{ field: "permissions", message: "permissions must be an array of strings" }] };
  }
  const permissions = rawPermissions
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0);
  if (permissions.length !== rawPermissions.length) {
    return { ok: false, errors: [{ field: "permissions", message: "permissions must contain non-empty strings" }] };
  }
  return { ok: true, value: permissions };
}

function parseAssistantPolicyPlan(
  rawPlan: unknown,
): { ok: true; value: AssistantPolicyPlanStep[] } | { ok: false; errors: Array<{ field: string; message: string }> } {
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    return { ok: false, errors: [{ field: "plan", message: "plan must be a non-empty array" }] };
  }
  const normalized: AssistantPolicyPlanStep[] = [];
  const errors: Array<{ field: string; message: string }> = [];
  rawPlan.forEach((rawStep, index) => {
    if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) {
      errors.push({ field: `plan[${index}]`, message: "plan item must be an object" });
      return;
    }
    const step = rawStep as Record<string, unknown>;
    const action = typeof step.action === "string" ? step.action.trim() : "";
    if (!action) {
      errors.push({ field: `plan[${index}].action`, message: "action must be a non-empty string" });
      return;
    }
    const mode = typeof step.mode === "string" && step.mode.trim().length > 0 ? step.mode.trim() : undefined;
    const bookId = typeof step.bookId === "string" && step.bookId.trim().length > 0 ? step.bookId.trim() : undefined;
    const bookIds = Array.isArray(step.bookIds) && step.bookIds.every((book) => typeof book === "string" && book.trim().length > 0)
      ? step.bookIds.map((book) => (book as string).trim())
      : undefined;
    normalized.push({
      action,
      ...(mode ? { mode } : {}),
      ...(bookId ? { bookId } : {}),
      ...(bookIds ? { bookIds } : {}),
    });
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: normalized };
}

function parseAssistantEvaluateScope(
  rawScope: unknown,
): { ok: true; value: AssistantEvaluateScope } | { ok: false; errors: Array<{ field: string; message: string }> } {
  if (typeof rawScope !== "object" || rawScope === null || Array.isArray(rawScope)) {
    return { ok: false, errors: [{ field: "scope", message: "scope must be an object" }] };
  }
  const scope = rawScope as Record<string, unknown>;
  const type = typeof scope.type === "string" ? scope.type : "";
  const bookId = typeof scope.bookId === "string" ? scope.bookId.trim() : "";
  const errors: Array<{ field: string; message: string }> = [];
  if (!bookId) {
    errors.push({ field: "scope.bookId", message: "scope.bookId must be a non-empty string" });
  }
  if (type === "chapter") {
    const chapter = typeof scope.chapter === "number" ? scope.chapter : Number.NaN;
    if (!Number.isInteger(chapter) || chapter < 1) {
      errors.push({ field: "scope.chapter", message: "scope.chapter must be a positive integer" });
    }
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      value: { type: "chapter", bookId, chapter },
    };
  }
  if (type === "book") {
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { type: "book", bookId } };
  }
  return {
    ok: false,
    errors: [{ field: "scope.type", message: "scope.type must be either 'chapter' or 'book'" }],
  };
}

function parseAssistantWorldReportBody(
  rawBody: unknown,
): { ok: true; value: { bookId: string } } | { ok: false; errors: Array<{ field: string; message: string }> } {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return { ok: false, errors: [{ field: "body", message: "Request body must be a JSON object" }] };
  }
  const body = rawBody as Record<string, unknown>;
  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : "";
  if (!bookId) {
    return { ok: false, errors: [{ field: "bookId", message: "bookId must be a non-empty string" }] };
  }
  return { ok: true, value: { bookId } };
}

function buildAssistantPlanBookTarget(scope: AssistantPlanScope): Pick<AssistantPlanStep, "bookId" | "bookIds"> {
  if (scope.type !== "book-list") return {};
  if (scope.bookIds.length === 1) {
    return { bookId: scope.bookIds[0] };
  }
  return { bookIds: scope.bookIds };
}

function buildAssistantPlanDraft(
  intent: AssistantPlanIntent,
  scope: AssistantPlanScope,
  input: string,
): { plan: AssistantPlanStep[]; risk: { level: AssistantPlanRiskLevel; reasons: string[] } } {
  const bookTarget = buildAssistantPlanBookTarget(scope);
  const chapter = parseAssistantChapterFromInput(input);

  if (intent === "audit") {
    return {
      plan: [
        { stepId: "s1", action: "audit", ...bookTarget, ...(chapter !== undefined ? { chapter } : {}) },
      ],
      risk: {
        level: "low",
        reasons: ["仅执行章节审计，不直接修改内容"],
      },
    };
  }

  if (intent === "audit_and_optimize") {
    return {
      plan: [
        { stepId: "s1", action: "audit", ...bookTarget, ...(chapter !== undefined ? { chapter } : {}) },
        {
          stepId: "s2",
          action: "revise",
          mode: "spot-fix",
          ...bookTarget,
          ...(chapter !== undefined ? { chapter } : {}),
        },
        { stepId: "s3", action: "re-audit", ...bookTarget, ...(chapter !== undefined ? { chapter } : {}) },
      ],
      risk: {
        level: "medium",
        reasons: ["涉及章节内容改写"],
      },
    };
  }

  if (intent === "generate_structure") {
    return {
      plan: [
        { stepId: "s1", action: "plan-next", ...bookTarget },
      ],
      risk: {
        level: "medium",
        reasons: ["将生成项目结构大纲"],
      },
    };
  }

  return {
    plan: [
      { stepId: "s1", action: "plan-next", ...bookTarget },
      { stepId: "s2", action: "write-next", ...bookTarget },
    ],
    risk: {
      level: "low",
      reasons: ["将生成下一章节草稿"],
    },
  };
}

function normalizeAssistantCrudKeyword(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readRelativeSource(root: string, filePath: string): string {
  const value = relative(root, filePath).replace(/\\/g, "/");
  return value.length > 0 ? value : filePath;
}

function pickEvidenceLines(content: string, keyword?: string, maxItems = 3): Array<{ line: number; excerpt: string }> {
  const lines = content.split(/\r?\n/u);
  const nonEmptyLines = lines
    .map((line, index) => ({ line: index + 1, excerpt: line.trim() }))
    .filter((entry) => entry.excerpt.length > 0);
  const normalizedKeyword = keyword?.toLowerCase();
  const matched = nonEmptyLines
    .filter((entry) => !normalizedKeyword || entry.excerpt.toLowerCase().includes(normalizedKeyword));
  if (matched.length > 0) return matched.slice(0, maxItems);
  return nonEmptyLines.slice(0, maxItems);
}

function parseAssistantCrudReadBody(rawBody: unknown): { ok: true; value: { dimension: AssistantCrudReadDimension; bookId: string; chapter?: number; keyword?: string } } | { ok: false; errors: Array<{ field: string; message: string }> } {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return { ok: false, errors: [{ field: "body", message: "Request body must be a JSON object" }] };
  }
  const body = rawBody as Record<string, unknown>;
  const dimension = typeof body.dimension === "string" ? body.dimension.trim() : "";
  const bookId = typeof body.bookId === "string" ? body.bookId.trim() : "";
  const chapter = typeof body.chapter === "number" ? body.chapter : Number.NaN;
  const errors: Array<{ field: string; message: string }> = [];
  if (dimension !== "book" && dimension !== "volume" && dimension !== "chapter" && dimension !== "character" && dimension !== "hook") {
    errors.push({ field: "dimension", message: "dimension must be one of book/volume/chapter/character/hook" });
  }
  if (!bookId) errors.push({ field: "bookId", message: "bookId must be a non-empty string" });
  if (dimension === "chapter" && (!Number.isInteger(chapter) || chapter < 1)) {
    errors.push({ field: "chapter", message: "chapter must be a positive integer when dimension is chapter" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      dimension: dimension as AssistantCrudReadDimension,
      bookId,
      ...(dimension === "chapter" ? { chapter } : {}),
      ...(normalizeAssistantCrudKeyword(body.keyword) ? { keyword: normalizeAssistantCrudKeyword(body.keyword) } : {}),
    },
  };
}

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
  const assistantTaskSnapshots = new Map<string, AssistantTaskSnapshot>();
  const assistantDeletePreviews = new Map<string, { readonly body: { target: "chapter" | "run"; bookId: string; chapter?: number; runId?: string }; readonly expiresAt: number }>();
  const assistantDeleteRecoveryStorePath = join(root, ".inkos", "assistant-delete-recovery.v1.json");
  const assistantTaskSnapshotStorePath = join(root, ASSISTANT_TASK_SNAPSHOT_STORE_FILE);
  let assistantTaskSnapshotPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let assistantTaskSnapshotPersistInFlight: Promise<void> | null = null;
  let assistantTaskSnapshotPersistQueued = false;

  async function persistAssistantTaskSnapshotsNow(): Promise<void> {
    const store = parseAssistantTaskSnapshotStore({ tasks: [...assistantTaskSnapshots.values()] });
    await mkdir(dirname(assistantTaskSnapshotStorePath), { recursive: true });
    await writeFile(assistantTaskSnapshotStorePath, JSON.stringify(store, null, 2), "utf-8");
  }

  function flushAssistantTaskSnapshotPersistence(): void {
    if (assistantTaskSnapshotPersistInFlight) {
      assistantTaskSnapshotPersistQueued = true;
      return;
    }
    assistantTaskSnapshotPersistInFlight = persistAssistantTaskSnapshotsNow()
      .catch(() => undefined)
      .finally(() => {
        assistantTaskSnapshotPersistInFlight = null;
        if (assistantTaskSnapshotPersistQueued) {
          assistantTaskSnapshotPersistQueued = false;
          flushAssistantTaskSnapshotPersistence();
        }
      });
  }

  function scheduleAssistantTaskSnapshotPersistence(): void {
    if (assistantTaskSnapshotPersistTimer !== null) {
      clearTimeout(assistantTaskSnapshotPersistTimer);
    }
    assistantTaskSnapshotPersistTimer = setTimeout(() => {
      assistantTaskSnapshotPersistTimer = null;
      flushAssistantTaskSnapshotPersistence();
    }, ASSISTANT_TASK_SNAPSHOT_PERSIST_DEBOUNCE_MS);
  }

  const assistantTaskSnapshotHydration = (async () => {
    try {
      const raw = await readFile(assistantTaskSnapshotStorePath, "utf-8");
      const parsed = parseAssistantTaskSnapshotStore(JSON.parse(raw));
      parsed.tasks.forEach((snapshot) => {
        assistantTaskSnapshots.set(snapshot.taskId, snapshot);
      });
    } catch {
      // ignore hydration errors and fallback to in-memory snapshots
    }
  })();

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

  function emitAssistantTaskEvent(
    event: "assistant:step:start" | "assistant:step:success" | "assistant:step:fail" | "assistant:done",
    payload: Record<string, unknown> & { readonly taskId: string; readonly sessionId: string },
  ): void {
    const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString();
    const data = { ...payload, timestamp };
    const taskId = payload.taskId;
    const previous = assistantTaskSnapshots.get(taskId);
    const currentStepId = typeof payload.stepId === "string" ? payload.stepId : undefined;
    const retryContext = typeof payload.retryContext === "object" && payload.retryContext !== null && !Array.isArray(payload.retryContext)
      ? payload.retryContext as Record<string, unknown>
      : undefined;

    if (event === "assistant:done") {
      assistantTaskSnapshots.set(taskId, {
        taskId,
        sessionId: payload.sessionId,
        status: payload.status === "succeeded" ? "succeeded" : "failed",
        ...(currentStepId !== undefined ? { currentStepId } : {}),
        steps: previous?.steps ?? {},
        lastUpdatedAt: timestamp,
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        ...(retryContext ? { retryContext } : {}),
      });
      scheduleAssistantTaskSnapshotPersistence();
      broadcast(event, data);
      return;
    }

    const stepId = currentStepId;
    const stepStatus = event === "assistant:step:start" ? "running" : event === "assistant:step:success" ? "succeeded" : "failed";
    const previousStep = stepId ? previous?.steps?.[stepId] : undefined;
    const nextSteps = {
      ...(previous?.steps ?? {}),
      ...(stepId
        ? {
          [stepId]: {
            stepId,
            ...(typeof payload.action === "string" ? { action: payload.action } : {}),
            ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
            status: stepStatus,
            ...(stepStatus === "running"
              ? { startedAt: timestamp }
              : { ...(previousStep?.startedAt !== undefined ? { startedAt: previousStep.startedAt } : {}), finishedAt: timestamp }),
            ...(typeof payload.error === "string" ? { error: payload.error } : {}),
          } satisfies AssistantTaskStepSnapshot,
        }
        : {}),
    };

    assistantTaskSnapshots.set(taskId, {
      taskId,
      sessionId: payload.sessionId,
      status: event === "assistant:step:fail" ? "failed" : "running",
      ...(stepId !== undefined ? { currentStepId: stepId } : {}),
      steps: nextSteps,
      lastUpdatedAt: timestamp,
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      ...(retryContext ? { retryContext } : previous?.retryContext !== undefined ? { retryContext: previous.retryContext } : {}),
    });
    scheduleAssistantTaskSnapshotPersistence();

    broadcast(event, data);
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
  const apiLogger = createLogger({ tag: "studio-api", sinks: [sseSink] });

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

  function normalizeAssistantExecuteStep(step: AssistantPlanStep): AssistantExecuteStepRef | null {
    if (step.action !== "audit" && step.action !== "revise" && step.action !== "re-audit") {
      return null;
    }
    const stepBookId = typeof step.bookId === "string"
      ? step.bookId
      : (Array.isArray(step.bookIds) && step.bookIds.length === 1 && typeof step.bookIds[0] === "string"
        ? step.bookIds[0]
        : null);
    const stepChapter = typeof step.chapter === "number" ? step.chapter : null;
    if (!stepBookId || stepChapter === null || !Number.isInteger(stepChapter) || stepChapter < 1) {
      return null;
    }
    return {
      stepId: step.stepId,
      action: step.action,
      bookId: stepBookId,
      chapter: stepChapter,
      ...(step.mode !== undefined ? { mode: step.mode } : {}),
    };
  }

  async function parseApiErrorMessage(response: Response): Promise<string> {
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const nestedError = payload?.["error"];
    if (typeof nestedError === "string") return nestedError;
    if (nestedError && typeof nestedError === "object") {
      const nestedMessage = (nestedError as Record<string, unknown>)["message"];
      if (typeof nestedMessage === "string") return nestedMessage;
    }
    const topMessage = payload?.["message"];
    if (typeof topMessage === "string") return topMessage;
    return response.statusText || `Request failed with status ${response.status}`;
  }

  async function waitForChapterRunCompletion(
    bookId: string,
    runId: string,
    timeoutMs = 30_000,
  ): Promise<ChapterRunRecord> {
    const started = Date.now();
    let delayMs = 100;
    while (Date.now() - started < timeoutMs) {
      const run = await chapterRunStore.getRun(bookId, runId);
      if (run && run.status !== "running") {
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1_000);
    }
    throw new Error(`Timed out waiting for chapter run ${runId}`);
  }

  function generateAssistantRunId(): string {
    return `asst_run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  async function loadAssistantDeleteRecoveryStore(): Promise<AssistantCrudDeleteRecoveryStore> {
    try {
      const raw = JSON.parse(await readFile(assistantDeleteRecoveryStorePath, "utf-8")) as Partial<AssistantCrudDeleteRecoveryStore>;
      if (raw.version !== 1 || !Array.isArray(raw.entries)) {
        return { version: 1, entries: [] };
      }
      return { version: 1, entries: raw.entries };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  async function saveAssistantDeleteRecoveryStore(store: AssistantCrudDeleteRecoveryStore): Promise<void> {
    await mkdir(dirname(assistantDeleteRecoveryStorePath), { recursive: true });
    await writeFile(assistantDeleteRecoveryStorePath, JSON.stringify(store, null, 2), "utf-8");
  }

  async function appendAssistantDeleteRecoveryEntry(entry: AssistantCrudDeleteRecoveryEntry): Promise<void> {
    const store = await loadAssistantDeleteRecoveryStore();
    await saveAssistantDeleteRecoveryStore({
      version: 1,
      entries: [...store.entries, entry].slice(-200),
    });
  }

  async function markAssistantDeleteRecoveryRestored(restoreId: string): Promise<void> {
    const store = await loadAssistantDeleteRecoveryStore();
    await saveAssistantDeleteRecoveryStore({
      version: 1,
      entries: store.entries.map((entry) => entry.restoreId === restoreId
        ? { ...entry, restoredAt: new Date().toISOString() }
        : entry),
    });
  }

  async function resolveChapterFile(bookId: string, chapter: number): Promise<{ fileName: string; filePath: string; content: string } | null> {
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const prefix = `${String(chapter).padStart(4, "0")}_`;
    let fileName: string | undefined;
    try {
      const files = await readdir(chaptersDir);
      fileName = files.find((file) => file.startsWith(prefix) && file.endsWith(".md"));
    } catch {
      return null;
    }
    if (!fileName) return null;
    const filePath = join(chaptersDir, fileName);
    try {
      const content = await readFile(filePath, "utf-8");
      return { fileName, filePath, content };
    } catch {
      return null;
    }
  }

  async function collectAssistantCrudEvidence(
    filePath: string,
    keyword?: string,
    maxItems = 3,
  ): Promise<AssistantCrudEvidence[]> {
    try {
      const content = await readFile(filePath, "utf-8");
      return pickEvidenceLines(content, keyword, maxItems).map((entry) => ({
        source: readRelativeSource(root, filePath),
        locator: `line:${entry.line}`,
        excerpt: entry.excerpt,
      }));
    } catch {
      return [];
    }
  }

  async function resolveAssistantCrudRead(
    query: { dimension: AssistantCrudReadDimension; bookId: string; chapter?: number; keyword?: string },
  ): Promise<{ summary: string; evidence: AssistantCrudEvidence[] }> {
    const bookDir = state.bookDir(query.bookId);
    const filesByDimension: Record<AssistantCrudReadDimension, string[]> = {
      book: [join(bookDir, "book.json"), join(bookDir, "story", "story_bible.md")],
      volume: [join(bookDir, "story", "volume_outline.md"), join(bookDir, "story", "book_rules.md")],
      chapter: [],
      character: [join(bookDir, "story", "character_matrix.md"), join(bookDir, "story", "current_state.md")],
      hook: [join(bookDir, "story", "pending_hooks.md"), join(bookDir, "story", "chapter_summaries.md")],
    };
    if (query.dimension === "chapter" && query.chapter !== undefined) {
      const chapterFile = await resolveChapterFile(query.bookId, query.chapter);
      if (chapterFile) {
        filesByDimension.chapter.push(chapterFile.filePath);
      }
    }
    const evidence = (
      await Promise.all(filesByDimension[query.dimension].map(async (filePath) =>
        await collectAssistantCrudEvidence(filePath, query.keyword)))
    ).flat();
    if (evidence.length === 0) {
      return {
        summary: "未命中可用内容。",
        evidence: [{
          source: `books/${query.bookId}`,
          locator: "n/a",
          excerpt: "未找到可用来源文件或匹配文本。",
        }],
      };
    }
    return {
      summary: `命中 ${evidence.length} 条证据。`,
      evidence: evidence.slice(0, 8),
    };
  }

  function clampSerializableScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function deriveAssistantEvaluateReport(
    runs: ReadonlyArray<ChapterRunRecord>,
    scope: AssistantEvaluateScope,
  ): AssistantEvaluateReport {
    const failedRuns = runs.filter((run) => run.status === "failed");
    const unchangedRuns = runs.filter((run) => run.decision === "unchanged");
    const appliedRuns = runs.filter((run) => run.decision === "applied");
    const dimensions: AssistantEvaluateDimensions = {
      continuity: clampSerializableScore(85 - failedRuns.length * 25 - unchangedRuns.length * 8 + appliedRuns.length * 2),
      readability: clampSerializableScore(82 - failedRuns.length * 18 - unchangedRuns.length * 5 + appliedRuns.length * 2),
      styleConsistency: clampSerializableScore(80 - failedRuns.length * 15 - unchangedRuns.length * 6 + appliedRuns.length * 2),
      aiTraceRisk: clampSerializableScore(78 - failedRuns.length * 20 - unchangedRuns.length * 7 + appliedRuns.length),
    };
    const overallScore = clampSerializableScore(
      (dimensions.continuity + dimensions.readability + dimensions.styleConsistency + dimensions.aiTraceRisk) / 4,
    );

    const blockingIssues = [
      ...failedRuns
        .map((run) => run.error?.trim() || `章节 ${run.chapter} 的 ${run.actionType}${ASSISTANT_EVALUATE_FAILED_RUN_FALLBACK_MESSAGE}`)
        .filter((issue) => issue.length > 0),
      ...unchangedRuns
        .map((run) => run.unchangedReason?.trim() || `章节 ${run.chapter}${ASSISTANT_EVALUATE_UNCHANGED_RUN_FALLBACK_MESSAGE}`)
        .filter((issue) => issue.length > 0),
    ];

    const evidenceFromRuns = runs.map((run) => {
      const terminalEvent = [...run.events].reverse().find((event) => event.type === "success" || event.type === "fail");
      const excerpt = run.error?.trim()
        || run.unchangedReason?.trim()
        || terminalEvent?.message?.trim()
        || `${run.actionType} ${run.status}`;
      const reason = run.status === "failed"
        ? "运行失败，存在阻断风险"
        : run.decision === "unchanged"
          ? "运行完成但未应用修订"
          : "运行成功并应用修订";
      return {
        source: `chapter-run:${run.runId}:book:${run.bookId}:chapter:${run.chapter}`,
        excerpt,
        reason,
      };
    });
    const fallbackSource = scope.type === "chapter"
      ? `chapter:${scope.bookId}:${scope.chapter}`
      : `book:${scope.bookId}`;
    const fallbackEvidence: AssistantEvaluateEvidence = {
      source: fallbackSource,
      excerpt: "暂无运行证据，使用范围级摘要作为最小可追溯证据。",
      reason: "当前评估未检索到可用 run 数据",
    };

    const evidence = evidenceFromRuns.length > 0 ? evidenceFromRuns : [fallbackEvidence];
    return {
      overallScore,
      dimensions,
      blockingIssues,
      evidence,
    };
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

  const buildSchedulerConfig = async (_plan?: RunPlan) => {
    const currentConfig = await loadCurrentProjectConfig();
    return {
      ...(await buildPipelineConfig()),
      radarCron: currentConfig.daemon.schedule.radarCron,
      writeCron: currentConfig.daemon.schedule.writeCron,
      maxConcurrentBooks: currentConfig.daemon.maxConcurrentBooks,
      chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
      retryDelayMs: currentConfig.daemon.retryDelayMs,
      cooldownAfterChapterMs: currentConfig.daemon.cooldownAfterChapterMs,
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

  app.post("/api/assistant/read", async (c) => {
    const parsed = parseAssistantCrudReadBody(await c.req.json<unknown>().catch(() => null));
    if (!parsed.ok) {
      return c.json({ code: "ASSISTANT_READ_VALIDATION_FAILED", errors: parsed.errors }, 422);
    }
    const { dimension, bookId, chapter, keyword } = parsed.value;
    const result = await resolveAssistantCrudRead(parsed.value);
    return c.json({
      ok: true,
      dimension,
      bookId,
      ...(chapter !== undefined ? { chapter } : {}),
      ...(keyword ? { keyword } : {}),
      summary: result.summary,
      evidence: result.evidence,
    });
  });

  app.post("/api/assistant/chat", async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({
        code: "ASSISTANT_CHAT_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const payload = body as Record<string, unknown>;
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    const scopeBookTitles = Array.isArray(payload.scopeBookTitles)
      ? (payload.scopeBookTitles as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    if (!prompt) {
      return c.json({
        code: "ASSISTANT_CHAT_VALIDATION_FAILED",
        errors: [{ field: "prompt", message: "prompt must be a non-empty string" }],
      }, 422);
    }

    // Short-circuit: model identity
    if (ASSISTANT_MODEL_IDENTITY_PATTERN.test(prompt)) {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const reply = buildAssistantModelIdentityReply(currentConfig);
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: true, response: reply }) });
      });
    }

    // Short-circuit: vague punctuation-only input
    if (ASSISTANT_VAGUE_PROMPT_PATTERN.test(prompt)) {
      const reply = "直接告诉我你要做哪件事：查看状态、续写下一章、审计某章，或问我具体问题。";
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: true, response: reply }) });
      });
    }

    broadcast("agent:start", { instruction: prompt });

    const scopeHint = scopeBookTitles.length > 0
      ? `\n\n当前对话聚焦的书籍：${scopeBookTitles.join("、")}。若用户未明确切换书籍，优先基于这些书籍回答并执行。`
      : "";
    const agentPrompt = `${prompt}${scopeHint}`;

    return streamSSE(c, async (stream) => {
      let clientAborted = false;
      let writeChain = Promise.resolve();
      const queueSSE = (event: string, payload: unknown) => {
        if (clientAborted) {
          return writeChain;
        }
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        writeChain = writeChain
          .then(async () => {
            if (clientAborted) return;
            await stream.writeSSE({ event, data });
          })
          .catch(() => {
            // Ignore stream write failures; onAbort will stop subsequent writes.
          });
        return writeChain;
      };

      const keepAlive = setInterval(() => {
        void queueSSE("ping", "");
      }, 15_000);

      stream.onAbort(() => {
        clientAborted = true;
        clearInterval(keepAlive);
      });

      try {
        const { runAgentLoop } = await import("@actalk/inkos-core");

        let lastResponse = "";
        const toolOutcomes: AssistantToolOutcome[] = [];

        const result = await runAgentLoop(
          await buildPipelineConfig(),
          agentPrompt,
          {
            onToolCall: (name, args) => {
              const toolEvent = { type: "tool_call" as const, tool: name, args };
              void queueSSE("assistant:progress", toolEvent);
              broadcast("log", `工具调用：${name}`);
            },
            onToolResult: (name, result) => {
              const truncated = result.length > 500 ? `${result.slice(0, 500)}…` : result;
              const toolResultEvent = { type: "tool_result" as const, tool: name, preview: truncated };
              void queueSSE("assistant:progress", toolResultEvent);
              toolOutcomes.push(parseAssistantToolOutcome(name, result));
            },
            onMessage: (content) => {
              lastResponse = content;
              void queueSSE("assistant:message", { content });
            },
          },
        );

  const rawResponse = result || lastResponse || "处理完成。";
  const finalResponse = buildGroundedAssistantResponse(prompt, toolOutcomes, rawResponse);
        await queueSSE("assistant:done", { ok: true, response: finalResponse });
        broadcast("agent:complete", { instruction: prompt, response: finalResponse });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await queueSSE("assistant:done", { ok: false, error: msg });
        broadcast("agent:error", { instruction: prompt, error: msg });
      } finally {
        clearInterval(keepAlive);
        await writeChain;
      }
    });
  });

  app.post("/api/assistant/delete/preview", async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({
        code: "ASSISTANT_DELETE_PREVIEW_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const payload = body as Record<string, unknown>;
    const targetValue = payload.target;
    const target: "chapter" | "run" | null = targetValue === "chapter" || targetValue === "run"
      ? targetValue
      : null;
    const bookId = typeof payload.bookId === "string" ? payload.bookId.trim() : "";
    const chapter = typeof payload.chapter === "number" ? payload.chapter : Number.NaN;
    const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
    const errors: Array<{ field: string; message: string }> = [];
    if (!target) errors.push({ field: "target", message: "target must be chapter or run" });
    if (!bookId) errors.push({ field: "bookId", message: "bookId must be a non-empty string" });
    if (target === "chapter" && (!Number.isInteger(chapter) || chapter < 1)) {
      errors.push({ field: "chapter", message: "chapter must be a positive integer when target is chapter" });
    }
    if (target === "run" && !runId) {
      errors.push({ field: "runId", message: "runId must be a non-empty string when target is run" });
    }
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_DELETE_PREVIEW_VALIDATION_FAILED", errors }, 422);
    }
    if (!target) {
      return c.json({ code: "ASSISTANT_DELETE_PREVIEW_VALIDATION_FAILED", errors: [{ field: "target", message: "target must be chapter or run" }] }, 422);
    }

    let preview: AssistantCrudDeletePreview;
    if (target === "chapter") {
      const chapterFile = await resolveChapterFile(bookId, chapter);
      if (!chapterFile) {
        return c.json({ error: { code: "ASSISTANT_DELETE_TARGET_NOT_FOUND", message: "Chapter not found." } }, 404);
      }
      const runs = await chapterRunStore.listRuns(bookId, { chapter, limit: 100 });
      const evidence = pickEvidenceLines(chapterFile.content, undefined, 2).map((entry) => ({
        source: readRelativeSource(root, chapterFile.filePath),
        locator: `line:${entry.line}`,
        excerpt: entry.excerpt,
      }));
      preview = {
        target,
        bookId,
        impactSummary: `将软删除章节文件 ${chapterFile.fileName}，并影响 ${runs.length} 条关联 run 记录（不删除 run）。`,
        evidence,
        previewId: `asst_del_preview_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        confirmBy: new Date(Date.now() + ASSISTANT_DELETE_PREVIEW_TTL_MS).toISOString(),
      };
      assistantDeletePreviews.set(preview.previewId, {
        body: { target, bookId, chapter },
        expiresAt: Date.now() + ASSISTANT_DELETE_PREVIEW_TTL_MS,
      });
    } else {
      const run = await chapterRunStore.getRun(bookId, runId, { includeDeleted: true });
      if (!run) {
        return c.json({ error: { code: "ASSISTANT_DELETE_TARGET_NOT_FOUND", message: "Run not found." } }, 404);
      }
      if (run.deletedAt) {
        return c.json({ error: { code: "ASSISTANT_DELETE_ALREADY_DELETED", message: "Run already soft-deleted." } }, 409);
      }
      const terminalEvent = [...run.events].reverse().find((event) => event.type === "success" || event.type === "fail");
      preview = {
        target,
        bookId,
        impactSummary: `将软删除 run ${run.runId}（${run.actionType}/chapter ${run.chapter}）。`,
        evidence: [{
          source: `chapter-run:${run.runId}`,
          locator: terminalEvent ? `event:${terminalEvent.index}` : "event:n/a",
          excerpt: terminalEvent?.message?.trim() || `${run.actionType} ${run.status}`,
        }],
        previewId: `asst_del_preview_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        confirmBy: new Date(Date.now() + ASSISTANT_DELETE_PREVIEW_TTL_MS).toISOString(),
      };
      assistantDeletePreviews.set(preview.previewId, {
        body: { target, bookId, runId },
        expiresAt: Date.now() + ASSISTANT_DELETE_PREVIEW_TTL_MS,
      });
    }

    return c.json({ ok: true, requiresConfirmation: true, preview });
  });

  app.post("/api/assistant/delete/execute", async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({
        code: "ASSISTANT_DELETE_EXECUTE_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const payload = body as Record<string, unknown>;
    const previewId = typeof payload.previewId === "string" ? payload.previewId.trim() : "";
    const confirmed = payload.confirmed === true;
    const errors: Array<{ field: string; message: string }> = [];
    if (!previewId) errors.push({ field: "previewId", message: "previewId must be a non-empty string" });
    if (!confirmed) errors.push({ field: "confirmed", message: "confirmed must be true to execute delete" });
    if (errors.length > 0) return c.json({ code: "ASSISTANT_DELETE_EXECUTE_VALIDATION_FAILED", errors }, 422);

    const draft = assistantDeletePreviews.get(previewId);
    if (!draft || draft.expiresAt < Date.now()) {
      assistantDeletePreviews.delete(previewId);
      return c.json({ error: { code: "ASSISTANT_DELETE_PREVIEW_EXPIRED", message: "Delete preview expired." } }, 409);
    }
    assistantDeletePreviews.delete(previewId);

    const deletedAt = new Date().toISOString();
    const recoverBefore = new Date(Date.now() + ASSISTANT_DELETE_RECOVERY_WINDOW_MS).toISOString();
    const restoreId = `asst_restore_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (draft.body.target === "chapter") {
      const chapter = draft.body.chapter;
      if (!chapter) {
        return c.json({ error: { code: "ASSISTANT_DELETE_TARGET_INVALID", message: "Chapter preview payload is invalid." } }, 500);
      }
      const chapterFile = await resolveChapterFile(draft.body.bookId, chapter);
      if (!chapterFile) {
        return c.json({ error: { code: "ASSISTANT_DELETE_TARGET_NOT_FOUND", message: "Chapter not found." } }, 404);
      }
      await appendAssistantDeleteRecoveryEntry({
        restoreId,
        target: "chapter",
        bookId: draft.body.bookId,
        chapter,
        chapterFileName: chapterFile.fileName,
        chapterContent: chapterFile.content,
        deletedAt,
        recoverBefore,
      });
      await unlink(chapterFile.filePath);
      broadcast("assistant:delete:executed", {
        target: "chapter",
        bookId: draft.body.bookId,
        chapter,
        restoreId,
        deletedAt,
        recoverBefore,
      });
      return c.json({
        ok: true,
        target: "chapter",
        bookId: draft.body.bookId,
        chapter,
        restoreId,
        deletedAt,
        recoverBefore,
      });
    }

    const runId = draft.body.runId;
    if (!runId) {
      return c.json({ error: { code: "ASSISTANT_DELETE_TARGET_INVALID", message: "Run preview payload is invalid." } }, 500);
    }
    const run = await chapterRunStore.getRun(draft.body.bookId, runId, { includeDeleted: true });
    if (!run) {
      return c.json({ error: { code: "ASSISTANT_DELETE_TARGET_NOT_FOUND", message: "Run not found." } }, 404);
    }
    const removed = await chapterRunStore.deleteRun(draft.body.bookId, runId);
    if (!removed) {
      return c.json({ error: { code: "ASSISTANT_DELETE_ALREADY_DELETED", message: "Run already soft-deleted." } }, 409);
    }
    await appendAssistantDeleteRecoveryEntry({
      restoreId,
      target: "run",
      bookId: draft.body.bookId,
      chapter: run.chapter,
      runId: run.runId,
      deletedAt,
      recoverBefore,
    });
    broadcast("assistant:delete:executed", {
      target: "run",
      bookId: draft.body.bookId,
      runId: run.runId,
      chapter: run.chapter,
      restoreId,
      deletedAt,
      recoverBefore,
    });
    return c.json({
      ok: true,
      target: "run",
      bookId: draft.body.bookId,
      runId: run.runId,
      chapter: run.chapter,
      restoreId,
      deletedAt,
      recoverBefore,
    });
  });

  app.post("/api/assistant/delete/restore", async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({
        code: "ASSISTANT_DELETE_RESTORE_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const payload = body as Record<string, unknown>;
    const restoreId = typeof payload.restoreId === "string" ? payload.restoreId.trim() : "";
    if (!restoreId) {
      return c.json({
        code: "ASSISTANT_DELETE_RESTORE_VALIDATION_FAILED",
        errors: [{ field: "restoreId", message: "restoreId must be a non-empty string" }],
      }, 422);
    }
    const store = await loadAssistantDeleteRecoveryStore();
    const entry = store.entries.find((item) => item.restoreId === restoreId);
    if (!entry) {
      return c.json({ error: { code: "ASSISTANT_DELETE_RESTORE_NOT_FOUND", message: "Restore entry not found." } }, 404);
    }
    if (entry.restoredAt) {
      return c.json({ error: { code: "ASSISTANT_DELETE_ALREADY_RESTORED", message: "Entry already restored." } }, 409);
    }
    if (Date.parse(entry.recoverBefore) < Date.now()) {
      return c.json({ error: { code: "ASSISTANT_DELETE_RESTORE_EXPIRED", message: "Restore window expired." } }, 410);
    }

    if (entry.target === "chapter") {
      const chapter = entry.chapter ?? 0;
      const fileName = entry.chapterFileName ?? "";
      if (!chapter || !fileName || entry.chapterContent === undefined) {
        return c.json({ error: { code: "ASSISTANT_DELETE_RESTORE_CORRUPTED", message: "Restore payload is corrupted." } }, 500);
      }
      const chapterPath = join(state.bookDir(entry.bookId), "chapters", fileName);
      await writeFile(chapterPath, entry.chapterContent, "utf-8");
      await markAssistantDeleteRecoveryRestored(restoreId);
      broadcast("assistant:delete:restored", {
        target: "chapter",
        bookId: entry.bookId,
        chapter,
        restoreId,
      });
      return c.json({ ok: true, target: "chapter", bookId: entry.bookId, chapter, restoreId });
    }

    const restored = await chapterRunStore.restoreRun(entry.bookId, entry.runId ?? "");
    if (!restored) {
      return c.json({ error: { code: "ASSISTANT_DELETE_RESTORE_FAILED", message: "Run restore failed." } }, 409);
    }
    await markAssistantDeleteRecoveryRestored(restoreId);
    broadcast("assistant:delete:restored", {
      target: "run",
      bookId: entry.bookId,
      runId: entry.runId,
      restoreId,
    });
    return c.json({ ok: true, target: "run", bookId: entry.bookId, runId: entry.runId, restoreId });
  });

  app.post("/api/assistant/crud", async (c) => {
    const relay = (payload: unknown, status: number) =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    const body = await c.req.json<unknown>().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({
        code: "ASSISTANT_CRUD_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const payload = body as Record<string, unknown>;
    const input = typeof payload.input === "string" ? payload.input.trim() : "";
    const bookId = typeof payload.bookId === "string" ? payload.bookId.trim() : "";
    if (!input) {
      return c.json({ code: "ASSISTANT_CRUD_VALIDATION_FAILED", errors: [{ field: "input", message: "input must be a non-empty string" }] }, 422);
    }

    if (ASSISTANT_CRUD_RESTORE_PATTERN.test(input)) {
      const restoreId = (typeof payload.restoreId === "string" ? payload.restoreId.trim() : "")
        || input.match(ASSISTANT_CRUD_RESTORE_ID_PATTERN)?.[1]
        || "";
      if (!restoreId) {
        return c.json({ code: "ASSISTANT_CRUD_VALIDATION_FAILED", errors: [{ field: "restoreId", message: "restoreId is required for restore prompts" }] }, 422);
      }
      const response = await app.request(`${ASSISTANT_INTERNAL_API_BASE}/api/assistant/delete/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restoreId }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) return relay(result, response.status);
      return c.json({ kind: "delete-restored", restoreId, result });
    }

    if (ASSISTANT_CRUD_DELETE_PATTERN.test(input)) {
      const previewId = typeof payload.previewId === "string" ? payload.previewId.trim() : "";
      if (payload.confirmed === true && previewId) {
        const response = await app.request(`${ASSISTANT_INTERNAL_API_BASE}/api/assistant/delete/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previewId, confirmed: true }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) return relay(result, response.status);
        return c.json({ kind: "delete-executed", result });
      }
      if (!bookId) {
        return c.json({ code: "ASSISTANT_CRUD_VALIDATION_FAILED", errors: [{ field: "bookId", message: "bookId is required for delete prompts" }] }, 422);
      }
      const runId = input.match(ASSISTANT_CRUD_RUN_ID_PATTERN)?.[1];
      const chapter = parseAssistantChapterFromInput(input);
      const targetPayload = runId
        ? { target: "run", bookId, runId }
        : { target: "chapter", bookId, chapter };
      const response = await app.request(`${ASSISTANT_INTERNAL_API_BASE}/api/assistant/delete/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetPayload),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) return relay(result, response.status);
      return c.json({ kind: "delete-preview", result });
    }

    if (ASSISTANT_CRUD_READ_PATTERN.test(input)) {
      if (!bookId) {
        return c.json({ code: "ASSISTANT_CRUD_VALIDATION_FAILED", errors: [{ field: "bookId", message: "bookId is required for read prompts" }] }, 422);
      }
      const dimension = parseAssistantCrudDimensionFromInput(input);
      const chapter = dimension === "chapter" ? parseAssistantChapterFromInput(input) : undefined;
      const response = await app.request(`${ASSISTANT_INTERNAL_API_BASE}/api/assistant/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dimension,
          bookId,
          ...(chapter !== undefined ? { chapter } : {}),
          ...(typeof payload.keyword === "string" ? { keyword: payload.keyword } : {}),
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) return relay(result, response.status);
      return c.json({ kind: "read", result });
    }

    return c.json({
      error: {
        code: "ASSISTANT_CRUD_INTENT_UNKNOWN",
        message: "Unable to detect read/delete/restore intent from input.",
      },
    }, 422);
  });

  app.post("/api/assistant/plan", async (c) => {
    const rawBody = await c.req.json<unknown>().catch(() => null);
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({
        code: "ASSISTANT_PLAN_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }

    const body = rawBody as Record<string, unknown>;
    const errors: Array<{ field: string; message: string }> = [];
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      errors.push({ field: "sessionId", message: "sessionId must be a non-empty string" });
    }
    const input = typeof body.input === "string" ? body.input.trim() : "";
    if (!input) {
      errors.push({ field: "input", message: "input must be a non-empty string" });
    }
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_PLAN_VALIDATION_FAILED", errors }, 422);
    }

    if (body.scope === undefined) {
      return c.json({
        error: {
          code: "ASSISTANT_PLAN_SCOPE_REQUIRED",
          message: "scope is required for assistant plan",
        },
      }, 400);
    }

    const parsedScope = parseAssistantPlanScope(body.scope);
    if (!parsedScope.ok) {
      return c.json({ code: "ASSISTANT_PLAN_VALIDATION_FAILED", errors: parsedScope.errors }, 422);
    }

    const intent = resolveAssistantPlanIntent(input);
    if (!intent) {
      return c.json({
        error: {
          code: "ASSISTANT_PLAN_INTENT_UNKNOWN",
          message: "Unable to recognize assistant intent from input.",
        },
      }, 422);
    }

    const taskId = `asst_t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const drafted = buildAssistantPlanDraft(intent, parsedScope.scope, input);
    return c.json({
      taskId,
      intent,
      plan: drafted.plan,
      requiresConfirmation: true,
      risk: drafted.risk,
    });
  });

  app.post("/api/assistant/policy/check", async (c) => {
    const rawBody = await c.req.json<unknown>().catch(() => null);
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({
        code: "ASSISTANT_POLICY_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const body = rawBody as Record<string, unknown>;
    const errors: Array<{ field: string; message: string }> = [];
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) errors.push({ field: "sessionId", message: "sessionId must be a non-empty string" });
    const planParsed = parseAssistantPolicyPlan(body.plan);
    if (!planParsed.ok) {
      errors.push(...planParsed.errors);
    }
    const budgetParsed = parseAssistantPolicyBudget(body.budget);
    if (!budgetParsed.ok) {
      errors.push(...budgetParsed.errors);
    }
    const permissionsParsed = parseAssistantPolicyPermissions(body.permissions);
    if (!permissionsParsed.ok) {
      errors.push(...permissionsParsed.errors);
    }
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_POLICY_VALIDATION_FAILED", errors }, 422);
    }
    const budgetInput = budgetParsed.ok ? budgetParsed.value : undefined;
    const permissionsInput = permissionsParsed.ok ? permissionsParsed.value : undefined;
    const planInput = (planParsed as { ok: true; value: AssistantPolicyPlanStep[] }).value;

    const policy = evaluateAssistantPolicy({
      plan: planInput,
      approved: body.approved === true,
      ...(permissionsInput ? { permissions: permissionsInput } : {}),
      ...(budgetInput ? { budget: budgetInput } : {}),
    });
    return c.json(policy);
  });

  app.get("/api/assistant/skills", (c) => {
    const rawPermissions = c.req.query("permissions");
    const permissions = typeof rawPermissions === "string" && rawPermissions.trim().length > 0
      ? rawPermissions.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
      : undefined;
    return c.json({
      permissions: permissions ?? [],
      skills: listAssistantSkills(permissions),
    });
  });

  app.post("/api/assistant/execute", async (c) => {
    const rawBody = await c.req.json<unknown>().catch(() => null);
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({
        code: "ASSISTANT_EXECUTE_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const body = rawBody as Record<string, unknown>;
    const errors: Array<{ field: string; message: string }> = [];
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!taskId) errors.push({ field: "taskId", message: "taskId must be a non-empty string" });
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) errors.push({ field: "sessionId", message: "sessionId must be a non-empty string" });
    const approved = body.approved === true;
    if (!Array.isArray(body.plan)) {
      errors.push({ field: "plan", message: "plan must be a non-empty array" });
    }
    const budgetParsed = parseAssistantPolicyBudget(body.budget);
    if (!budgetParsed.ok) {
      errors.push(...budgetParsed.errors);
    }
    const permissionsParsed = parseAssistantPolicyPermissions(body.permissions);
    if (!permissionsParsed.ok) {
      errors.push(...permissionsParsed.errors);
    }
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_EXECUTE_VALIDATION_FAILED", errors }, 422);
    }

    const plan = (body.plan as AssistantPlanStep[])
      .map((step) => normalizeAssistantExecuteStep(step))
      .filter((step): step is AssistantExecuteStepRef => step !== null);
    const auditStep = plan.find((step) => step.action === "audit");
    const reviseStep = plan.find((step) => step.action === "revise");
    const reAuditStep = plan.find((step) => step.action === "re-audit");
    if (!auditStep || !reviseStep || !reAuditStep) {
      return c.json({
        code: "ASSISTANT_EXECUTE_VALIDATION_FAILED",
        errors: [{
          field: "plan",
          message: "plan must include audit, revise and re-audit steps with single book and chapter targets",
        }],
      }, 422);
    }
    const budgetInput = budgetParsed.ok ? budgetParsed.value : undefined;
    const permissionsInput = permissionsParsed.ok ? permissionsParsed.value : undefined;

    const skillAuthorization = authorizeAssistantSkillPlan(plan, permissionsInput);
    if (!skillAuthorization.allow) {
      const reasons = skillAuthorization.denied.map((item) => item.reason);
      const finalBlockedMessage = reasons.join("; ");
      apiLogger.warn("assistant skill authorization blocked", {
        taskId,
        sessionId,
        denied: skillAuthorization.denied,
      });
      broadcast("assistant:policy:blocked", {
        taskId,
        sessionId,
        level: "warn",
        severity: "warn",
        timestamp: new Date().toISOString(),
        reasons,
        deniedSkills: skillAuthorization.denied,
        message: finalBlockedMessage,
      });
      emitAssistantTaskEvent("assistant:done", {
        taskId,
        sessionId,
        status: "failed",
        error: finalBlockedMessage,
      });
      return c.json({
        error: {
          code: "ASSISTANT_SKILL_UNAUTHORIZED",
          message: finalBlockedMessage,
          taskId,
          denied: skillAuthorization.denied,
        },
      }, 403);
    }

    const policy = evaluateAssistantPolicy({
      plan,
      approved,
      ...(permissionsInput ? { permissions: permissionsInput } : {}),
      ...(budgetInput ? { budget: budgetInput } : {}),
    });
    const blockedMessage = policy.reasons.join("; ");
    const finalBlockedMessage = blockedMessage.length > 0
      ? blockedMessage
      : "Assistant execution blocked by policy guard.";
    if (policy.budgetWarning) {
      broadcast("assistant:budget:warning", {
        taskId,
        sessionId,
        level: "warn",
        severity: "warn",
        timestamp: new Date().toISOString(),
        ...policy.budgetWarning,
      });
    }
    if (!policy.allow) {
      broadcast("assistant:policy:blocked", {
        taskId,
        sessionId,
        level: "warn",
        severity: "warn",
        timestamp: new Date().toISOString(),
        riskLevel: policy.riskLevel,
        reasons: policy.reasons,
        requiredApprovals: policy.requiredApprovals,
        message: finalBlockedMessage,
      });
      emitAssistantTaskEvent("assistant:done", {
        taskId,
        sessionId,
        status: "failed",
        error: finalBlockedMessage,
      });
      return c.json({
        error: {
          code: "ASSISTANT_EXECUTE_POLICY_BLOCKED",
          message: finalBlockedMessage,
          taskId,
          policy,
        },
      }, 409);
    }

    const auditRunId = generateAssistantRunId();
    const reAuditRunId = generateAssistantRunId();

    emitAssistantTaskEvent("assistant:step:start", {
      taskId,
      sessionId,
      stepId: auditStep.stepId,
      action: auditStep.action,
      runId: auditRunId,
      bookId: auditStep.bookId,
      chapter: auditStep.chapter,
    });
    const auditResponse = await app.request(
      `http://localhost/api/books/${auditStep.bookId}/audit/${auditStep.chapter}`,
      { method: "POST" },
    );
    if (!auditResponse.ok) {
      const error = await parseApiErrorMessage(auditResponse);
      emitAssistantTaskEvent("assistant:step:fail", {
        taskId,
        sessionId,
        stepId: auditStep.stepId,
        action: auditStep.action,
        runId: auditRunId,
        bookId: auditStep.bookId,
        chapter: auditStep.chapter,
        error,
      });
      return c.json({
        error: {
          code: "ASSISTANT_EXECUTE_STEP_FAILED",
          message: error,
          taskId,
          stepId: auditStep.stepId,
          runId: auditRunId,
        },
      }, 500);
    }
    emitAssistantTaskEvent("assistant:step:success", {
      taskId,
      sessionId,
      stepId: auditStep.stepId,
      action: auditStep.action,
      runId: auditRunId,
      bookId: auditStep.bookId,
      chapter: auditStep.chapter,
    });

    const reviseResponse = await app.request(
      `http://localhost/api/books/${reviseStep.bookId}/revise/${reviseStep.chapter}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(reviseStep.mode !== undefined ? { mode: reviseStep.mode } : {}) }),
      },
    );
    const revisePayload = await reviseResponse.json().catch(() => null) as Record<string, unknown> | null;
    if (!reviseResponse.ok || typeof revisePayload?.["runId"] !== "string") {
      const error = !reviseResponse.ok
        ? await parseApiErrorMessage(reviseResponse)
        : "revise step did not return runId";
      emitAssistantTaskEvent("assistant:step:fail", {
        taskId,
        sessionId,
        stepId: reviseStep.stepId,
        action: reviseStep.action,
        bookId: reviseStep.bookId,
        chapter: reviseStep.chapter,
        error,
      });
      return c.json({
        error: {
          code: "ASSISTANT_EXECUTE_STEP_FAILED",
          message: error,
          taskId,
          stepId: reviseStep.stepId,
        },
      }, 500);
    }
    const reviseRunId = revisePayload["runId"];
    emitAssistantTaskEvent("assistant:step:start", {
      taskId,
      sessionId,
      stepId: reviseStep.stepId,
      action: reviseStep.action,
      runId: reviseRunId,
      bookId: reviseStep.bookId,
      chapter: reviseStep.chapter,
    });

    void (async () => {
      try {
        const reviseRun = await waitForChapterRunCompletion(reviseStep.bookId, reviseRunId);
        if (reviseRun.status !== "succeeded") {
          const error = reviseRun.error ?? "revise step failed";
          emitAssistantTaskEvent("assistant:step:fail", {
            taskId,
            sessionId,
            stepId: reviseStep.stepId,
            action: reviseStep.action,
            runId: reviseRunId,
            bookId: reviseStep.bookId,
            chapter: reviseStep.chapter,
            error,
          });
          emitAssistantTaskEvent("assistant:done", { taskId, sessionId, status: "failed", error });
          return;
        }

        emitAssistantTaskEvent("assistant:step:success", {
          taskId,
          sessionId,
          stepId: reviseStep.stepId,
          action: reviseStep.action,
          runId: reviseRunId,
          bookId: reviseStep.bookId,
          chapter: reviseStep.chapter,
        });
        emitAssistantTaskEvent("assistant:step:start", {
          taskId,
          sessionId,
          stepId: reAuditStep.stepId,
          action: reAuditStep.action,
          runId: reAuditRunId,
          bookId: reAuditStep.bookId,
          chapter: reAuditStep.chapter,
        });
        const reAuditResponse = await app.request(
          `http://localhost/api/books/${reAuditStep.bookId}/audit/${reAuditStep.chapter}`,
          { method: "POST" },
        );
        if (!reAuditResponse.ok) {
          const error = await parseApiErrorMessage(reAuditResponse);
          emitAssistantTaskEvent("assistant:step:fail", {
            taskId,
            sessionId,
            stepId: reAuditStep.stepId,
            action: reAuditStep.action,
            runId: reAuditRunId,
            bookId: reAuditStep.bookId,
            chapter: reAuditStep.chapter,
            error,
          });
          emitAssistantTaskEvent("assistant:done", { taskId, sessionId, status: "failed", error });
          return;
        }
        emitAssistantTaskEvent("assistant:step:success", {
          taskId,
          sessionId,
          stepId: reAuditStep.stepId,
          action: reAuditStep.action,
          runId: reAuditRunId,
          bookId: reAuditStep.bookId,
          chapter: reAuditStep.chapter,
        });
        emitAssistantTaskEvent("assistant:done", { taskId, sessionId, status: "succeeded" });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        emitAssistantTaskEvent("assistant:done", { taskId, sessionId, status: "failed", error });
      }
    })();

    return c.json({
      taskId,
      sessionId,
      status: "running",
      stepRunIds: {
        [auditStep.stepId]: auditRunId,
        [reviseStep.stepId]: reviseRunId,
        [reAuditStep.stepId]: reAuditRunId,
      },
      currentStepId: reviseStep.stepId,
    });
  });

  app.post("/api/assistant/evaluate", async (c) => {
    const rawBody = await c.req.json<unknown>().catch(() => null);
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({
        code: "ASSISTANT_EVALUATE_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const body = rawBody as Record<string, unknown>;
    const errors: Array<{ field: string; message: string }> = [];
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!taskId) {
      errors.push({ field: "taskId", message: "taskId must be a non-empty string" });
    }
    const parsedScope = parseAssistantEvaluateScope(body.scope);
    if (!parsedScope.ok) {
      errors.push(...parsedScope.errors);
    }
    const runIds = Array.isArray(body.runIds)
      ? body.runIds
        .map((runId) => typeof runId === "string" ? runId.trim() : "")
        .filter((runId) => runId.length > 0)
      : [];
    if (body.runIds !== undefined && (!Array.isArray(body.runIds) || runIds.length === 0)) {
      errors.push({ field: "runIds", message: "runIds must be an array with at least one non-empty string when provided" });
    }
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_EVALUATE_VALIDATION_FAILED", errors }, 422);
    }

    const scope = (parsedScope as { ok: true; value: AssistantEvaluateScope }).value;
    const listedRuns = await chapterRunStore.listRuns(
      scope.bookId,
      scope.type === "chapter" ? { chapter: scope.chapter, limit: 100 } : { limit: 100 },
    );
    const scopedRuns = runIds.length > 0
      ? listedRuns.filter((run) => runIds.includes(run.runId))
      : listedRuns;
    const report = deriveAssistantEvaluateReport(scopedRuns, scope);
    const suggestedNextActions = report.blockingIssues.length > 0 || report.overallScore < 75
      ? ["spot-fix", "re-audit"]
      : ["write-next"];
    return c.json({
      taskId,
      report,
      suggestedNextActions,
    });
  });

  app.post("/api/assistant/world/report", async (c) => {
    const parsed = parseAssistantWorldReportBody(await c.req.json<unknown>().catch(() => null));
    if (!parsed.ok) {
      return c.json({ code: "ASSISTANT_WORLD_REPORT_VALIDATION_FAILED", errors: parsed.errors }, 422);
    }
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const inspector = pipeline as unknown as {
        inspectWorldConsistencyAndMarket?: (bookId: string) => Promise<unknown>;
      };
      if (typeof inspector.inspectWorldConsistencyAndMarket !== "function") {
        return c.json({ error: "World report capability is unavailable in the current core runtime." }, 501);
      }
      const report = await inspector.inspectWorldConsistencyAndMarket(parsed.value.bookId);
      return c.json({
        bookId: parsed.value.bookId,
        report,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/assistant/optimize", async (c) => {
    const rawBody = await c.req.json<unknown>().catch(() => null);
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({
        code: "ASSISTANT_OPTIMIZE_VALIDATION_FAILED",
        errors: [{ field: "body", message: "Request body must be a JSON object" }],
      }, 422);
    }
    const body = rawBody as Record<string, unknown>;
    const errors: Array<{ field: string; message: string }> = [];
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!taskId) errors.push({ field: "taskId", message: "taskId must be a non-empty string" });
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) errors.push({ field: "sessionId", message: "sessionId must be a non-empty string" });
    const parsedScope = parseAssistantEvaluateScope(body.scope);
    if (!parsedScope.ok) {
      errors.push(...parsedScope.errors);
    }
    const rawTargetScore = typeof body.targetScore === "number" ? body.targetScore : Number.NaN;
    if (!Number.isFinite(rawTargetScore) || rawTargetScore < 0 || rawTargetScore > 100) {
      errors.push({ field: "targetScore", message: "targetScore must be a number between 0 and 100" });
    }
    const maxIterations = typeof body.maxIterations === "number" ? body.maxIterations : Number.NaN;
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 20) {
      errors.push({ field: "maxIterations", message: "maxIterations must be an integer between 1 and 20" });
    }
    const mode = typeof body.mode === "string" && body.mode.trim().length > 0 ? body.mode.trim() : "spot-fix";
    const brief = normalizeBriefValue(body.brief);
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_OPTIMIZE_VALIDATION_FAILED", errors }, 422);
    }

    const scope = (parsedScope as { ok: true; value: AssistantEvaluateScope }).value;
    if (scope.type !== "chapter") {
      return c.json({
        code: "ASSISTANT_OPTIMIZE_VALIDATION_FAILED",
        errors: [{ field: "scope.type", message: "scope.type must be 'chapter' for optimize" }],
      }, 422);
    }
    const targetScore = clampSerializableScore(rawTargetScore);
    const runIds: string[] = [];
    const iterations: AssistantOptimizeIteration[] = [];

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const stepId = `optimize-${iteration}`;
      emitAssistantTaskEvent("assistant:step:start", {
        taskId,
        sessionId,
        stepId,
        action: "optimize-iteration",
        iteration,
        maxIterations,
      });
      broadcast("assistant:optimize:iteration", {
        taskId,
        sessionId,
        stepId,
        iteration,
        maxIterations,
        status: "running",
        timestamp: new Date().toISOString(),
      });
      const reviseResponse = await app.request(
        `http://localhost/api/books/${scope.bookId}/revise/${scope.chapter}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, ...(brief !== undefined ? { brief } : {}) }),
        },
      );
      const revisePayload = await reviseResponse.json().catch(() => null) as Record<string, unknown> | null;
      const reviseRunId = typeof revisePayload?.["runId"] === "string" ? revisePayload["runId"] : null;
      if (!reviseResponse.ok || reviseRunId === null) {
        const reason = !reviseResponse.ok ? await parseApiErrorMessage(reviseResponse) : "revise step did not return runId";
        const retryContext = {
          scope,
          targetScore,
          maxIterations,
          nextIteration: iteration,
          completedIterations: iteration - 1,
          runIds,
        };
        iterations.push({ iteration, stepId, status: "failed", reason });
        emitAssistantTaskEvent("assistant:step:fail", {
          taskId,
          sessionId,
          stepId,
          action: "optimize-iteration",
          error: reason,
          retryContext,
        });
        emitAssistantTaskEvent("assistant:done", {
          taskId,
          sessionId,
          status: "failed",
          error: reason,
          stepId,
          retryContext,
        });
        broadcast("assistant:optimize:iteration", {
          taskId,
          sessionId,
          stepId,
          iteration,
          maxIterations,
          status: "failed",
          reason,
          timestamp: new Date().toISOString(),
        });
        return c.json({
          taskId,
          sessionId,
          status: "failed",
          terminationReason: "iteration-failed",
          iterations,
          retryContext,
        }, 500);
      }

      runIds.push(reviseRunId);
      const run = await waitForChapterRunCompletion(scope.bookId, reviseRunId);
      if (run.status !== "succeeded") {
        const reason = run.error?.trim() || "revise step failed";
        const retryContext = {
          scope,
          targetScore,
          maxIterations,
          nextIteration: iteration,
          completedIterations: iteration - 1,
          runIds,
          lastRunId: reviseRunId,
        };
        iterations.push({ iteration, stepId, runId: reviseRunId, status: "failed", reason });
        emitAssistantTaskEvent("assistant:step:fail", {
          taskId,
          sessionId,
          stepId,
          action: "optimize-iteration",
          runId: reviseRunId,
          error: reason,
          retryContext,
        });
        emitAssistantTaskEvent("assistant:done", {
          taskId,
          sessionId,
          status: "failed",
          error: reason,
          stepId,
          retryContext,
        });
        broadcast("assistant:optimize:iteration", {
          taskId,
          sessionId,
          stepId,
          iteration,
          maxIterations,
          runId: reviseRunId,
          status: "failed",
          reason,
          timestamp: new Date().toISOString(),
        });
        return c.json({
          taskId,
          sessionId,
          status: "failed",
          terminationReason: "iteration-failed",
          iterations,
          retryContext,
        }, 500);
      }

      const optimizeRuns = (
        await Promise.all(runIds.map(async (runId) => await chapterRunStore.getRun(scope.bookId, runId)))
      ).filter((item): item is ChapterRunRecord => item !== null);
      const report = deriveAssistantEvaluateReport(optimizeRuns, scope);
      const score = report.overallScore;
      const reachedTarget = score >= targetScore;
      const isLastIteration = iteration === maxIterations;
      const stopReason = reachedTarget ? "target-score-reached" : isLastIteration ? "max-iterations-reached" : undefined;
      iterations.push({
        iteration,
        stepId,
        runId: reviseRunId,
        score,
        status: "succeeded",
        ...(stopReason ? { reason: stopReason } : {}),
      });
      emitAssistantTaskEvent("assistant:step:success", {
        taskId,
        sessionId,
        stepId,
        action: "optimize-iteration",
        runId: reviseRunId,
      });
      broadcast("assistant:optimize:iteration", {
        taskId,
        sessionId,
        stepId,
        iteration,
        maxIterations,
        runId: reviseRunId,
        score,
        targetScore,
        status: "succeeded",
        ...(stopReason ? { reason: stopReason } : {}),
        timestamp: new Date().toISOString(),
      });
      if (reachedTarget) {
        emitAssistantTaskEvent("assistant:done", {
          taskId,
          sessionId,
          status: "succeeded",
          stepId,
        });
        return c.json({
          taskId,
          sessionId,
          status: "succeeded",
          terminationReason: "target-score-reached",
          finalScore: score,
          targetScore,
          maxIterations,
          iterations,
        });
      }
      if (isLastIteration) {
        const retryContext = {
          scope,
          targetScore,
          maxIterations,
          nextIteration: maxIterations + 1,
          completedIterations: maxIterations,
          runIds,
          lastScore: score,
        };
        emitAssistantTaskEvent("assistant:done", {
          taskId,
          sessionId,
          status: "succeeded",
          stepId,
          retryContext,
        });
        return c.json({
          taskId,
          sessionId,
          status: "needs_confirmation",
          terminationReason: "max-iterations-reached",
          finalScore: score,
          targetScore,
          maxIterations,
          iterations,
          nextAction: "manual-confirmation",
          retryContext,
        });
      }
    }

    return c.json({
      error: {
        code: "ASSISTANT_OPTIMIZE_TERMINATION_UNREACHABLE",
        message: "Optimize loop ended without a terminal state.",
      },
    }, 500);

  });

  app.get("/api/assistant/tasks", async (c) => {
    await assistantTaskSnapshotHydration;
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 20;
    const tasks = [...assistantTaskSnapshots.values()]
      .sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt))
      .slice(0, limit)
      .map((snapshot) => ({
        taskId: snapshot.taskId,
        sessionId: snapshot.sessionId,
        status: snapshot.status,
        ...(snapshot.currentStepId ? { currentStepId: snapshot.currentStepId } : {}),
        lastUpdatedAt: snapshot.lastUpdatedAt,
        ...(snapshot.error ? { error: snapshot.error } : {}),
      }));
    return c.json({ tasks });
  });

  app.get("/api/assistant/tasks/:taskId", async (c) => {
    await assistantTaskSnapshotHydration;
    const taskId = c.req.param("taskId");
    const snapshot = assistantTaskSnapshots.get(taskId);
    if (!snapshot) {
      return c.json({
        error: {
          code: "ASSISTANT_TASK_NOT_FOUND",
          message: "Assistant task was not found.",
        },
      }, 404);
    }
    return c.json(snapshot);
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
          const candidateRevision = (result as unknown as {
            candidateRevision?: { content: string; status?: string };
          }).candidateRevision;
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

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const tryPort = port + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const server = serve({ fetch: app.fetch, port: tryPort }, () => {
          console.log(`NovaScribe Studio running on http://localhost:${tryPort}`);
          resolve();
        });
        server.once("error", (err: NodeJS.ErrnoException) => {
          reject(err);
        });
      });
      return; // success
    } catch (err) {
      const isAddrInUse = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (isAddrInUse && attempt < maxRetries - 1) {
        console.warn(`Port ${tryPort} is in use, trying ${tryPort + 1}...`);
        continue;
      }
      throw err;
    }
  }
}
