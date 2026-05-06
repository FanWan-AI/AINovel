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
  ChapterBlueprintSchema,
  auditBlueprintFulfillment,
  TargetedBlueprintReviser,
  generateBlueprintEditorReport,
  type BlueprintEditorReport,
  type TargetedReviseOutput,
  type PipelineConfig,
  type ChapterBlueprint,
  type ProjectConfig,
  type RunPlan,
  type LogSink,
  type LogEntry,
  type LengthNormalizationSnapshot,
  type ChapterReviewSnapshot,
  type BlueprintFulfillmentReport,
} from "@actalk/inkos-core";
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
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
  ASSISTANT_AUTOPILOT_LEVEL_VALUES,
  DEFAULT_ASSISTANT_AUTOPILOT_LEVEL,
  evaluateAssistantPolicy,
  normalizeAssistantAutopilotLevel,
  normalizeAssistantStrategySettings,
  resolveAssistantAutopilotDecision,
  type AssistantAutopilotDecision,
  type AssistantAutopilotLevel,
  type AssistantPolicyBudgetInput,
  type AssistantPolicyPlanStep,
  type AssistantStrategySettings,
} from "./services/assistant-policy-service.js";
import {
  authorizeAssistantSkillPlan,
  listAssistantSkills,
} from "./services/assistant-skill-registry-service.js";
import {
  evaluateReleaseCandidate,
  scanReleaseGateSecuritySources,
  type ReleaseCandidateEvaluation,
  type ReleaseGateTextSource,
} from "./services/release-gate-service.js";
import {
  AssistantConductor,
  type AssistantConductorEvent,
  type CheckpointState,
  type TaskEdge,
  type TaskGraph,
  type TaskNode,
  type TaskNodeStatus,
  type TaskNodeType,
  type TaskRunState,
} from "./services/assistant-conductor.js";
import { BookCreateRunStore } from "./lib/run-store.js";
import { runtimeEventStore, deriveRuntimeEvent } from "./lib/runtime-event-store.js";
import {
  loadSteeringPrefs,
  saveSteeringPrefs,
  validateSteeringPrefsInput,
} from "./services/chapter-steering-service.js";
import { buildStoryGraph } from "./services/story-graph-service.js";
import {
  AssistantArtifactService,
  type AssistantArtifactType,
} from "./services/assistant-artifact-service.js";
import { routeAssistantIntent } from "./services/intent-router-service.js";
import {
  processWizardTurn,
  draftToConfirmRequest,
  detectConfirmation,
  type WizardTurnInput,
} from "./services/chat-to-book-wizard-service.js";
import type { BookCreationDraftPayload } from "./services/assistant-artifact-service.js";
import { resolveContext } from "./services/context-resolver-service.js";
import { generatePlotCritique } from "./services/plot-critique-service.js";
import { compileSteeringContract } from "./services/steering-contract-service.js";
import { verifyContractSatisfaction } from "./services/contract-verifier-service.js";
import { NarrativeGraphService } from "./services/narrative-graph-service.js";
import { compileGraphPatchesToSteering, enrichSteeringInputWithGraphPatches, type PatchRequirements } from "./services/graph-to-steering-compiler.js";
import { evaluateChapterDrama } from "./services/developmental-editor-service.js";

/** Per-patch consumption result included in the write-next:verification broadcast. */
interface GraphPatchConsumptionEntry {
  patchId: string;
  status: "consumed" | "pending" | "partially_consumed";
  reason: string;
  satisfiedRequirements: string[];
  missingRequirements: string[];
}

interface GraphPatchConsumption {
  patches: GraphPatchConsumptionEntry[];
  consumed: string[];
  pending: string[];
  partiallyConsumed: string[];
}

/** P5 auto-revision result included in write-next:verification when a blueprint re-write loop ran. */
interface P5AutoRevisionResult {
  editorReport?: BlueprintEditorReport;
  appliedFixes?: ReadonlyArray<string>;
  revisedBlueprintFulfillment?: BlueprintFulfillmentReport;
  /**
   * "candidate_pending_approval" — revised content saved as a chapter-run candidate awaiting user approval.
   * "still-failing" — revised content saved as a candidate but re-audit still shows blueprint/contract issues.
   * "failed" — LLM revision threw an error; no candidate was created.
   */
  status: "candidate_pending_approval" | "still-failing" | "failed";
  /** runId of the created chapter-run candidate (absent only when status is "failed"). */
  runId?: string;
  /** Error message when status is "failed". */
  error?: string;
  /** Result of re-running contract verification on the revised text (present when a steeringContract was active). */
  contractVerificationAfter?: {
    readonly satisfactionRate: number;
    readonly shouldRewrite: boolean;
    readonly missingRequirements: ReadonlyArray<string>;
  };
}
import type { NarrativeGraphOperation } from "./schemas/narrative-graph-schema.js";
import {
  ASSISTANT_MARKET_MEMORY_TTL_MS,
  createAssistantMemoryService,
  type AssistantMemoryLayer,
} from "./services/assistant-memory-service.js";
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
import { createPromptInjectionGuard } from "./middleware/prompt-injection-guard.js";
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

/**
 * Subscribe to the broadcast event bus and wait for the first event that
 * matches `matcher`. Returns whatever `matcher` produces (non-null means
 * match). The subscription is automatically cleaned up on match or timeout.
 */
function waitForBroadcastEvent<T>(
  matcher: (event: string, data: unknown) => T | null,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscribers.delete(handler);
      reject(new Error("Timed out waiting for broadcast event"));
    }, timeoutMs);
    const handler: EventHandler = (event, data) => {
      const result = matcher(event, data);
      if (result !== null) {
        clearTimeout(timer);
        subscribers.delete(handler);
        resolve(result);
      }
    };
    subscribers.add(handler);
  });
}

/**
 * Like waitForBroadcastEvent but returns a cancel function.
 * Call cancel() to clean up the subscription when the result is no longer needed.
 */
function waitForBroadcastEventCancellable<T>(
  matcher: (event: string, data: unknown) => T | null,
  timeoutMs: number,
): { promise: Promise<T>; cancel: () => void } {
  let handlerRef: EventHandler | null = null;
  let timerRef: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    timerRef = setTimeout(() => {
      if (handlerRef) subscribers.delete(handlerRef);
      reject(new Error("Timed out waiting for broadcast event"));
    }, timeoutMs);
    handlerRef = (event, data) => {
      const result = matcher(event, data);
      if (result !== null) {
        if (timerRef !== null) clearTimeout(timerRef);
        if (handlerRef) subscribers.delete(handlerRef);
        resolve(result);
      }
    };
    subscribers.add(handlerRef);
  });
  const cancel = () => {
    if (timerRef !== null) clearTimeout(timerRef);
    if (handlerRef) subscribers.delete(handlerRef);
  };
  return { promise, cancel };
}
const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();
// Runtime lifecycle actions emitted for human-readable run narration in Studio.
type RuntimeAction = "revise" | "rewrite" | "anti-detect" | "resync" | "plan" | "compose" | "write-next";
// Common lifecycle stages for runtime actions.
type RuntimeActionStage = "start" | "progress" | "success" | "fail" | "unchanged";
const NO_REVISIONS_APPLIED_MESSAGE = "No revisions were applied.";
const NO_TRUTH_ARTIFACT_UPDATES_MESSAGE = "No truth artifacts required updates.";
const ASSISTANT_EVALUATE_FAILED_RUN_FALLBACK_MESSAGE = "运行失败，需人工复核。";
const ASSISTANT_EVALUATE_UNCHANGED_RUN_FALLBACK_MESSAGE = "未应用修订，建议人工复核。";
const ASSISTANT_BOOK_EVALUATE_BATCH_SIZE = 12;
const ASSISTANT_BOOK_EVALUATE_SNIPPET_MAX_LENGTH = 220;
const ASSISTANT_HIGH_RISK_APPROVAL_REASON = "High-risk actions require manual approval before execution.";
const ASSISTANT_AUTOPILOT_BUDGET_PAUSED_CODE = "ASSISTANT_AUTOPILOT_BUDGET_PAUSED";
const ASSISTANT_AUTOPILOT_FAILURE_THRESHOLD_REACHED_CODE = "ASSISTANT_AUTOPILOT_FAILURE_THRESHOLD_REACHED";
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

interface AssistantStrategyValidationError {
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

interface AssistantCandidateScoreEvidence {
  readonly source: string;
  readonly excerpt: string;
  readonly reason: string;
}

interface AssistantTaskCandidateSnapshot {
  readonly candidateId: string;
  readonly runId: string;
  readonly score: number;
  readonly status: "succeeded" | "failed";
  readonly decision?: "applied" | "unchanged" | "failed" | null;
  readonly excerpt: string;
  readonly evidence: ReadonlyArray<AssistantCandidateScoreEvidence>;
  readonly pendingApproval: boolean;
  readonly error?: string;
  readonly candidateRevision?: ManualCandidateRevision;
}

interface AssistantCandidateDecisionSnapshot {
  readonly mode: "auto" | "manual";
  readonly status: "pending" | "selected";
  readonly candidates: ReadonlyArray<AssistantTaskCandidateSnapshot>;
  readonly winnerCandidateId?: string;
  readonly winnerRunId?: string;
  readonly winnerScore?: number;
  readonly winnerReason?: string;
}

interface AssistantTaskAwaitingApproval {
  readonly nodeId: string;
  readonly type: "checkpoint" | "candidate-selection";
  readonly candidates?: ReadonlyArray<AssistantTaskCandidateSnapshot>;
}

function clampChapterLengthTolerance(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(80, Math.max(10, Math.round(value)));
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

type AssistantStrategyInput = {
  autopilotLevel?: AssistantAutopilotLevel;
  autoFixThreshold?: number;
  maxAutoFixIterations?: number;
  budget?: {
    limit: number;
    currency: string;
  };
  approvalSkills?: string[];
  publishQualityGate?: number;
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

function validateAssistantStrategyInput(raw: unknown): { ok: true; value: AssistantStrategyInput } | { ok: false; errors: AssistantStrategyValidationError[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: "body", message: "Request body must be a JSON object." }] };
  }
  const body = raw as Record<string, unknown>;
  const errors: AssistantStrategyValidationError[] = [];
  const result: AssistantStrategyInput = {};
  const knownSkillIds = new Set(listAssistantSkills().map((skill) => skill.skillId));

  if (body.autopilotLevel !== undefined) {
    if (!ASSISTANT_AUTOPILOT_LEVEL_VALUES.includes(body.autopilotLevel as AssistantStrategySettings["autopilotLevel"])) {
      errors.push({
        field: "autopilotLevel",
        message: `autopilotLevel must be one of ${ASSISTANT_AUTOPILOT_LEVEL_VALUES.join(", ")}.`,
      });
    } else {
      result.autopilotLevel = body.autopilotLevel as AssistantStrategySettings["autopilotLevel"];
    }
  }

  if (body.autoFixThreshold !== undefined) {
    if (typeof body.autoFixThreshold !== "number" || !Number.isFinite(body.autoFixThreshold) || body.autoFixThreshold < 0 || body.autoFixThreshold > 100) {
      errors.push({ field: "autoFixThreshold", message: "autoFixThreshold must be a number between 0 and 100." });
    } else {
      result.autoFixThreshold = body.autoFixThreshold;
    }
  }

  if (body.maxAutoFixIterations !== undefined) {
    const maxAutoFixIterations = body.maxAutoFixIterations;
    if (typeof maxAutoFixIterations !== "number" || !Number.isInteger(maxAutoFixIterations) || maxAutoFixIterations < 1 || maxAutoFixIterations > 20) {
      errors.push({ field: "maxAutoFixIterations", message: "maxAutoFixIterations must be an integer between 1 and 20." });
    } else {
      result.maxAutoFixIterations = maxAutoFixIterations;
    }
  }

  if (body.budget !== undefined) {
    if (typeof body.budget !== "object" || body.budget === null || Array.isArray(body.budget)) {
      errors.push({ field: "budget", message: "budget must be an object." });
    } else {
      const budget = body.budget as Record<string, unknown>;
      const limit = budget.limit;
      const currency = typeof budget.currency === "string" ? budget.currency.trim() : "";
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
        errors.push({ field: "budget.limit", message: "budget.limit must be a number greater than or equal to 0." });
      }
      if (!currency) {
        errors.push({ field: "budget.currency", message: "budget.currency must be a non-empty string." });
      }
      if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0 && currency) {
        result.budget = { limit, currency };
      }
    }
  }

  if (body.approvalSkills !== undefined) {
    if (!Array.isArray(body.approvalSkills)) {
      errors.push({ field: "approvalSkills", message: "approvalSkills must be an array of skill ids." });
    } else {
      const approvalSkills: string[] = [];
      body.approvalSkills.forEach((value, index) => {
        const skillId = typeof value === "string" ? value.trim() : "";
        if (!skillId) {
          errors.push({ field: `approvalSkills[${index}]`, message: "approval skill must be a non-empty string." });
          return;
        }
        if (!knownSkillIds.has(skillId)) {
          errors.push({ field: `approvalSkills[${index}]`, message: `unknown approval skill: ${skillId}.` });
          return;
        }
        approvalSkills.push(skillId);
      });
      result.approvalSkills = [...new Set(approvalSkills)];
    }
  }

  if (body.publishQualityGate !== undefined) {
    if (typeof body.publishQualityGate !== "number" || !Number.isFinite(body.publishQualityGate) || body.publishQualityGate < 0 || body.publishQualityGate > 100) {
      errors.push({ field: "publishQualityGate", message: "publishQualityGate must be a number between 0 and 100." });
    } else {
      result.publishQualityGate = body.publishQualityGate;
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

type AssistantPlanIntent = "audit" | "audit_and_optimize" | "write_next" | "generate_structure" | "goal_to_book";
type AssistantPlanRiskLevel = "low" | "medium" | "high";
type AssistantPlanScope = DaemonPlanBookScope;
type AssistantPlanIntentType = "goal-to-book";

interface AssistantPlanStep {
  readonly stepId: string;
  readonly action: string;
  readonly bookId?: string;
  readonly bookIds?: ReadonlyArray<string>;
  readonly chapter?: number;
  readonly mode?: string;
  readonly parallelCandidates?: number;
  readonly planInput?: string;
  readonly brief?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly maxRetries?: number;
}

interface AssistantExecuteStepRef {
  readonly stepId: string;
  readonly action: "audit" | "revise" | "re-audit";
  readonly bookId: string;
  readonly chapter: number;
  readonly mode?: string;
  readonly parallelCandidates?: number;
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

interface AssistantTaskNodeSnapshot {
  readonly nodeId: string;
  readonly type: TaskNodeType;
  readonly action?: string;
  readonly runId?: string;
  readonly status: TaskNodeStatus;
  readonly parallelCandidates?: number;
  readonly planInput?: string;
  readonly brief?: string;
  readonly steeringContract?: Record<string, unknown>;
  readonly blueprint?: Record<string, unknown>;
  readonly sourceArtifactIds?: ReadonlyArray<string>;
  readonly attempts: number;
  readonly maxRetries: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly checkpoint?: CheckpointState;
  readonly candidateDecision?: AssistantCandidateDecisionSnapshot;
}

interface AssistantTaskSnapshot {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly currentStepId?: string;
  readonly steps: Record<string, AssistantTaskStepSnapshot>;
  readonly nodes?: Record<string, AssistantTaskNodeSnapshot>;
  readonly graph?: TaskGraph;
  readonly lastUpdatedAt: string;
  readonly error?: string;
  readonly retryContext?: Record<string, unknown>;
  readonly awaitingApproval?: AssistantTaskAwaitingApproval;
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

function parseAssistantTaskNodeStatus(input: unknown): TaskNodeStatus | null {
  if (input === "pending" || input === "running" || input === "waiting_approval" || input === "succeeded" || input === "failed") {
    return input;
  }
  return null;
}

function parseAssistantTaskNodeType(input: unknown): TaskNodeType | null {
  if (input === "task" || input === "checkpoint") {
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

function normalizeAssistantTaskNodeSnapshot(input: unknown, fallbackNodeId?: string): AssistantTaskNodeSnapshot | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : fallbackNodeId;
  const type = parseAssistantTaskNodeType(payload.type);
  const status = parseAssistantTaskNodeStatus(payload.status);
  const attempts = typeof payload.attempts === "number" && Number.isFinite(payload.attempts) ? payload.attempts : Number.NaN;
  const maxRetries = typeof payload.maxRetries === "number" && Number.isFinite(payload.maxRetries) ? payload.maxRetries : Number.NaN;
  const parallelCandidates = typeof payload.parallelCandidates === "number" && Number.isFinite(payload.parallelCandidates)
    ? Math.max(1, Math.min(3, Math.trunc(payload.parallelCandidates)))
    : undefined;
  if (!nodeId || !type || !status || !Number.isFinite(attempts) || !Number.isFinite(maxRetries)) {
    return null;
  }
  const checkpoint = typeof payload.checkpoint === "object" && payload.checkpoint !== null && !Array.isArray(payload.checkpoint)
    ? payload.checkpoint as CheckpointState
    : undefined;
  const steeringContract = typeof payload.steeringContract === "object" && payload.steeringContract !== null && !Array.isArray(payload.steeringContract)
    ? payload.steeringContract as Record<string, unknown>
    : undefined;
  const blueprint = typeof payload.blueprint === "object" && payload.blueprint !== null && !Array.isArray(payload.blueprint)
    ? payload.blueprint as Record<string, unknown>
    : undefined;
  const sourceArtifactIds = Array.isArray(payload.sourceArtifactIds)
    ? (payload.sourceArtifactIds as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    nodeId,
    type,
    status,
    attempts,
    maxRetries,
    ...(parallelCandidates !== undefined ? { parallelCandidates } : {}),
    ...(typeof payload.action === "string" ? { action: payload.action } : {}),
    ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
    ...(steeringContract ? { steeringContract } : {}),
    ...(blueprint ? { blueprint } : {}),
    ...(sourceArtifactIds && sourceArtifactIds.length > 0 ? { sourceArtifactIds } : {}),
    ...(typeof payload.startedAt === "string" ? { startedAt: payload.startedAt } : {}),
    ...(typeof payload.finishedAt === "string" ? { finishedAt: payload.finishedAt } : {}),
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  };
}

function normalizeAssistantTaskNode(input: unknown, fallbackNodeId?: string): TaskNode | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : fallbackNodeId;
  const type = parseAssistantTaskNodeType(payload.type);
  const action = typeof payload.action === "string" ? payload.action : "";
  if (!nodeId || !type || !action) {
    return null;
  }
  const dependsOn = Array.isArray(payload.dependsOn)
    ? payload.dependsOn.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const bookIds = Array.isArray(payload.bookIds)
    ? payload.bookIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const maxRetries = typeof payload.maxRetries === "number" && Number.isFinite(payload.maxRetries)
    ? Math.max(payload.maxRetries, 0)
    : undefined;
  const parallelCandidates = typeof payload.parallelCandidates === "number" && Number.isFinite(payload.parallelCandidates)
    ? Math.max(1, Math.min(3, Math.trunc(payload.parallelCandidates)))
    : undefined;
  const checkpoint = typeof payload.checkpoint === "object" && payload.checkpoint !== null && !Array.isArray(payload.checkpoint)
    ? payload.checkpoint as CheckpointState
    : undefined;
  const steeringContract = typeof payload.steeringContract === "object" && payload.steeringContract !== null && !Array.isArray(payload.steeringContract)
    ? payload.steeringContract as Record<string, unknown>
    : undefined;
  const blueprint = typeof payload.blueprint === "object" && payload.blueprint !== null && !Array.isArray(payload.blueprint)
    ? payload.blueprint as Record<string, unknown>
    : undefined;
  const sourceArtifactIds = Array.isArray(payload.sourceArtifactIds)
    ? (payload.sourceArtifactIds as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    nodeId,
    type,
    action,
    ...(typeof payload.bookId === "string" ? { bookId: payload.bookId } : {}),
    ...(bookIds.length > 0 ? { bookIds } : {}),
    ...(typeof payload.chapter === "number" && Number.isInteger(payload.chapter) && payload.chapter > 0 ? { chapter: payload.chapter } : {}),
    ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}),
    ...(parallelCandidates !== undefined ? { parallelCandidates } : {}),
    ...(typeof payload.planInput === "string" && payload.planInput.trim().length > 0 ? { planInput: payload.planInput.trim() } : {}),
    ...(typeof payload.brief === "string" && payload.brief.trim().length > 0 ? { brief: payload.brief.trim() } : {}),
    ...(steeringContract ? { steeringContract } : {}),
    ...(blueprint ? { blueprint } : {}),
    ...(sourceArtifactIds && sourceArtifactIds.length > 0 ? { sourceArtifactIds } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  };
}

function normalizeAssistantTaskEdge(input: unknown): TaskEdge | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const from = typeof payload.from === "string" ? payload.from : "";
  const to = typeof payload.to === "string" ? payload.to : "";
  if (!from || !to) {
    return null;
  }
  return { from, to };
}

function normalizeAssistantTaskGraph(input: unknown, fallbackTaskId?: string): TaskGraph | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const taskId = typeof payload.taskId === "string" ? payload.taskId : fallbackTaskId;
  if (!taskId || !Array.isArray(payload.nodes)) {
    return null;
  }
  const nodes = payload.nodes
    .map((entry) => normalizeAssistantTaskNode(entry))
    .filter((entry): entry is TaskNode => entry !== null);
  if (nodes.length === 0) {
    return null;
  }
  const edges = Array.isArray(payload.edges)
    ? payload.edges.map((edge) => normalizeAssistantTaskEdge(edge)).filter((edge): edge is TaskEdge => edge !== null)
    : [];
  return {
    taskId,
    nodes,
    edges,
    ...(typeof payload.intent === "string" ? { intent: payload.intent } : {}),
    ...(typeof payload.intentType === "string" ? { intentType: payload.intentType } : {}),
    ...(typeof payload.riskLevel === "string" ? { riskLevel: payload.riskLevel } : {}),
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
  const rawNodes = typeof payload.nodes === "object" && payload.nodes !== null && !Array.isArray(payload.nodes) ? payload.nodes : {};
  const nodes = Object.entries(rawNodes).reduce<Record<string, AssistantTaskNodeSnapshot>>((acc, [nodeId, value]) => {
    const normalized = normalizeAssistantTaskNodeSnapshot(value, nodeId);
    if (normalized) {
      acc[normalized.nodeId] = normalized;
    }
    return acc;
  }, {});
  const retryContext = typeof payload.retryContext === "object" && payload.retryContext !== null && !Array.isArray(payload.retryContext)
    ? payload.retryContext as Record<string, unknown>
    : undefined;
  const awaitingApproval = typeof payload.awaitingApproval === "object" && payload.awaitingApproval !== null && !Array.isArray(payload.awaitingApproval)
    ? payload.awaitingApproval as AssistantTaskAwaitingApproval
    : undefined;
  const graph = normalizeAssistantTaskGraph(payload.graph, taskId);
  return {
    taskId,
    sessionId,
    status,
    ...(typeof payload.currentStepId === "string" ? { currentStepId: payload.currentStepId } : {}),
    steps,
    ...(Object.keys(nodes).length > 0 ? { nodes } : {}),
    ...(graph ? { graph } : {}),
    lastUpdatedAt,
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    ...(retryContext ? { retryContext } : {}),
    ...(awaitingApproval ? { awaitingApproval } : {}),
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

type AssistantEvaluateDimensionKey =
  | "continuity"
  | "readability"
  | "styleConsistency"
  | "aiTraceRisk"
  | "mainline"
  | "character"
  | "foreshadowing"
  | "repetition"
  | "style"
  | "pacing";

type AssistantEvaluateDimensions = Partial<Record<AssistantEvaluateDimensionKey, number>>;

interface AssistantEvaluateReport {
  readonly scopeType: "chapter" | "book";
  readonly overallScore: number;
  readonly dimensions: AssistantEvaluateDimensions;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<AssistantEvaluateEvidence>;
  readonly cached?: boolean;
}

interface AssistantOptimizeIteration {
  readonly iteration: number;
  readonly stepId: string;
  readonly runId?: string;
  readonly score?: number;
  readonly status: "running" | "succeeded" | "failed";
  readonly reason?: string;
}

interface AssistantMetricsPoint {
  readonly date: string;
  readonly firstSuccessRate: number;
  readonly autoFixSuccessRate: number;
  readonly manualInterventionRate: number;
  readonly averageChapterScore: number;
  readonly tokenConsumption: number;
  readonly activeTasks: number;
}

interface AssistantMetricsSummary {
  readonly firstSuccessRate: number;
  readonly autoFixSuccessRate: number;
  readonly manualInterventionRate: number;
  readonly averageChapterScore: number;
  readonly tokenConsumption: number;
  readonly activeTasks: number;
}

interface AssistantMetricsMeta {
  readonly generatedAt: string;
  readonly rangeDays: 7 | 30;
  readonly taskSnapshotLimit: number;
  readonly runLimitPerBook: number;
  readonly totalRunLimit: number;
  readonly booksScanned: number;
  readonly tasksConsidered: number;
  readonly runsConsidered: number;
  readonly truncated: boolean;
}

interface AssistantMetricsResponse {
  readonly series: ReadonlyArray<AssistantMetricsPoint>;
  readonly summary: AssistantMetricsSummary;
  readonly meta: AssistantMetricsMeta;
}

const ASSISTANT_AUDIT_PATTERN = /审计|审核|审一下|审下|审一审|检查|audit|review/iu;
const ASSISTANT_OPTIMIZE_PATTERN = /修复|优化|optimi[sz]e|fix|改写/iu;
const ASSISTANT_WRITE_NEXT_PATTERN = /写下一章|下一章(?!.{0,20}(?:写什么|写啥|写哪)).*写|继续写|续写|写.*下一章|落实下一章|按.{0,15}(?:设计|方案|规划).{0,10}(?:写|生成|落实|执行)|write[-\s]?next|continue\s*writing/iu;
const ASSISTANT_DRAFT_PATTERN = /write[\s_-]?draft|写.*草稿|草稿|执行.*write/iu;
const ASSISTANT_GENERATE_STRUCTURE_PATTERN = /生成.*结构|初始化.*大纲|蓝图|generate.*structure|create.*outline/iu;
const ASSISTANT_RELEASE_CANDIDATE_PATTERN = /发布候选|release\s*candidate|可发布|候选确认/iu;
const ASSISTANT_GOAL_TO_BOOK_PATTERN = /(一句话目标|goal[-\s]?to[-\s]?book|目标.*(成书|小说|长篇)|扩展成.*章|写成.*书)/iu;
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
const ASSISTANT_CHAPTER_ZH_PATTERN = /(?:第\s*)?(\d+)\s*章/u;
const ASSISTANT_CHAPTER_EN_PATTERN = /chapter\s*(\d+)/iu;
const ASSISTANT_MODEL_IDENTITY_PATTERN = /(你是.*模型|什么模型|哪个模型|model|provider|llm|deep\s*seek|deepseek|mimo|openai|anthropic)/iu;
const ASSISTANT_VAGUE_PROMPT_PATTERN = /^[\s?？!！,，.。]+$/u;
const ASSISTANT_REVISE_INTENT_PATTERN = /改一下|改成|修改|调整|修一下|润色|重写|修订|深度改写|大幅改写|rewrite|revise|spot-fix|polish|rework|anti-detect|chapter-redesign/iu;
// Matches opinion/evaluation/discussion questions — these must NOT trigger deterministic
// tool dispatch even when the body happens to contain a revise-intent keyword.
const ASSISTANT_OPINION_QUESTION_PATTERN = /你觉得|觉不觉得|这么.{0,15}好吗|这样.{0,15}好吗|好不好|怎么样|这么设计|这样设计|这个设计|评价一下|看法如何|你看这/iu;
const ASSISTANT_REVISION_PLANNING_PATTERN = /(?:重写|改写|修订|修改|rework|rewrite|revise).{0,8}(?:方案|设计|思路|计划|规划)|(?:想想|设计|规划|评估|分析).{0,20}(?:如何|怎么|怎样).{0,20}(?:挽回|修|改|重写|改写)|如何.{0,20}(?:挽回|修复|重写|改写).{0,20}(?:颓势|问题|质量)/iu;
// Chat-to-Book: matches "我想写一本书"/"帮我策划一本小说"/"开一个新坑" etc.
const ASSISTANT_CHAT_TO_BOOK_PATTERN =
  /(?:想|要|帮我|来)(?:写|创作|策划|出|做).{0,8}(?:一本|本|部).{0,6}(?:书|小说|网文|故事)|(?:新书|新小说|新作品).{0,10}(?:策划|设计|创建|开始|写)|(?:策划|设计|创作|写).{0,6}(?:男频|女频|玄幻|都市|修仙|系统|爽文|悬疑).{0,10}(?:书|小说|故事)|开.{0,4}(?:一本|本|部).{0,6}(?:新书|新坑)/iu;
const ASSISTANT_REVISE_MODE_ANTI_DETECT_PATTERN = /反检测|anti[-\s]?detect/iu;
const ASSISTANT_REVISE_MODE_POLISH_PATTERN = /润色|文风|措辞|polish/iu;
const ASSISTANT_REVISE_MODE_CHAPTER_REDESIGN_PATTERN = /深度改写|大幅改写|chapter[-\s]?redesign|换剧情|换场景|改剧情线|重构本章|发生关系|亲密关系|上床|做爱|性爱/iu;
const ASSISTANT_REVISE_MODE_REWRITE_PATTERN = /rewrite|改写/iu;
const ASSISTANT_REVISE_MODE_REWORK_PATTERN = /重写|重作|改成|剧情|情节|整体改|彻底改|必须改/iu;
// Matches requests that target truth files or book metadata — these must NOT trigger the
// deterministic revise_chapter lane even when "重写"/"修改" appears in the request.
const ASSISTANT_TRUTH_FILE_EDIT_PATTERN =
  /story_bible|volume_outline|book_rules|chapter_summaries|current_state|pending_hooks|particle_ledger|subplot_board|emotional_arcs|character_matrix|style_guide|author_intent|current_focus|书名|改书名|书的名(?:字|称)|真相文件|设定文件|卷纲|卷章大纲|总章数|目标章数|章节总数|全书章节|调整.{0,8}章数|压缩到.{0,6}章/iu;
const ASSISTANT_METRICS_DAY_RANGE_VALUES = [7, 30] as const;
const ASSISTANT_METRICS_DEFAULT_DAY_RANGE = 7;
const ASSISTANT_METRICS_TASK_SNAPSHOT_LIMIT = 400;
const ASSISTANT_METRICS_BOOK_LIMIT = 40;
const ASSISTANT_METRICS_RUN_LIMIT_PER_BOOK = 120;
const ASSISTANT_METRICS_TOTAL_RUN_LIMIT = 1200;

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

function buildPlotCritiqueResponse(
  critique: { strengths: ReadonlyArray<string>; weaknesses: ReadonlyArray<string>; nextChapterOpportunities: ReadonlyArray<{ title: string; why: string }> },
  bookTitle: string,
  artifactId: string,
): { text: string } {
  const lines: string[] = ["# 📊 《" + bookTitle + "》剧情诊断报告\n"];
  if (critique.strengths.length > 0 && !(critique.strengths.length === 1 && critique.strengths[0].includes("暂无"))) {
    lines.push("## ✅ 优势");
    for (const s of critique.strengths) lines.push("- " + s);
    lines.push("");
  }
  if (critique.weaknesses.length > 0 && !(critique.weaknesses.length === 1 && critique.weaknesses[0].includes("暂无"))) {
    lines.push("## ❌ 问题");
    for (const w of critique.weaknesses) lines.push("- " + w);
    lines.push("");
  }
  if (critique.nextChapterOpportunities.length > 0) {
    lines.push("## 🎯 下一章机会");
    for (const [i, opp] of critique.nextChapterOpportunities.entries()) {
      lines.push((i + 1) + ". **" + opp.title + "** — " + opp.why);
    }
    lines.push("");
  }
  lines.push("\n---\n\n📄 已保存为 artifact（" + artifactId.slice(0, 12) + "…），你可以接着说「按照你刚才说的优缺点规划下一章」来生成契约。");
  return { text: lines.join("\n") };
}

function buildBlueprintFromContract(
  contract: { goal?: string; mustInclude: ReadonlyArray<string>; mustAvoid: ReadonlyArray<string>; sceneBeats: ReadonlyArray<string>; payoffRequired?: string; endingHook?: string },
  _bookId: string,
): { openingHook: string; scenes: Array<{ beat: string; conflict: string; informationGap: string; turn: string; payoff: string; cost: string }>; payoffRequired: string; endingHook: string; contractSatisfaction: string[] } {
  const isEn = false;
  const mustIncludeItems = contract.mustInclude;
  const sceneSeeds = contract.sceneBeats.length >= 5
    ? contract.sceneBeats.slice(0, 6)
    : [
        ...(contract.sceneBeats.length > 0 ? contract.sceneBeats : []),
        `用一个具体压力点开场，直接指向：${contract.goal ?? "本章目标"}`,
        mustIncludeItems.length > 0
          ? `主角必须直面：${mustIncludeItems[0]}，不能回避或绕路`
          : "让主角在信息不完整时做出主动选择。",
        mustIncludeItems.length > 1
          ? `推进至：${mustIncludeItems.slice(1).join("、")}，对手或盟友制造直接阻力`
          : "让有能力的对手或盟友制造阻力，体现其独立诉求。",
        "章内必须落下一个可见爽点、反转或代价。",
        "章尾用兑现后的自然新问题制造悬念，不能只靠氛围句收尾。",
      ].slice(0, 6);
  const payoff = contract.payoffRequired ?? "给读者一个具体可感的变化：筹码、信息、关系或资源必须至少改变一项。";
  const endingHook = contract.endingHook ?? "章尾钩子必须由本章兑现后的新问题自然产生，不能只靠氛围句收尾。";
  return {
    openingHook: contract.goal ?? "本章目标",
    scenes: sceneSeeds.map((beat, i) => ({
      beat,
      conflict: i < mustIncludeItems.length
        ? `围绕"${mustIncludeItems[i]}"直接交锋，不能模糊带过`
        : `第${i + 1}个场景必须有直接阻力，不能只用总结推进。`,
      informationGap: contract.goal ?? beat,
      turn: "该节拍结束时，局势必须发生可见变化。",
      payoff,
      cost: "收益必须伴随代价、暴露、欠债或新风险。",
    })),
    payoffRequired: payoff,
    endingHook,
    contractSatisfaction: [
      ...(contract.goal ? [`目标：${contract.goal}`] : []),
      ...contract.mustInclude.map((item) => `必须包含：${item}`),
      ...contract.mustAvoid.map((item) => `必须避免：${item}`),
    ],
  };
}

const ASSISTANT_CHAPTER_PLAN_RESPONSE_RE = /(?:下一章节?|第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*章节?).{0,20}(?:设计方案|方案|怎么写|规划|章段|核心爽点|设计|全新设计)/u;
const ASSISTANT_PLAN_REFERENCE_RE = /(?:按|按照|照|就按|采用|执行).{0,10}(?:你|刚才|上面|这个|那个|路径\s*[A-DＡ-Ｄ])?.{0,10}(?:设计方案|方案|规划|思路|设计|路径\s*[A-DＡ-Ｄ]).{0,12}(?:写|执行|生成|下一章|章节|落实)?/u;
const ASSISTANT_PLAN_ACCEPTANCE_RE = /(?:喜欢|认可|确认|同意|可以|就这样|没问题|按这个|按你的|按你这个|按照这个|按照你的).{0,30}(?:设计|方案|规划|思路|下一章|章节).{0,30}(?:写|去写|开始|执行|生成|下一章|章节)/u;

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function shouldPersistChapterPlanArtifact(userText: string, responseText: string): boolean {
  const combined = `${userText}\n${responseText}`;
  if (!ASSISTANT_CHAPTER_PLAN_RESPONSE_RE.test(combined)) return false;
  return /(?:第一|第二|第三|第四|第五|第六|开篇|章末|场景|爽点|系统|钩子|冲突|反转|payoff|hook)/u.test(responseText);
}

function normalizeChapterPlanLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}|[-*]|\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/u, "")
    .replace(/\*\*/g, "")
    .trim();
}

function isChapterPlanNoiseLine(line: string): boolean {
  if (line.length < 4) return true;
  if (/^(?:好的|好，|老板|我理解|我明白|你要的是|核心升级点|核心背景|时间\/地点\/状态|时间|地点|状态|设计思路|剧情框架|爽点类型|具体设计|本章结论|维度|章节类型|外部冲突|内部张力|身体细节|魅惑语言|下一章入口)$/u.test(line)) return true;
  if (/^(?:---+|\|?\s*:?-{2,}:?\s*\|)/u.test(line)) return true;
  if (/^\|.*\|$/u.test(line)) return true;
  if (/^(?:如果|要不要|你觉得|确认后|满意的话|随时说|我直接|需要我)/u.test(line)) return true;
  return false;
}

function isLowInformationRepeatedPlanLine(line: string): boolean {
  const compact = line.replace(/\s+/gu, "");
  if (compact.length < 80) return false;
  const sentenceMatch = compact.match(/^(.{6,80}?[。！？.!?])(?:\1){2,}/u);
  if (sentenceMatch) return true;
  for (let length = 6; length <= 40; length += 1) {
    const unit = compact.slice(0, length);
    if (unit.length < length) break;
    const repeated = unit.repeat(Math.floor(compact.length / unit.length));
    if (compact.startsWith(repeated.slice(0, Math.min(compact.length, unit.length * 4)))) {
      return true;
    }
  }
  return false;
}

function isChapterPlanSceneHeading(line: string): boolean {
  return /^(?:第[一二三四五六七八九十]+(?:段|章段|阶段|幕)|场景[一二三四五六七八九十\d]+|开篇|章末|结尾|高潮|反转|钩子|第一轮|第二轮|第三轮|第四轮|第五轮|第六轮)/u.test(line);
}

function trimChapterPlanBeat(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function extractChapterPlanSceneBeats(text: string): string[] {
  const rawLines = text
    .split(/\r?\n/)
    .map(normalizeChapterPlanLine)
    .filter((line) => line.length > 0 && !isChapterPlanNoiseLine(line));

  const beats: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!;
    const isHeading = isChapterPlanSceneHeading(line)
      || /(?:场景|章段|冲突|反转|交锋|升级|兑现|危机|回收|钩子)/u.test(line);
    if (!isHeading) continue;

    const detailLines: string[] = [];
    for (let j = i + 1; j < rawLines.length && detailLines.length < 6; j += 1) {
      const next = rawLines[j]!;
      if (isChapterPlanSceneHeading(next)) break;
      if (isChapterPlanNoiseLine(next)) continue;
      if (isLowInformationRepeatedPlanLine(next)) continue;
      if (/^(?:🔥|⭐|✅|⚠️|🎯|📊|💡|核心|说明|男频爽点|视觉爽点)/u.test(next)) continue;
      detailLines.push(next);
    }

    const beat = detailLines.length > 0
      ? `${line}：${detailLines.join("；")}`
      : line;
    beats.push(trimChapterPlanBeat(beat));
  }

  if (beats.length === 0) {
    for (const line of rawLines) {
      if (isLowInformationRepeatedPlanLine(line)) continue;
      if (/(?:必须|规矩|轮流|同时|全裸|赴约|主角|女主|系统|钩子|冲突|反转|交锋|升级|兑现|危机|回收)/u.test(line)) {
        beats.push(trimChapterPlanBeat(line));
      }
    }
  }

  return uniqueStrings(beats).slice(0, 12);
}

function extractChapterPlanGoal(text: string): string | undefined {
  const titleMatch = text.match(/第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*章节?.{0,20}(?:《([^》]{2,40})》|方案[:：]\s*([^\n]{2,80}))/u);
  const title = titleMatch?.[1] ?? titleMatch?.[2];
  if (title) return title.trim();
  const firstBeat = extractChapterPlanSceneBeats(text)[0];
  return firstBeat ? firstBeat.slice(0, 80) : undefined;
}

function compactAssistantRecentMessageForAgentContext(
  message: { role: "user" | "assistant"; content: string },
  options: { preserveDetail?: boolean } = {},
): string {
  const roleLabel = message.role === "user" ? "用户" : "助手";
  const content = message.content.trim();
  if (content.length === 0) return `${roleLabel}：（空）`;

  if (options.preserveDetail) {
    return `${roleLabel}：${content}`;
  }

  if (message.role === "assistant" && shouldPersistChapterPlanArtifact("", content)) {
    const goal = extractChapterPlanGoal(content);
    const sceneBeats = extractChapterPlanSceneBeats(content).slice(0, 5);
    const lines = [
      `${roleLabel}：上一轮章节方案摘要${goal ? `：${goal}` : ""}`,
      ...sceneBeats.map((beat) => `- ${beat}`),
    ];
    return lines.join("\n").slice(0, 1_000);
  }

  const compact = content.replace(/\s{3,}/g, " ").slice(0, 900);
  return `${roleLabel}：${compact}${content.length > 900 ? "…" : ""}`;
}

function normalizeForRepeatedResponseCompare(value: string): string {
  return value.replace(/\s+/g, "").replace(/[，。！？、：:；;'"“”‘’`*#\-—·（）()[\]{}<>《》「」]/g, "");
}

function dedupeRepeatedAssistantResponse(responseText: string): string {
  const text = responseText.trim();
  if (text.length < 100) return text;

  const headingMatches = [...text.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?(第\s*(\d+)\s*章.{0,50}(?:设计方案|方案)[^\n]*)/gu)];
  const seenHeadings = new Map<string, number>();
  const seenChapterPlanNumbers = new Map<string, number>();
  for (const match of headingMatches) {
    const heading = normalizeForRepeatedResponseCompare(match[1] ?? "");
    const chapterNumber = match[2];
    const start = match.index ?? 0;
    if (chapterNumber) {
      const firstChapterPlanStart = seenChapterPlanNumbers.get(chapterNumber);
      if (firstChapterPlanStart !== undefined && start - firstChapterPlanStart > 50) {
        return text.slice(0, start).trim();
      }
      seenChapterPlanNumbers.set(chapterNumber, start);
    }
    if (heading.length < 6) continue;
    const firstStart = seenHeadings.get(heading);
    if (firstStart !== undefined && start - firstStart > 50) {
      return text.slice(0, start).trim();
    }
    seenHeadings.set(heading, start);
  }

  const midpoint = Math.floor(text.length / 2);
  const maxOffset = Math.min(500, Math.floor(text.length * 0.08));
  for (let offset = -maxOffset; offset <= maxOffset; offset += 20) {
    const splitAt = midpoint + offset;
    if (splitAt < 500 || splitAt >= text.length - 500) continue;
    const left = text.slice(0, splitAt).trim();
    const right = text.slice(splitAt).trim();
    if (normalizeForRepeatedResponseCompare(left) === normalizeForRepeatedResponseCompare(right)) {
      return left;
    }
  }

  return text;
}

function isMetaWritingQualityRequirement(value: string): boolean {
  return /(?:观众|读者|写得|写不好|细节|动作|神态|描写|文笔|质量|爽|撩|逼真|漏骨|沦陷|毁灭)/u.test(value);
}

function isExplicitChapterPlanAcceptance(input: string): boolean {
  return ASSISTANT_PLAN_ACCEPTANCE_RE.test(input) || (
    ASSISTANT_PLAN_REFERENCE_RE.test(input)
    && /(?:喜欢|认可|确认|同意|可以|就这样|没问题|去写|写下一章|开始写|执行)/u.test(input)
  );
}

function buildSteeringResponseText(
  contract: { mustInclude: ReadonlyArray<string>; mustAvoid: ReadonlyArray<string>; priority: string; sourceArtifactIds: ReadonlyArray<string> },
  blueprint: { scenes: ReadonlyArray<unknown> },
  resolved: { resolvedReferences: ReadonlyArray<{ phrase: string }> },
): string {
  const lines: string[] = ["# 📋 下一章写作契约\n"];
  if (resolved.resolvedReferences.length > 0) {
    lines.push("**引用来源**: " + resolved.resolvedReferences.map((r) => r.phrase).join("、"));
    lines.push("");
  }
  if (contract.mustInclude.length > 0) {
    lines.push("## ✅ 必须包含");
    for (const item of contract.mustInclude) lines.push(`- ${item}`);
    lines.push("");
  }
  if (contract.mustAvoid.length > 0) {
    lines.push("## 🚫 必须避免");
    for (const item of contract.mustAvoid) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push(`**约束等级**: ${contract.priority === "hard" ? "🔴 硬约束" : contract.priority === "soft" ? "🔵 软约束" : "🟡 普通"}`);
  lines.push(`**场景节数**: ${blueprint.scenes.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("以上契约和蓝图已保存。你可以直接说「执行 write_draft 写下一章」来生成正文，我会严格按契约执行。");
  return lines.join("\n");
}

// Load latest contract + blueprint artifacts for auto-injection into write-next
async function loadLatestSteeringArtifacts(
  svc: AssistantArtifactService,
  sessionId: string,
  bookId?: string,
): Promise<{
  contract: Record<string, unknown> | undefined;
  blueprint: Record<string, unknown> | undefined;
  /** artifactId of the confirmed blueprint (only set when blueprint is present). */
  blueprintArtifactId: string | undefined;
  sourceArtifactIds: string[];
  /** artifactId of an unconfirmed (draft/edited) blueprint, if no confirmed one found. */
  pendingBlueprintArtifactId: string | undefined;
  /** Status of the pending blueprint (e.g. "draft" or "edited"). */
  pendingBlueprintStatus: string | undefined;
}> {
  const result = {
    contract: undefined as Record<string, unknown> | undefined,
    blueprint: undefined as Record<string, unknown> | undefined,
    blueprintArtifactId: undefined as string | undefined,
    sourceArtifactIds: [] as string[],
    pendingBlueprintArtifactId: undefined as string | undefined,
    pendingBlueprintStatus: undefined as string | undefined,
  };
  try {
    const artifacts = sessionId ? await svc.listRecentSessionArtifacts(sessionId, 50) : [];
    // Track creation times so we can prefer a newer chapter_plan over an older steering contract
    let latestContractCreatedAt: string | undefined;
    for (const art of artifacts) {
      if (art.type === "chapter_steering_contract" && !result.contract) {
        const full = await svc.getById(art.artifactId, sessionId, bookId);
        if (full) {
          result.contract = full.payload;
          result.sourceArtifactIds.push(art.artifactId);
          latestContractCreatedAt = art.createdAt;
        }
      }
      if (art.type === "chapter_blueprint" && !result.blueprint) {
        const full = await svc.getById(art.artifactId, sessionId, bookId);
        if (full) {
          const confirmedBlueprint = parseConfirmedChapterBlueprint(full.payload);
          if (confirmedBlueprint) {
            result.blueprint = confirmedBlueprint;
            result.blueprintArtifactId = art.artifactId;
            result.sourceArtifactIds.push(art.artifactId);
          } else if (!result.pendingBlueprintArtifactId) {
            // Blueprint exists but is not yet confirmed — track it for the checkpoint binding
            result.pendingBlueprintArtifactId = art.artifactId;
            result.pendingBlueprintStatus = typeof full.payload.status === "string" ? full.payload.status : "draft";
          }
        }
      }
    }
    // If a chapter_plan artifact exists that is NEWER than the loaded steering contract,
    // it means the user asked the agent to design a new chapter AFTER the previous write.
    // In that case, override result.contract with the newer design plan.
    // Also handles the fallback when no contract/blueprint was found at all.
    const shouldCheckChapterPlan = !result.blueprint && (
      !result.contract ||        // no contract found: use chapter_plan as fallback
      latestContractCreatedAt !== undefined  // contract found but may be outdated
    );
    if (shouldCheckChapterPlan) {
      for (const art of artifacts) {
        if (art.type !== "chapter_plan") continue;
        // Only override an existing contract if this plan is strictly newer
        if (result.contract && latestContractCreatedAt !== undefined && art.createdAt <= latestContractCreatedAt) continue;
        const full = await svc.getById(art.artifactId, sessionId, bookId);
        if (!full) continue;
        const payload = full.payload as Record<string, unknown>;
        const planText = typeof payload.response === "string"
          ? payload.response
          : (full.searchableText ?? "");
        if (!planText.trim()) continue;
        const payloadBeats = Array.isArray(payload.sceneBeats)
          ? (payload.sceneBeats as unknown[]).filter((v): v is string => typeof v === "string")
          : [];
        const sceneBeats = uniqueStrings([
          ...payloadBeats,
          ...extractChapterPlanSceneBeats(planText),
        ]);
        const goal = typeof payload.goal === "string"
          ? payload.goal
          : extractChapterPlanGoal(planText);
        result.contract = {
          priority: "hard",
          mustInclude: sceneBeats.slice(0, 10),
          mustAvoid: [] as string[],
          sceneBeats,
          ...(goal ? { goal } : {}),
          rawRequest: planText,
          sourceArtifactIds: [art.artifactId],
          userContractPriority: "hard",
        };
        // When overriding a stale steering contract, replace it in sourceArtifactIds
        // (remove old contract id and add the new plan id)
        result.sourceArtifactIds = [art.artifactId];
        break;
      }
    }
  } catch { /* best-effort */ }
  return result;
}

function parseAssistantChapterFromInput(input: string): number | undefined {
  const zhMatch = input.match(ASSISTANT_CHAPTER_ZH_PATTERN);
  if (zhMatch?.[1]) return Number.parseInt(zhMatch[1], 10);
  const enMatch = input.match(ASSISTANT_CHAPTER_EN_PATTERN);
  if (enMatch?.[1]) return Number.parseInt(enMatch[1], 10);
  return undefined;
}

function parseConfirmedChapterBlueprint(raw: unknown): ChapterBlueprint | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const parsed = ChapterBlueprintSchema.safeParse(raw);
  if (!parsed.success || parsed.data.status !== "confirmed") return undefined;
  return parsed.data;
}

function buildBlueprintVerificationSceneBeats(blueprint: ChapterBlueprint | undefined): string[] {
  if (!blueprint) return [];
  const beats: string[] = [
    `Blueprint openingHook: ${blueprint.openingHook}`,
    `Blueprint payoffRequired: ${blueprint.payoffRequired}`,
    `Blueprint endingHook: ${blueprint.endingHook}`,
  ];
  for (const [index, scene] of blueprint.scenes.entries()) {
    beats.push(`Blueprint scene ${index + 1} beat: ${scene.beat}`);
    beats.push(`Blueprint scene ${index + 1} conflict: ${scene.conflict}`);
    if (scene.informationGap) beats.push(`Blueprint scene ${index + 1} informationGap: ${scene.informationGap}`);
    beats.push(`Blueprint scene ${index + 1} turn: ${scene.turn}`);
    beats.push(`Blueprint scene ${index + 1} payoff: ${scene.payoff}`);
    beats.push(`Blueprint scene ${index + 1} cost: ${scene.cost}`);
  }
  return beats;
}

function extractAssistantUserRequest(input: string): string {
  const matched = input.match(/【用户请求】([\s\S]*)$/u);
  const request = matched?.[1]?.trim() ?? input.trim();
  return request.length > 0 ? request : input.trim();
}

function inferAssistantReviseModeFromInput(input: string): "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect" | "chapter-redesign" {
  if (ASSISTANT_REVISE_MODE_ANTI_DETECT_PATTERN.test(input)) {
    return "anti-detect";
  }
  if (ASSISTANT_REVISE_MODE_CHAPTER_REDESIGN_PATTERN.test(input)) {
    return "chapter-redesign";
  }
  if (ASSISTANT_REVISE_MODE_POLISH_PATTERN.test(input)) {
    return "polish";
  }
  if (ASSISTANT_REVISE_MODE_REWORK_PATTERN.test(input)) {
    return "rework";
  }
  if (ASSISTANT_REVISE_MODE_REWRITE_PATTERN.test(input)) {
    return "rewrite";
  }
  return "spot-fix";
}

function normalizeAssistantBookTitle(input: string): string {
  return input
    .trim()
    .replace(/[《》「」"'`]/gu, "")
    .toLowerCase();
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
  if (ASSISTANT_GOAL_TO_BOOK_PATTERN.test(normalized)) {
    return "goal_to_book";
  }
  // "写下一章" and "write_draft" both map to write_next
  if (ASSISTANT_WRITE_NEXT_PATTERN.test(normalized) || ASSISTANT_DRAFT_PATTERN.test(normalized)) {
    return "write_next";
  }
  if (ASSISTANT_REVISE_INTENT_PATTERN.test(normalized)) {
    return "audit_and_optimize";
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

function appendAssistantCheckpointAfterLeafTasks(graph: TaskGraph): TaskGraph {
  const leafTaskNodeIds = graph.nodes
    .filter((node) => node.type === "task")
    .filter((node) => !graph.edges.some((edge) => edge.from === node.nodeId))
    .map((node) => node.nodeId);
  if (leafTaskNodeIds.length === 0) {
    return graph;
  }
  const checkpointNodeId = nextAssistantCheckpointNodeId(graph);
  const checkpointNode: TaskNode = {
    nodeId: checkpointNodeId,
    type: "checkpoint",
    action: "checkpoint",
    checkpoint: {
      nodeId: checkpointNodeId,
      requiredApproval: true,
    },
  };
  return {
    ...graph,
    nodes: [...graph.nodes, checkpointNode],
    edges: dedupeAssistantTaskEdges([
      ...graph.edges,
      ...leafTaskNodeIds.map((nodeId) => ({ from: nodeId, to: checkpointNodeId })),
    ]),
  };
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

function parseAssistantAutopilotLevel(
  rawAutopilotLevel: unknown,
): { ok: true; value?: AssistantAutopilotLevel } | { ok: false; errors: Array<{ field: string; message: string }> } {
  if (rawAutopilotLevel === undefined) {
    return { ok: true };
  }
  const autopilotLevel = normalizeAssistantAutopilotLevel(rawAutopilotLevel);
  if (!autopilotLevel) {
    return {
      ok: false,
      errors: [{
        field: "autopilotLevel",
        message: `autopilotLevel must be one of ${[...ASSISTANT_AUTOPILOT_LEVEL_VALUES, "L0", "L1", "L2", "L3"].join(", ")}`,
      }],
    };
  }
  return { ok: true, value: autopilotLevel };
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
        { stepId: "s1", action: "plan-next", ...bookTarget, planInput: input },
      ],
      risk: {
        level: "medium",
        reasons: ["将生成项目结构大纲"],
      },
    };
  }

  return {
    plan: [
      { stepId: "s1", action: "plan-next", ...bookTarget, planInput: input },
      { stepId: "s2", action: "write-next", ...bookTarget, mode: "ai-plan", planInput: input, brief: input },
    ],
    risk: {
      level: "low",
      reasons: ["将生成下一章节草稿"],
    },
  };
}

function parseAssistantIntentType(input: unknown): AssistantPlanIntentType | null {
  return input === "goal-to-book" ? input : null;
}

function parseGoalToBookChapterTarget(input: string): number {
  const zhMatch = input.match(/第?\s*(\d+)\s*章/u)?.[1];
  if (zhMatch) {
    return Math.max(1, Math.min(12, Number.parseInt(zhMatch, 10)));
  }
  const countMatch = input.match(/(\d+)\s*(章|chapters?)/iu)?.[1];
  if (countMatch) {
    return Math.max(1, Math.min(12, Number.parseInt(countMatch, 10)));
  }
  return 3;
}

function buildGoalToBookTaskGraph(
  taskId: string,
  bookId: string,
  nextChapter: number,
  chapterTarget: number,
): { plan: AssistantPlanStep[]; graph: TaskGraph; risk: { level: AssistantPlanRiskLevel; reasons: string[] } } {
  const plan: AssistantPlanStep[] = [
    { stepId: "s1", action: "plan-next", bookId },
  ];
  const nodes: TaskNode[] = [
    {
      nodeId: "s1",
      type: "task",
      action: "plan-next",
      bookId,
    },
    {
      nodeId: "cp1",
      type: "checkpoint",
      action: "checkpoint",
      mode: "blueprint-confirm",
      checkpoint: {
        nodeId: "cp1",
        requiredApproval: true,
      },
    },
  ];
  const edges: TaskEdge[] = [{ from: "s1", to: "cp1" }];
  let previousNodeId = "cp1";
  let stepIndex = 2;

  for (let offset = 0; offset < chapterTarget; offset += 1) {
    const chapter = nextChapter + offset;
    const cycleSteps: AssistantPlanStep[] = [
      { stepId: `s${stepIndex}`, action: "write-next", bookId, chapter, mode: "ai-plan" },
      { stepId: `s${stepIndex + 1}`, action: "audit", bookId, chapter },
      { stepId: `s${stepIndex + 2}`, action: "revise", bookId, chapter, mode: "rewrite" },
      { stepId: `s${stepIndex + 3}`, action: "re-audit", bookId, chapter },
    ];
    plan.push(...cycleSteps);
    cycleSteps.forEach((step) => {
      nodes.push({
        nodeId: step.stepId,
        type: "task",
        action: step.action,
        bookId,
        ...(step.chapter !== undefined ? { chapter: step.chapter } : {}),
        ...(step.mode ? { mode: step.mode } : {}),
      });
      edges.push({ from: previousNodeId, to: step.stepId });
      previousNodeId = step.stepId;
    });
    stepIndex += cycleSteps.length;
  }

  const releaseCheckpointId = "cp2";
  nodes.push({
    nodeId: releaseCheckpointId,
    type: "checkpoint",
    action: "checkpoint",
    mode: "publish-candidate-confirm",
    checkpoint: {
      nodeId: releaseCheckpointId,
      requiredApproval: true,
    },
  });
  edges.push({ from: previousNodeId, to: releaseCheckpointId });

  return {
    plan,
    graph: {
      taskId,
      intent: "goal_to_book",
      intentType: "goal-to-book",
      riskLevel: "high",
      nodes,
      edges,
    },
    risk: {
      level: "high",
      reasons: [
        "将从一句话目标生成蓝图，并进入写→审→修→复审循环。",
        "包含蓝图确认 checkpoint，需人工审批后继续。",
        "包含发布候选 checkpoint，需人工确认后才能完成候选确认。",
      ],
    },
  };
}

function buildAssistantTaskGraphFromPlan(
  taskId: string,
  plan: ReadonlyArray<AssistantPlanStep>,
  riskLevel: "low" | "medium" | "high",
  autopilotLevel: AssistantAutopilotLevel = DEFAULT_ASSISTANT_AUTOPILOT_LEVEL,
): TaskGraph {
  const nodes: TaskNode[] = [];
  const edges: TaskEdge[] = [];
  let previousNodeId: string | null = null;

  plan.forEach((step) => {
    nodes.push({
      nodeId: step.stepId,
      type: "task",
      action: step.action,
      ...(typeof step.bookId === "string" ? { bookId: step.bookId } : {}),
      ...(Array.isArray(step.bookIds) ? { bookIds: [...step.bookIds] } : {}),
      ...(typeof step.chapter === "number" ? { chapter: step.chapter } : {}),
      ...(typeof step.mode === "string" ? { mode: step.mode } : {}),
      ...(typeof step.parallelCandidates === "number" ? { parallelCandidates: Math.max(1, Math.min(3, Math.trunc(step.parallelCandidates))) } : {}),
      ...(typeof step.planInput === "string" && step.planInput.trim().length > 0 ? { planInput: step.planInput.trim() } : {}),
      ...(typeof step.brief === "string" && step.brief.trim().length > 0 ? { brief: step.brief.trim() } : {}),
      ...(Array.isArray(step.dependsOn) && step.dependsOn.length > 0 ? { dependsOn: [...step.dependsOn] } : {}),
      maxRetries: Math.max(step.maxRetries ?? 0, 0),
    });
    if (previousNodeId) {
      edges.push({ from: previousNodeId, to: step.stepId });
    }
    previousNodeId = step.stepId;
  });

  return adaptAssistantTaskGraphForAutopilot({
    taskId,
    nodes,
    edges,
    riskLevel,
  }, resolveAssistantAutopilotDecision(riskLevel, autopilotLevel));
}

function isAssistantRiskyNode(node: Pick<TaskNode, "action" | "mode">): boolean {
  return node.action === "revise" || node.action === "anti-detect";
}

function dedupeAssistantTaskEdges(edges: ReadonlyArray<TaskEdge>): TaskEdge[] {
  const seen = new Set<string>();
  const deduped: TaskEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}

function nextAssistantCheckpointNodeId(graph: TaskGraph): string {
  let index = 1;
  const existingNodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  while (existingNodeIds.has(`cp${index}`)) {
    index += 1;
  }
  return `cp${index}`;
}

function stripAssistantCheckpoints(graph: TaskGraph): TaskGraph {
  // Only strip generic (autopilot-policy) checkpoints; preserve product-mandatory ones
  // such as "blueprint-confirm" which must survive into execution.
  const checkpointIds = new Set(
    graph.nodes.filter((node) => node.type === "checkpoint" && node.mode !== "blueprint-confirm").map((node) => node.nodeId),
  );
  if (checkpointIds.size === 0) {
    return {
      ...graph,
      nodes: [...graph.nodes],
      edges: [...graph.edges],
    };
  }
  const remainingEdges = graph.edges.filter((edge) => !checkpointIds.has(edge.from) && !checkpointIds.has(edge.to));
  const rewiredEdges: TaskEdge[] = [...remainingEdges];
  for (const checkpointId of checkpointIds) {
    const incoming = graph.edges
      .filter((edge) => edge.to === checkpointId && !checkpointIds.has(edge.from))
      .map((edge) => edge.from);
    const outgoing = graph.edges
      .filter((edge) => edge.from === checkpointId && !checkpointIds.has(edge.to))
      .map((edge) => edge.to);
    for (const from of incoming) {
      for (const to of outgoing) {
        rewiredEdges.push({ from, to });
      }
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !checkpointIds.has(node.nodeId)),
    edges: dedupeAssistantTaskEdges(rewiredEdges),
  };
}

function insertAssistantCheckpointBeforeTargets(graph: TaskGraph, targetNodeIds: ReadonlyArray<string>): TaskGraph {
  if (targetNodeIds.length === 0) {
    return graph;
  }
  const checkpointNodeId = nextAssistantCheckpointNodeId(graph);
  const targetSet = new Set(targetNodeIds);
  const checkpointNode: TaskNode = {
    nodeId: checkpointNodeId,
    type: "checkpoint",
    action: "checkpoint",
    checkpoint: {
      nodeId: checkpointNodeId,
      requiredApproval: true,
    },
  };
  const firstTargetIndex = graph.nodes.findIndex((node) => targetSet.has(node.nodeId));
  const nextNodes = [...graph.nodes];
  nextNodes.splice(firstTargetIndex >= 0 ? firstTargetIndex : 0, 0, checkpointNode);

  const nextEdges = graph.edges.filter((edge) => !(targetSet.has(edge.to) && !targetSet.has(edge.from)));
  for (const targetNodeId of targetSet) {
    const incoming = graph.edges
      .filter((edge) => edge.to === targetNodeId && !targetSet.has(edge.from))
      .map((edge) => edge.from);
    if (incoming.length === 0) {
      nextEdges.push({ from: checkpointNodeId, to: targetNodeId });
      continue;
    }
    for (const from of incoming) {
      nextEdges.push({ from, to: checkpointNodeId });
    }
    nextEdges.push({ from: checkpointNodeId, to: targetNodeId });
  }

  return {
    ...graph,
    nodes: nextNodes,
    edges: dedupeAssistantTaskEdges(nextEdges),
  };
}

function adaptAssistantTaskGraphForAutopilot(
  graph: TaskGraph,
  decision: AssistantAutopilotDecision,
): TaskGraph {
  if (graph.intentType === "goal-to-book") {
    return {
      ...graph,
      nodes: [...graph.nodes],
      edges: [...graph.edges],
    };
  }
  const strippedGraph = stripAssistantCheckpoints(graph);
  if (decision.checkpointStrategy === "none") {
    return strippedGraph;
  }
  if (decision.checkpointStrategy === "before-first-step") {
    const edgeTargets = new Set(strippedGraph.edges.map((edge) => edge.to));
    const rootNodeIds = strippedGraph.nodes
      .filter((node) => node.type === "task")
      .filter((node) => !edgeTargets.has(node.nodeId))
      .map((node) => node.nodeId);
    return insertAssistantCheckpointBeforeTargets(strippedGraph, rootNodeIds);
  }
  const riskyNode = strippedGraph.nodes.find((node) => node.type === "task" && isAssistantRiskyNode(node));
  return riskyNode
    ? insertAssistantCheckpointBeforeTargets(strippedGraph, [riskyNode.nodeId])
    : strippedGraph;
}

function flattenAssistantPolicyPlanFromGraph(graph: TaskGraph): AssistantPolicyPlanStep[] {
  return graph.nodes
    .filter((node) => node.type === "task")
    .map((node) => ({
      action: node.action,
      ...(node.mode ? { mode: node.mode } : {}),
      ...(node.bookId ? { bookId: node.bookId } : {}),
      ...(node.bookIds ? { bookIds: [...node.bookIds] } : {}),
    }));
}

function collectAssistantExecutableNodes(graph: TaskGraph): AssistantExecuteStepRef[] {
  return graph.nodes
    .filter((node) => node.type === "task")
    .map((node) => {
      if (node.action !== "audit" && node.action !== "revise" && node.action !== "re-audit") {
        return null;
      }
      const stepBookId = typeof node.bookId === "string"
        ? node.bookId
        : (Array.isArray(node.bookIds) && node.bookIds.length === 1 && typeof node.bookIds[0] === "string"
          ? node.bookIds[0]
          : null);
      const stepChapter = typeof node.chapter === "number" ? node.chapter : null;
      if (!stepBookId || stepChapter === null || !Number.isInteger(stepChapter) || stepChapter < 1) {
        return null;
      }
      return {
        stepId: node.nodeId,
        action: node.action,
        bookId: stepBookId,
        chapter: stepChapter,
        ...(node.mode !== undefined ? { mode: node.mode } : {}),
        ...(node.parallelCandidates !== undefined ? { parallelCandidates: node.parallelCandidates } : {}),
      } satisfies AssistantExecuteStepRef;
    })
    .filter((node): node is AssistantExecuteStepRef => node !== null);
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
  const chapter = typeof body.chapter === "number" ? body.chapter : undefined;
  const errors: Array<{ field: string; message: string }> = [];
  if (dimension !== "book" && dimension !== "volume" && dimension !== "chapter" && dimension !== "character" && dimension !== "hook") {
    errors.push({ field: "dimension", message: "dimension must be one of book/volume/chapter/character/hook" });
  }
  if (!bookId) errors.push({ field: "bookId", message: "bookId must be a non-empty string" });
  if (dimension === "chapter" && chapter !== undefined && (!Number.isInteger(chapter) || chapter < 1)) {
    errors.push({ field: "chapter", message: "chapter must be a positive integer when provided" });
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

const ASSISTANT_MEMORY_LAYERS = ["session", "book", "user", "market"] as const;

function isAssistantMemoryLayer(value: string): value is AssistantMemoryLayer {
  return (ASSISTANT_MEMORY_LAYERS as readonly string[]).includes(value);
}

function parseAssistantMemoryPayload(body: unknown): {
  readonly data: unknown;
  readonly summary?: string;
  readonly bookId?: string;
  readonly sessionId?: string;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const payload = body as Record<string, unknown>;
  return {
    data: payload.data ?? null,
    ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
    ...(typeof payload.bookId === "string" ? { bookId: payload.bookId } : {}),
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
  };
}

function toAssistantMemoryWarning(message: string | undefined): { code: string; message: string } | undefined {
  if (!message) {
    return undefined;
  }
  return {
    code: "ASSISTANT_MEMORY_DEGRADED",
    message,
  };
}

// --- Server factory ---

export function createStudioServer(initialConfig: ProjectConfig, root: string) {
  const app = new Hono();
  const promptInjectionGuard = createPromptInjectionGuard(root);
  const state = new StateManager(root);
  const chapterRunStore = new ChapterRunStore((bookId) => state.bookDir(bookId));
  const assistantMemoryService = createAssistantMemoryService(root);
  const artifactService = new AssistantArtifactService({
    artifactsRoot: join(root, ".inkos", "assistant-artifacts"),
    booksRoot: join(root, "books"),
  });
  const narrativeGraphService = new NarrativeGraphService({
    booksRoot: join(root, "books"),
  });
  let cachedConfig = initialConfig;

  // --- Runtime event log ---
  const runtimeEvents: RuntimeEvent[] = [];
  let runtimeEventIdCounter = 0;
  let sseClientCount = 0;
  const assistantTaskSnapshots = new Map<string, AssistantTaskSnapshot>();
  const assistantTaskGraphs = new Map<string, TaskGraph>();
  const assistantCandidateApprovalResolvers = new Map<string, (candidateId: string) => void>();
  const assistantTaskExecutionAutopilotLevels = new Map<string, AssistantAutopilotLevel>();
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
        if (snapshot.graph) {
          assistantTaskGraphs.set(snapshot.taskId, snapshot.graph);
        }
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
    const currentNodeId = typeof payload.nodeId === "string" ? payload.nodeId : currentStepId;
    const retryContext = typeof payload.retryContext === "object" && payload.retryContext !== null && !Array.isArray(payload.retryContext)
      ? payload.retryContext as Record<string, unknown>
      : undefined;
    const mergedRetryContext = retryContext ?? previous?.retryContext;
    const graph = normalizeAssistantTaskGraph(payload.graph, taskId) ?? previous?.graph;
    if (graph) {
      assistantTaskGraphs.set(taskId, graph);
    }

    if (event === "assistant:done") {
      assistantTaskSnapshots.set(taskId, {
        taskId,
        sessionId: payload.sessionId,
        status: payload.status === "succeeded" ? "succeeded" : "failed",
        ...(currentStepId !== undefined ? { currentStepId } : {}),
        steps: previous?.steps ?? {},
        ...(previous?.nodes ? { nodes: previous.nodes } : {}),
        ...(graph ? { graph } : {}),
        lastUpdatedAt: timestamp,
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        ...(mergedRetryContext ? { retryContext: mergedRetryContext } : {}),
      });
      scheduleAssistantTaskSnapshotPersistence();
      broadcast(event, data);
      return;
    }

    const stepId = currentStepId;
    let nodeStatus = parseAssistantTaskNodeStatus(payload.nodeStatus);
    if (!nodeStatus) {
      if (event === "assistant:step:start") {
        nodeStatus = "running";
      } else if (event === "assistant:step:success") {
        nodeStatus = "succeeded";
      } else {
        nodeStatus = "failed";
      }
    }
    let stepStatus: AssistantTaskStepSnapshot["status"] = "running";
    if (event === "assistant:step:success") {
      stepStatus = "succeeded";
    } else if (event === "assistant:step:fail" && nodeStatus === "failed") {
      stepStatus = "failed";
    }
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
    const previousNode = currentNodeId ? previous?.nodes?.[currentNodeId] : undefined;
    const checkpoint = typeof payload.checkpoint === "object" && payload.checkpoint !== null && !Array.isArray(payload.checkpoint)
      ? payload.checkpoint as CheckpointState
      : previousNode?.checkpoint;
    const attempts = typeof payload.attempts === "number" && Number.isFinite(payload.attempts)
      ? payload.attempts
      : previousNode?.attempts ?? 0;
    const maxRetries = typeof payload.maxRetries === "number" && Number.isFinite(payload.maxRetries)
      ? payload.maxRetries
      : previousNode?.maxRetries ?? 0;
    const parallelCandidates = typeof payload.parallelCandidates === "number" && Number.isFinite(payload.parallelCandidates)
      ? Math.max(1, Math.min(3, Math.trunc(payload.parallelCandidates)))
      : previousNode?.parallelCandidates;
    const nextNodes = {
      ...(previous?.nodes ?? {}),
      ...(currentNodeId
        ? {
          [currentNodeId]: {
            nodeId: currentNodeId,
            type: parseAssistantTaskNodeType(payload.nodeType) ?? previousNode?.type ?? "task",
            ...(typeof payload.action === "string" ? { action: payload.action } : previousNode?.action ? { action: previousNode.action } : {}),
            ...(typeof payload.runId === "string" ? { runId: payload.runId } : previousNode?.runId ? { runId: previousNode.runId } : {}),
            status: nodeStatus,
            ...(parallelCandidates !== undefined ? { parallelCandidates } : {}),
            attempts,
            maxRetries,
            ...(nodeStatus === "running" || nodeStatus === "waiting_approval"
              ? { startedAt: previousNode?.startedAt ?? timestamp }
              : {
                  ...(previousNode?.startedAt !== undefined ? { startedAt: previousNode.startedAt } : {}),
                  finishedAt: timestamp,
                }),
            ...(typeof payload.error === "string" ? { error: payload.error } : previousNode?.error ? { error: previousNode.error } : {}),
            ...(checkpoint ? { checkpoint } : {}),
            ...(previousNode?.steeringContract ? { steeringContract: previousNode.steeringContract } : {}),
            ...(previousNode?.blueprint ? { blueprint: previousNode.blueprint } : {}),
            ...(previousNode?.sourceArtifactIds && previousNode.sourceArtifactIds.length > 0 ? { sourceArtifactIds: previousNode.sourceArtifactIds } : {}),
            ...(previousNode?.candidateDecision ? { candidateDecision: previousNode.candidateDecision } : {}),
          } satisfies AssistantTaskNodeSnapshot,
        }
        : {}),
    };

    assistantTaskSnapshots.set(taskId, {
      taskId,
      sessionId: payload.sessionId,
      status: event === "assistant:step:fail" && nodeStatus === "failed" ? "failed" : "running",
      ...(stepId !== undefined ? { currentStepId: stepId } : {}),
      steps: nextSteps,
      ...(Object.keys(nextNodes).length > 0 ? { nodes: nextNodes } : {}),
      ...(graph ? { graph } : {}),
      lastUpdatedAt: timestamp,
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      ...(mergedRetryContext ? { retryContext: mergedRetryContext } : {}),
      ...(Object.values(nextNodes).some((node) => node.status === "waiting_approval") && previous?.awaitingApproval
        ? { awaitingApproval: previous.awaitingApproval }
        : {}),
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
  app.use("/api/assistant/*", promptInjectionGuard.middleware);

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

  async function readAssistantStrategySettings(): Promise<AssistantStrategySettings> {
    try {
      const configPath = join(root, "inkos.json");
      const raw = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
      return normalizeAssistantStrategySettings(raw.assistantStrategy);
    } catch {
      return normalizeAssistantStrategySettings(undefined);
    }
  }

  async function readPersistedBookConfigRecord(bookId: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = JSON.parse(await readFile(join(state.bookDir(bookId), "book.json"), "utf-8"));
      return typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  async function loadBookConfigWithReleaseCandidateState(
    bookId: string,
  ): Promise<Record<string, unknown> & { is_release_candidate: boolean }> {
    const book = await state.loadBookConfig(bookId) as Record<string, unknown>;
    const persisted = await readPersistedBookConfigRecord(bookId);
    return {
      ...book,
      is_release_candidate: persisted?.is_release_candidate === true,
    };
  }

  async function writeBookReleaseCandidateState(
    bookId: string,
    isReleaseCandidate: boolean,
  ): Promise<Record<string, unknown> & { is_release_candidate: boolean }> {
    const persisted = await readPersistedBookConfigRecord(bookId);
    const book = await state.loadBookConfig(bookId) as Record<string, unknown>;
    const persistedExtras = Object.fromEntries(
      Object.entries(persisted ?? {}).filter(([key]) => !(key in book)),
    );
    const nextBook = {
      ...book,
      ...persistedExtras,
      is_release_candidate: isReleaseCandidate,
      updatedAt: new Date().toISOString(),
    };
    return await persistBookConfigRecord(bookId, nextBook) as Record<string, unknown> & { is_release_candidate: boolean };
  }

  async function persistBookConfigRecord(bookId: string, bookRecord: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bookPath = join(state.bookDir(bookId), "book.json");
    await mkdir(dirname(bookPath), { recursive: true });
    await writeFile(bookPath, JSON.stringify(bookRecord, null, 2), "utf-8");
    return bookRecord;
  }

  async function collectReleaseGateSecuritySources(bookId: string): Promise<ReadonlyArray<ReleaseGateTextSource>> {
    const sources: ReleaseGateTextSource[] = [];
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    for (const fileName of ["story_bible.md", "volume_outline.md", "character_matrix.md", "pending_hooks.md"]) {
      try {
        const content = await readFile(join(storyDir, fileName), "utf-8");
        sources.push({ source: `story/${fileName}`, content });
      } catch {
        // ignore missing story sources
      }
    }
    try {
      const chapterFiles = (await readdir(chaptersDir))
        .filter((fileName) => /^\d+_.+\.md$/u.test(fileName))
        .sort((left, right) => left.localeCompare(right));
      for (const fileName of chapterFiles) {
        try {
          const content = await readFile(join(chaptersDir, fileName), "utf-8");
          sources.push({ source: `chapters/${fileName}`, content });
        } catch {
          // ignore unreadable chapter sources
        }
      }
    } catch {
      // ignore missing chapters directory
    }
    return sources;
  }

  async function buildReleaseCandidateEvaluation(
    bookId: string,
    manualConfirmed: boolean,
  ): Promise<ReleaseCandidateEvaluation> {
    const [book, strategy, runs, securitySources] = await Promise.all([
      loadBookConfigWithReleaseCandidateState(bookId),
      readAssistantStrategySettings(),
      chapterRunStore.listRuns(bookId, { limit: 100 }),
      collectReleaseGateSecuritySources(bookId),
    ]);
    const report = await deriveAssistantEvaluateReport(
      runs,
      { type: "book", bookId },
      [],
    );
    const securityFindings = scanReleaseGateSecuritySources(securitySources);
    return evaluateReleaseCandidate({
      bookId,
      isReleaseCandidate: book.is_release_candidate,
      publishQualityGate: strategy.publishQualityGate,
      overallScore: report.overallScore,
      consistencyBlockingIssues: report.blockingIssues,
      securityFindings,
      manualConfirmed,
      autopilotLevel: strategy.autopilotLevel,
    });
  }

  async function buildPipelineConfig(
    overrides?: Partial<Pick<PipelineConfig, "externalContext" | "confirmedChapterBlueprint">>,
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
        const payload = {
          callId: progress.callId,
          agentName: progress.agentName,
          purpose: progress.purpose,
          elapsedMs: progress.elapsedMs,
          totalChars: progress.totalChars,
          chineseChars: progress.chineseChars,
          preview: progress.preview,
        };
        if (progress.status === "start") {
          broadcast("llm:call:start", payload);
          return;
        }
        if (progress.status === "streaming") {
          broadcast("llm:progress", {
            elapsedMs: progress.elapsedMs,
            totalChars: progress.totalChars,
            chineseChars: progress.chineseChars,
          });
          broadcast("llm:call:progress", payload);
          return;
        }
        if (progress.status === "done") {
          broadcast("llm:call:done", payload);
        }
      },
      externalContext: overrides?.externalContext,
      confirmedChapterBlueprint: overrides?.confirmedChapterBlueprint,
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

  async function refreshBookMemory(
    bookId: string,
    chapterNumber: number,
    action: "write-next" | "revise",
    details: Record<string, unknown>,
    chapterSnippet?: string,
  ): Promise<void> {
    try {
      await assistantMemoryService.updateBookMemory({
        bookId,
        chapterNumber,
        action,
        details,
        chapterSnippet,
      });
    } catch {
      // Memory sync failures must not interrupt the main pipeline flow.
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
    const candidate = extractCandidateRevision(run);
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
      ...(candidate ? {
        candidateStatus: candidate.status,
        candidateAuditIssues: [...candidate.auditIssues],
      } : {}),
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
      ...(step.parallelCandidates !== undefined ? { parallelCandidates: clampParallelCandidates(step.parallelCandidates) } : {}),
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

  async function waitForAssistantChapterAvailability(
    bookId: string,
    chapterNumber: number,
    timeoutMs = 20 * 60_000,
  ): Promise<void> {
    const started = Date.now();
    const prefix = `${String(chapterNumber).padStart(4, "0")}_`;
    let delayMs = 100;
    while (Date.now() - started < timeoutMs) {
      try {
        const files = await readdir(join(state.bookDir(bookId), "chapters"));
        if (files.some((file) => file.startsWith(prefix) && file.endsWith(".md"))) {
          return;
        }
      } catch {
        // keep polling until timeout
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1_000);
    }
    throw new Error(`Timed out waiting for chapter ${chapterNumber} in ${bookId}`);
  }

  function generateAssistantRunId(): string {
    return `asst_run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  function createAssistantTaskNodesSnapshot(graph: TaskGraph): Record<string, AssistantTaskNodeSnapshot> {
    return Object.fromEntries(graph.nodes.map((node) => [
      node.nodeId,
      {
        nodeId: node.nodeId,
        type: node.type,
        action: node.action,
        status: "pending",
        attempts: 0,
        maxRetries: Math.max(node.maxRetries ?? 0, 0),
        ...(node.parallelCandidates !== undefined ? { parallelCandidates: node.parallelCandidates } : {}),
        ...(node.steeringContract ? { steeringContract: node.steeringContract } : {}),
        ...(node.blueprint ? { blueprint: node.blueprint } : {}),
        ...(node.sourceArtifactIds && node.sourceArtifactIds.length > 0 ? { sourceArtifactIds: node.sourceArtifactIds } : {}),
        ...(node.checkpoint ? { checkpoint: node.checkpoint } : {}),
      } satisfies AssistantTaskNodeSnapshot,
    ]));
  }

  function ensureAssistantTaskSnapshot(taskId: string, sessionId: string, graph: TaskGraph): AssistantTaskSnapshot {
    const now = new Date().toISOString();
    const previous = assistantTaskSnapshots.get(taskId);
    const snapshot: AssistantTaskSnapshot = {
      taskId,
      sessionId,
      status: previous?.status ?? "running",
      ...(previous?.currentStepId ? { currentStepId: previous.currentStepId } : {}),
      steps: previous?.steps ?? {},
      nodes: previous?.nodes ?? createAssistantTaskNodesSnapshot(graph),
      graph,
      lastUpdatedAt: now,
      ...(previous?.error ? { error: previous.error } : {}),
      ...(previous?.retryContext ? { retryContext: previous.retryContext } : {}),
    };
    assistantTaskGraphs.set(taskId, graph);
    assistantTaskSnapshots.set(taskId, snapshot);
    scheduleAssistantTaskSnapshotPersistence();
    return snapshot;
  }

  function summarizeAssistantTaskRun(taskId: string): Record<string, unknown> {
    const runtime = assistantConductor.getRunState(taskId);
    const snapshot = assistantTaskSnapshots.get(taskId);
    if (!runtime && !snapshot) {
      return {};
    }
    const responseStatus = runtime?.status ?? (snapshot?.status ?? "running");
    const status = snapshot?.awaitingApproval
      ? "waiting_approval"
      : responseStatus === "pending" ? "running" : responseStatus;
    const stepRunIds = runtime?.stepRunIds ?? {};
    const candidateDecisions = snapshot?.nodes
      ? Object.fromEntries(
          Object.entries(snapshot.nodes)
            .filter(([, node]) => node.candidateDecision)
            .map(([nodeId, node]) => [nodeId, node.candidateDecision]),
        )
      : {};
    return {
      taskId,
      sessionId: runtime?.sessionId ?? snapshot?.sessionId ?? "",
      status,
      ...(runtime?.currentNodeId ? { currentNodeId: runtime.currentNodeId } : {}),
      ...(snapshot?.currentStepId ? { currentStepId: snapshot.currentStepId } : {}),
      ...(Object.keys(stepRunIds).length > 0 ? { stepRunIds } : {}),
      ...(Object.keys(candidateDecisions).length > 0 ? { candidateDecisions } : {}),
      ...(snapshot?.awaitingApproval
        ? { awaitingApproval: snapshot.awaitingApproval }
        : runtime?.status === "waiting_approval" && runtime.currentNodeId
          ? { awaitingApproval: { nodeId: runtime.currentNodeId, type: "checkpoint" } }
          : {}),
    };
  }

  function applyAssistantConductorEvent(event: AssistantConductorEvent): void {
    if (event.type === "graph") {
      assistantTaskExecutionAutopilotLevels.delete(event.taskId);
      assistantCandidateApprovalResolvers.delete(`${event.taskId}:${assistantTaskSnapshots.get(event.taskId)?.awaitingApproval?.nodeId ?? ""}`);
      if (event.reasonCode || event.errorCode) {
        broadcast("assistant:policy:blocked", {
          taskId: event.taskId,
          sessionId: event.sessionId,
          level: "warn",
          severity: "warn",
          timestamp: event.timestamp,
          reasons: event.error ? [event.error] : [],
          ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          ...(event.error ? { message: event.error } : {}),
        });
      }
      emitAssistantTaskEvent("assistant:done", {
        taskId: event.taskId,
        sessionId: event.sessionId,
        status: event.status,
        timestamp: event.timestamp,
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.error ? { error: event.error } : {}),
      });
      return;
    }
    emitAssistantTaskEvent(event.phase === "start"
      ? "assistant:step:start"
      : event.phase === "success"
        ? "assistant:step:success"
        : "assistant:step:fail", {
      taskId: event.taskId,
      sessionId: event.sessionId,
      stepId: event.nodeId,
      nodeId: event.nodeId,
      nodeType: event.nodeType,
      nodeStatus: event.nodeStatus,
      action: event.action,
      timestamp: event.timestamp,
      attempts: event.attempts,
      maxRetries: event.maxRetries,
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.bookId ? { bookId: event.bookId } : {}),
      ...(event.bookIds ? { bookIds: event.bookIds } : {}),
      ...(event.chapter !== undefined ? { chapter: event.chapter } : {}),
      ...(event.mode ? { mode: event.mode } : {}),
      ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}),
      ...(event.retryContext ? { retryContext: event.retryContext } : {}),
    });
  }

  const assistantConductor = new AssistantConductor({
    prepareNode: async (node, context) => {
      if (node.action === "plan-next") {
        return {
          runId: generateAssistantRunId(),
          execute: async () => {
            const response = await app.request(
              `http://localhost/api/books/${node.bookId}/next-plan`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(node.planInput ? { brief: node.planInput } : {}),
              },
            );
            if (!response.ok) {
              throw new Error(await parseApiErrorMessage(response));
            }
            // After plan-next succeeds, update the draft blueprint artifact bound to the
            // cp1 checkpoint (if any) so the blueprint preview reflects the new plan goal/
            // conflicts AND the user's original instruction. Without this, cp1 shows the
            // old draft blueprint created *before* the user gave their answers.
            try {
              const planBody = await response.clone().json() as Record<string, unknown>;
              const planResult = typeof planBody.plan === "object" && planBody.plan !== null
                ? planBody.plan as Record<string, unknown>
                : null;
              if (planResult && context.sessionId) {
                const taskGraph = assistantTaskGraphs.get(context.taskId);
                const cpNode = taskGraph?.nodes.find(
                  (n) => n.type === "checkpoint" && n.mode === "blueprint-confirm",
                );
                const bpArtifactId = cpNode?.checkpoint?.blueprintArtifactId;
                if (bpArtifactId) {
                  const existing = await artifactService.getById(bpArtifactId, context.sessionId);
                  if (existing && existing.payload.status !== "confirmed") {
                    const planGoal = typeof planResult.goal === "string" ? planResult.goal : undefined;
                    const planConflicts = Array.isArray(planResult.conflicts) ? planResult.conflicts as string[] : [];
                    const updatedPayload: Record<string, unknown> = {
                      ...existing.payload,
                      ...(planGoal ? { planGoal } : {}),
                      ...(planConflicts.length > 0 ? { planConflicts } : {}),
                      ...(node.planInput ? { userInstruction: node.planInput } : {}),
                    };
                    await artifactService.update(bpArtifactId, context.sessionId, {
                      payload: updatedPayload,
                      summary: `Blueprint (plan-updated): ${planGoal ?? "no goal"}`,
                      searchableText: `${node.planInput ?? ""}\n${planGoal ?? ""}\n${planConflicts.join(" ")}`,
                    });
                  }
                }
              }
            } catch { /* best-effort: do not fail plan-next if the update fails */ }
          },
        };
      }

      if (node.action === "write-next") {
        return {
          runId: generateAssistantRunId(),
          execute: async () => {
            if (!node.bookId) {
              throw new Error("write-next node requires bookId");
            }
            // Subscribe for the real completion event BEFORE triggering the
            // write so we never miss a fast completion.
            const completionPromise = waitForBroadcastEvent<{ ok: boolean; error?: string; verificationPending?: boolean; chapterNumber?: number }>(
              (event, data) => {
                const d = data as Record<string, unknown> | null;
                if (d?.bookId !== node.bookId) return null;
                if (event === "write-next:success") {
                  const details = typeof d?.details === "object" && d.details !== null ? d.details as Record<string, unknown> : null;
                  return {
                    ok: true,
                    verificationPending: details?.verificationPending === true,
                    chapterNumber: typeof d?.chapterNumber === "number" ? d.chapterNumber : undefined,
                  };
                }
                if (event === "write-next:fail") return { ok: false, error: typeof d?.error === "string" ? d.error : "write-next failed" };
                return null;
              },
              20 * 60_000, // 20 min timeout — chapters can take a while
            );
            // Pre-attach a no-op rejection handler so that if the 20-min timeout fires
            // before the cleanup .catch() below is reached (e.g. while execute() is still
            // awaiting the internal HTTP response), the rejection is never "unhandled".
            // The real cleanup and re-throw happen in the .catch() chain further below.
            void completionPromise.catch(() => {});
            // Buffered verification listener — registered BEFORE the HTTP request to avoid
            // the race where write-next:verification fires before we start waiting.
            // The timeout (3 min) only starts AFTER write-next:success with verificationPending=true,
            // so long chapter generation does NOT cause the verification listener to pre-expire.
            // Bug 3 fix: events without chapterNumber are ignored; we match by chapterNumber
            // after the success event reveals which chapter was written.
            type VerificationResult = { contractSatisfaction: number; shouldRewrite: boolean; blueprintShouldRewrite: boolean; missingRequirements: string[]; chapterNumber: number };
            const verificationBuffer: VerificationResult[] = [];
            let pendingVerificationResolver: ((r: VerificationResult) => void) | null = null;
            let pendingVerificationRejecter: ((e: Error) => void) | null = null;
            let pendingVerificationChapter: number | null = null;
            let verificationListenerTimer: ReturnType<typeof setTimeout> | null = null;
            let verificationListenerHandler: EventHandler | null = null;
            const cleanupVerificationListener = () => {
              if (verificationListenerHandler) subscribers.delete(verificationListenerHandler);
              if (verificationListenerTimer !== null) clearTimeout(verificationListenerTimer);
              verificationListenerHandler = null;
              verificationListenerTimer = null;
              pendingVerificationResolver = null;
              pendingVerificationRejecter = null;
              pendingVerificationChapter = null;
            };
            verificationListenerHandler = (event, data) => {
              const d = data as Record<string, unknown> | null;
              if (event !== "write-next:verification" || d?.bookId !== node.bookId) return;
              // Bug 3: ignore events that carry no chapterNumber
              const chNum = typeof d?.chapterNumber === "number" ? d.chapterNumber : null;
              if (chNum === null) return;
              const cs = typeof d?.contractSatisfaction === "number" ? d.contractSatisfaction : 1;
              const sr = (typeof d?.report === "object" && d.report !== null ? (d.report as Record<string, unknown>).shouldRewrite : false) === true;
              const bsr = (typeof d?.blueprintFulfillment === "object" && d.blueprintFulfillment !== null
                ? (d.blueprintFulfillment as Record<string, unknown>).shouldRewrite
                : false) === true;
              const missing = Array.isArray(d?.missingRequirements) ? d.missingRequirements as string[] : [];
              const verResult: VerificationResult = { contractSatisfaction: cs, shouldRewrite: sr, blueprintShouldRewrite: bsr, missingRequirements: missing, chapterNumber: chNum };
              // If a resolver is waiting for this exact chapter, resolve immediately
              if (pendingVerificationChapter !== null && chNum === pendingVerificationChapter && pendingVerificationResolver !== null) {
                const resolver = pendingVerificationResolver;
                cleanupVerificationListener();
                resolver(verResult);
                return;
              }
              // Otherwise buffer (may be for a different chapter or arrive before success)
              verificationBuffer.push(verResult);
            };
            subscribers.add(verificationListenerHandler);

            const response = await app.request(
              `http://localhost/api/books/${node.bookId}/write-next`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sessionId: context.sessionId,
                  ...(node.mode ? { mode: node.mode } : {}),
                  ...(node.planInput ? { planInput: node.planInput } : {}),
                  ...(node.brief ? { brief: node.brief } : {}),
                  ...(node.steeringContract ? { steeringContract: node.steeringContract } : {}),
                  ...(node.blueprint ? { blueprint: node.blueprint } : {}),
                  ...(node.sourceArtifactIds ? { sourceArtifactIds: node.sourceArtifactIds } : {}),
                }),
              },
            );
            if (!response.ok) {
              cleanupVerificationListener();
              throw new Error(await parseApiErrorMessage(response));
            }
            // The route returns immediately ({ status: "writing" }) while
            // the pipeline runs in the background. Wait for the real
            // write-next:success / write-next:fail broadcast event.
            // Synchronously chain .catch() so the rejection is never "unhandled"
            // (avoids Node.js unhandled-rejection warnings when the 20-min timeout
            // fires before the awaiting microtask processes it).
            const result = await completionPromise.catch((e: unknown) => {
              cleanupVerificationListener();
              throw e;
            });
            if (!result.ok) {
              cleanupVerificationListener();
              throw new Error(result.error ?? "write-next failed");
            }
            // If verification is pending, wait for it and fail the node if requirements unmet.
            // Bug 2 fix: 3-minute timeout starts HERE (after chapter generation), not at registration.
            if (result.verificationPending && result.chapterNumber !== undefined) {
              const targetChapter = result.chapterNumber;
              // Check if the verification event already arrived (buffered)
              const bufferedIdx = verificationBuffer.findIndex((v) => v.chapterNumber === targetChapter);
              let verResult: VerificationResult;
              if (bufferedIdx >= 0) {
                verResult = verificationBuffer[bufferedIdx]!;
                cleanupVerificationListener();
              } else {
                // Wait with 3-minute timeout starting NOW (after success)
                verResult = await new Promise<VerificationResult>((resolve, reject) => {
                  pendingVerificationChapter = targetChapter;
                  pendingVerificationResolver = resolve;
                  pendingVerificationRejecter = reject;
                  verificationListenerTimer = setTimeout(() => {
                    cleanupVerificationListener();
                    reject(new Error("Timed out waiting for verification result"));
                  }, 3 * 60_000);
                });
              }
              if (verResult.contractSatisfaction < 0.7 || verResult.shouldRewrite || verResult.blueprintShouldRewrite) {
                const missingText = verResult.missingRequirements.length
                  ? `缺失要求：${verResult.missingRequirements.slice(0, 3).join("；")}`
                  : verResult.blueprintShouldRewrite
                    ? "章节蓝图兑现审计未通过"
                    : "硬性要求未满足";
                throw new Error(`契约验证不通过（${Math.round(verResult.contractSatisfaction * 100)}%）—— ${missingText}`);
              }
            } else {
              cleanupVerificationListener();
            }
          },
        };
      }

      if (node.action === "audit" || node.action === "re-audit") {
        const runId = generateAssistantRunId();
        return {
          runId,
          execute: async () => {
            const response = await app.request(
              `http://localhost/api/books/${node.bookId}/audit/${node.chapter}`,
              { method: "POST" },
            );
            if (!response.ok) {
              throw new Error(await parseApiErrorMessage(response));
            }
          },
        };
      }

      if (node.action === "revise") {
        const parallelCandidates = clampParallelCandidates(node.parallelCandidates);
        const startReviseRun = async (): Promise<string> => {
          const response = await app.request(
            `http://localhost/api/books/${node.bookId}/revise/${node.chapter}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(node.mode !== undefined ? { mode: node.mode } : {}) }),
            },
          );
          const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
          if (!response.ok || typeof payload?.["runId"] !== "string") {
            throw new Error(!response.ok ? await parseApiErrorMessage(response) : "revise step did not return runId");
          }
          return payload["runId"];
        };
        const runIds = parallelCandidates > 1
          ? await Promise.all(Array.from({ length: parallelCandidates }, async () => await startReviseRun()))
          : [await startReviseRun()];
        const runId = runIds[0]!;
        return {
          runId,
          execute: async () => {
            const reviseRuns = await Promise.all(
              runIds.map(async (currentRunId) => await waitForChapterRunCompletion(node.bookId!, currentRunId)),
            );
            if (parallelCandidates === 1) {
              const reviseRun = reviseRuns[0]!;
              if (reviseRun.status !== "succeeded") {
                throw new Error(reviseRun.error ?? "revise step failed");
              }
              return;
            }
            const scope: AssistantEvaluateScope = {
              type: "chapter",
              bookId: node.bookId!,
              chapter: node.chapter!,
            };
            const candidates = reviseRuns.map((reviseRun, index) =>
              buildAssistantCandidateSnapshot(node.nodeId, index, reviseRun, scope));
            const winner = pickWinningAssistantCandidate(candidates);
            if (!winner) {
              throw new Error(reviseRuns[0]?.error ?? "parallel candidate generation failed");
            }
            const autopilotLevel = assistantTaskExecutionAutopilotLevels.get(context.taskId) ?? DEFAULT_ASSISTANT_AUTOPILOT_LEVEL;
            const requiresManualVote = autopilotLevel === "L1" || autopilotLevel === "L2" || autopilotLevel === "guarded";
            if (requiresManualVote) {
              updateAssistantTaskNodeCandidateDecision(context.taskId, node.nodeId, {
                mode: "manual",
                status: "pending",
                candidates,
              }, {
                nodeStatus: "waiting_approval",
                awaitingApproval: {
                  nodeId: node.nodeId,
                  type: "candidate-selection",
                  candidates,
                },
              });
              const approvalKey = `${context.taskId}:${node.nodeId}`;
              const selectedCandidateId = await new Promise<string>((resolve) => {
                assistantCandidateApprovalResolvers.set(approvalKey, resolve);
              });
              assistantCandidateApprovalResolvers.delete(approvalKey);
              const selected = candidates.find((candidate) => candidate.candidateId === selectedCandidateId) ?? winner;
              updateAssistantTaskNodeCandidateDecision(context.taskId, node.nodeId, {
                mode: "manual",
                status: "selected",
                candidates,
                winnerCandidateId: selected.candidateId,
                winnerRunId: selected.runId,
                winnerScore: selected.score,
                winnerReason: selected.evidence[0]?.reason ?? "人工投票已选择候选",
              }, {
                nodeStatus: "running",
                awaitingApproval: null,
              });
              if (selected.pendingApproval) {
                await approveAssistantCandidateRun(node.bookId!, selected.runId, "Candidate revision approved by assistant manual vote.");
              }
              if (selected.status !== "succeeded") {
                throw new Error(selected.error ?? "selected candidate failed");
              }
              return;
            }
            updateAssistantTaskNodeCandidateDecision(context.taskId, node.nodeId, {
              mode: "auto",
              status: "selected",
              candidates,
              winnerCandidateId: winner.candidateId,
              winnerRunId: winner.runId,
              winnerScore: winner.score,
              winnerReason: winner.evidence[0]?.reason ?? "自动投票选择最高分候选",
            }, {
              nodeStatus: "running",
              awaitingApproval: null,
            });
            if (winner.pendingApproval) {
              await approveAssistantCandidateRun(node.bookId!, winner.runId, "Candidate revision approved by assistant auto vote.");
            }
            if (winner.status !== "succeeded") {
              throw new Error(winner.error ?? "winning candidate failed");
            }
          },
        };
      }

      throw new Error(`Unsupported assistant node action: ${node.action}`);
    },
  });

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

  interface AssistantBookEvaluateChapterSample {
    readonly chapter: number;
    readonly fileName: string;
    readonly snippet: string;
    readonly wordCount: number;
    readonly normalizedSnippet: string;
    readonly latestRun: ChapterRunRecord | null;
  }

  interface AssistantBookEvaluateSourceText {
    readonly fileName: string;
    readonly content: string;
    readonly size: number;
    readonly updatedAtMs: number;
  }

  interface AssistantBookEvaluateInput {
    readonly bookId: string;
    readonly runIds?: ReadonlyArray<string>;
  }

  function normalizeEvaluateText(value: string | null | undefined, maxLength = 300): string {
    return (value ?? "")
      .replace(/[^\S\n]+/gu, " ")
      .replace(/\n{3,}/gu, "\n\n")
      .trim()
      .slice(0, maxLength);
  }

  function mean(values: ReadonlyArray<number>): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function coefficientOfVariation(values: ReadonlyArray<number>): number {
    if (values.length < 2) return 0;
    const average = mean(values);
    if (average <= 0) return 0;
    const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
    return Math.sqrt(variance) / average;
  }

  function buildAssistantEvaluateFallbackEvidence(scope: AssistantEvaluateScope): AssistantEvaluateEvidence {
    const fallbackSource = scope.type === "chapter"
      ? `chapter:${scope.bookId}:${scope.chapter}`
      : `book:${scope.bookId}`;
    return {
      source: fallbackSource,
      excerpt: "暂无运行证据，使用范围级摘要作为最小可追溯证据。",
      reason: "当前评估未检索到可用 run 数据",
    };
  }

  function buildUnknownAssistantEvaluateScope(scopeType: "chapter" | "book"): AssistantEvaluateScope {
    return scopeType === "chapter"
      ? { type: "chapter", bookId: "unknown", chapter: 1 }
      : { type: "book", bookId: "unknown" };
  }

  function deriveChapterAssistantEvaluateReport(
    runs: ReadonlyArray<ChapterRunRecord>,
    scope: AssistantEvaluateScope,
  ): AssistantEvaluateReport {
    const failedRuns = runs.filter((run) => run.status === "failed");
    const unchangedRuns = runs.filter((run) => run.decision === "unchanged");
    const appliedRuns = runs.filter((run) => run.decision === "applied");
    const continuity = clampSerializableScore(85 - failedRuns.length * 25 - unchangedRuns.length * 8 + appliedRuns.length * 2);
    const readability = clampSerializableScore(82 - failedRuns.length * 18 - unchangedRuns.length * 5 + appliedRuns.length * 2);
    const styleConsistency = clampSerializableScore(80 - failedRuns.length * 15 - unchangedRuns.length * 6 + appliedRuns.length * 2);
    const aiTraceRisk = clampSerializableScore(78 - failedRuns.length * 20 - unchangedRuns.length * 7 + appliedRuns.length);
    const dimensions: AssistantEvaluateDimensions = {
      continuity,
      readability,
      styleConsistency,
      aiTraceRisk,
    };
    const overallScore = clampSerializableScore(
      (continuity + readability + styleConsistency + aiTraceRisk) / 4,
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
    const evidence = evidenceFromRuns.length > 0 ? evidenceFromRuns : [buildAssistantEvaluateFallbackEvidence(scope)];
    return {
      scopeType: "chapter",
      overallScore,
      dimensions,
      blockingIssues,
      evidence,
    };
  }

  function clampAssistantMetricsPercentage(numerator: number, denominator: number): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 1000) / 10));
  }

  function roundAssistantMetricsValue(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.round(value * 10) / 10;
  }

  function normalizeAssistantMetricsRange(
    rawRange: string | undefined,
  ): (typeof ASSISTANT_METRICS_DAY_RANGE_VALUES)[number] {
    const parsed = Number.parseInt(rawRange ?? "", 10);
    return parsed === 30 ? 30 : ASSISTANT_METRICS_DEFAULT_DAY_RANGE;
  }

  function buildAssistantMetricsDayKeys(
    rangeDays: (typeof ASSISTANT_METRICS_DAY_RANGE_VALUES)[number],
    now = Date.now(),
  ): string[] {
    const keys: string[] = [];
    const end = new Date(now);
    end.setUTCHours(0, 0, 0, 0);
    for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
      const day = new Date(end);
      day.setUTCDate(end.getUTCDate() - offset);
      keys.push(day.toISOString().slice(0, 10));
    }
    return keys;
  }

  function parseAssistantMetricsDayKey(timestamp: string | undefined | null): string | null {
    if (!timestamp) {
      return null;
    }
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().slice(0, 10);
  }

  function hasAssistantTaskManualIntervention(snapshot: AssistantTaskSnapshot): boolean {
    if (snapshot.retryContext) {
      const nextAction = snapshot.retryContext["nextAction"];
      if (typeof nextAction === "string" && nextAction.toLowerCase().includes("manual")) {
        return true;
      }
    }
    return Object.values(snapshot.nodes ?? {}).some((node) =>
      node.status === "waiting_approval" || node.type === "checkpoint");
  }

  function isAssistantTaskFirstSuccess(snapshot: AssistantTaskSnapshot): boolean {
    if (snapshot.status !== "succeeded") {
      return false;
    }
    const completedIterations = typeof snapshot.retryContext?.["completedIterations"] === "number"
      ? snapshot.retryContext["completedIterations"]
      : undefined;
    if (completedIterations !== undefined && completedIterations > 1) {
      return false;
    }
    const runIds = Array.isArray(snapshot.retryContext?.["runIds"])
      ? snapshot.retryContext?.["runIds"].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (runIds.length > 1) {
      return false;
    }
    return Object.values(snapshot.nodes ?? {}).every((node) => node.attempts <= 1);
  }

  function extractAssistantTokenConsumption(input: unknown, depth = 0): number {
    if (!input || typeof input !== "object" || Array.isArray(input) || depth > 3) {
      return 0;
    }
    const record = input as Record<string, unknown>;
    const directFields = ["totalTokens", "tokenConsumption", "tokensConsumed", "spentTokens"] as const;
    for (const field of directFields) {
      const value = record[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
    if (typeof record["spent"] === "number"
      && Number.isFinite(record["spent"])
      && record["spent"] >= 0
      && record["currency"] === "tokens") {
      return record["spent"];
    }
    const nestedKeys = ["usage", "tokenUsage", "budget", "metrics", "telemetry"] as const;
    for (const key of nestedKeys) {
      const nested = extractAssistantTokenConsumption(record[key], depth + 1);
      if (nested > 0) {
        return nested;
      }
    }
    if (Array.isArray(record["iterations"])) {
      const total = record["iterations"].reduce((sum, item) => sum + extractAssistantTokenConsumption(item, depth + 1), 0);
      if (total > 0) {
        return total;
      }
    }
    return 0;
  }

  function buildAssistantMetricsSummary(
    series: ReadonlyArray<AssistantMetricsPoint>,
  ): AssistantMetricsSummary {
    if (series.length === 0) {
      return {
        firstSuccessRate: 0,
        autoFixSuccessRate: 0,
        manualInterventionRate: 0,
        averageChapterScore: 0,
        tokenConsumption: 0,
        activeTasks: 0,
      };
    }
    const totals = series.reduce((acc, point) => ({
      firstSuccessRate: acc.firstSuccessRate + point.firstSuccessRate,
      autoFixSuccessRate: acc.autoFixSuccessRate + point.autoFixSuccessRate,
      manualInterventionRate: acc.manualInterventionRate + point.manualInterventionRate,
      averageChapterScore: acc.averageChapterScore + point.averageChapterScore,
      tokenConsumption: acc.tokenConsumption + point.tokenConsumption,
    }), {
      firstSuccessRate: 0,
      autoFixSuccessRate: 0,
      manualInterventionRate: 0,
      averageChapterScore: 0,
      tokenConsumption: 0,
    });
    const latest = series[series.length - 1];
    return {
      firstSuccessRate: roundAssistantMetricsValue(totals.firstSuccessRate / series.length),
      autoFixSuccessRate: roundAssistantMetricsValue(totals.autoFixSuccessRate / series.length),
      manualInterventionRate: roundAssistantMetricsValue(totals.manualInterventionRate / series.length),
      averageChapterScore: roundAssistantMetricsValue(totals.averageChapterScore / series.length),
      tokenConsumption: roundAssistantMetricsValue(totals.tokenConsumption),
      activeTasks: latest?.activeTasks ?? 0,
    };
  }

  async function listAssistantMetricsBookIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(root, "books"), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "zh-CN"))
        .slice(0, ASSISTANT_METRICS_BOOK_LIMIT);
    } catch {
      return [];
    }
  }

  async function buildAssistantMetricsResponse(
    rangeDays: (typeof ASSISTANT_METRICS_DAY_RANGE_VALUES)[number],
  ): Promise<AssistantMetricsResponse> {
    const dayKeys = buildAssistantMetricsDayKeys(rangeDays);
    const daySet = new Set(dayKeys);
    const dayBuckets = new Map(dayKeys.map((dayKey) => [dayKey, {
      firstSuccessNumerator: 0,
      firstSuccessDenominator: 0,
      autoFixNumerator: 0,
      autoFixDenominator: 0,
      manualInterventionCount: 0,
      manualInterventionDenominator: 0,
      chapterScoreTotal: 0,
      chapterScoreCount: 0,
      tokenConsumption: 0,
      activeTasks: new Set<string>(),
    }]));

    await assistantTaskSnapshotHydration;

    const recentSnapshots = [...assistantTaskSnapshots.values()]
      .sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt))
      .filter((snapshot) => {
        const dayKey = parseAssistantMetricsDayKey(snapshot.lastUpdatedAt);
        return dayKey !== null && daySet.has(dayKey);
      })
      .slice(0, ASSISTANT_METRICS_TASK_SNAPSHOT_LIMIT);

    recentSnapshots.forEach((snapshot) => {
      const dayKey = parseAssistantMetricsDayKey(snapshot.lastUpdatedAt);
      if (!dayKey) {
        return;
      }
      const bucket = dayBuckets.get(dayKey);
      if (!bucket) {
        return;
      }
      bucket.activeTasks.add(snapshot.taskId);
      const tokenConsumption = extractAssistantTokenConsumption(snapshot.retryContext);
      if (tokenConsumption > 0) {
        bucket.tokenConsumption += tokenConsumption;
      }
      if (snapshot.status === "succeeded" || snapshot.status === "failed") {
        bucket.firstSuccessDenominator += 1;
        bucket.manualInterventionDenominator += 1;
        if (isAssistantTaskFirstSuccess(snapshot)) {
          bucket.firstSuccessNumerator += 1;
        }
        if (hasAssistantTaskManualIntervention(snapshot)) {
          bucket.manualInterventionCount += 1;
        }
      }
    });

    const bookIds = await listAssistantMetricsBookIds();
    let totalRunsConsidered = 0;
    let runsTruncated = false;
    for (const bookId of bookIds) {
      if (totalRunsConsidered >= ASSISTANT_METRICS_TOTAL_RUN_LIMIT) {
        runsTruncated = true;
        break;
      }
      const runs = await chapterRunStore.listRuns(bookId, { limit: ASSISTANT_METRICS_RUN_LIMIT_PER_BOOK });
      if (runs.length === ASSISTANT_METRICS_RUN_LIMIT_PER_BOOK) {
        runsTruncated = true;
      }
      const dailyChapterRuns = new Map<string, Map<string, ChapterRunRecord[]>>();
      for (const run of runs) {
        if (totalRunsConsidered >= ASSISTANT_METRICS_TOTAL_RUN_LIMIT) {
          runsTruncated = true;
          break;
        }
        const dayKey = parseAssistantMetricsDayKey(run.finishedAt ?? run.startedAt);
        if (!dayKey || !daySet.has(dayKey)) {
          continue;
        }
        totalRunsConsidered += 1;
        const bucket = dayBuckets.get(dayKey);
        if (!bucket) {
          continue;
        }
        bucket.autoFixDenominator += 1;
        if (run.status === "succeeded" && run.decision === "applied") {
          bucket.autoFixNumerator += 1;
        }
        const chaptersForDay = dailyChapterRuns.get(dayKey) ?? new Map<string, ChapterRunRecord[]>();
        const chapterKey = `${run.bookId}:${run.chapter}`;
        const chapterRuns = chaptersForDay.get(chapterKey) ?? [];
        chapterRuns.push(run);
        chaptersForDay.set(chapterKey, chapterRuns);
        dailyChapterRuns.set(dayKey, chaptersForDay);
      }
      dailyChapterRuns.forEach((chaptersForDay, dayKey) => {
        const bucket = dayBuckets.get(dayKey);
        if (!bucket) {
          return;
        }
        chaptersForDay.forEach((chapterRuns) => {
          const score = deriveChapterAssistantEvaluateReport(chapterRuns, {
            type: "chapter",
            bookId,
            chapter: chapterRuns[0]?.chapter ?? 1,
          }).overallScore;
          bucket.chapterScoreTotal += score;
          bucket.chapterScoreCount += 1;
        });
      });
    }

    const series = dayKeys.map((dayKey) => {
      const bucket = dayBuckets.get(dayKey);
      return {
        date: dayKey,
        firstSuccessRate: clampAssistantMetricsPercentage(
          bucket?.firstSuccessNumerator ?? 0,
          bucket?.firstSuccessDenominator ?? 0,
        ),
        autoFixSuccessRate: clampAssistantMetricsPercentage(
          bucket?.autoFixNumerator ?? 0,
          bucket?.autoFixDenominator ?? 0,
        ),
        manualInterventionRate: clampAssistantMetricsPercentage(
          bucket?.manualInterventionCount ?? 0,
          bucket?.manualInterventionDenominator ?? 0,
        ),
        averageChapterScore: roundAssistantMetricsValue(
          (bucket?.chapterScoreCount ?? 0) > 0
            ? (bucket?.chapterScoreTotal ?? 0) / (bucket?.chapterScoreCount ?? 1)
            : 0,
        ),
        tokenConsumption: roundAssistantMetricsValue(bucket?.tokenConsumption ?? 0),
        activeTasks: bucket?.activeTasks.size ?? 0,
      } satisfies AssistantMetricsPoint;
    }).filter((point) =>
      point.firstSuccessRate > 0
      || point.autoFixSuccessRate > 0
      || point.manualInterventionRate > 0
      || point.averageChapterScore > 0
      || point.tokenConsumption > 0
      || point.activeTasks > 0);

    return {
      series,
      summary: buildAssistantMetricsSummary(series),
      meta: {
        generatedAt: new Date().toISOString(),
        rangeDays,
        taskSnapshotLimit: ASSISTANT_METRICS_TASK_SNAPSHOT_LIMIT,
        runLimitPerBook: ASSISTANT_METRICS_RUN_LIMIT_PER_BOOK,
        totalRunLimit: ASSISTANT_METRICS_TOTAL_RUN_LIMIT,
        booksScanned: bookIds.length,
        tasksConsidered: recentSnapshots.length,
        runsConsidered: totalRunsConsidered,
        truncated: recentSnapshots.length >= ASSISTANT_METRICS_TASK_SNAPSHOT_LIMIT || runsTruncated,
      },
    };
  }
  function normalizeAssistantEvaluateReport(raw: unknown): AssistantEvaluateReport | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const source = raw as Record<string, unknown>;
    const scopeType = source["scopeType"] === "chapter" || source["scopeType"] === "book"
      ? source["scopeType"]
      : null;
    if (!scopeType) return null;
    const dimensionsSource = source["dimensions"];
    const dimensions = typeof dimensionsSource === "object" && dimensionsSource !== null && !Array.isArray(dimensionsSource)
      ? Object.fromEntries(Object.entries(dimensionsSource).flatMap(([key, value]) =>
        typeof value === "number" && Number.isFinite(value)
          ? [[key, clampSerializableScore(value)]]
          : []))
      : {};
    const blockingIssues = Array.isArray(source["blockingIssues"])
      ? source["blockingIssues"].flatMap((issue) => typeof issue === "string" && issue.trim().length > 0 ? [issue.trim()] : [])
      : [];
    const evidence = Array.isArray(source["evidence"])
      ? source["evidence"].flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const evidenceItem = item as Record<string, unknown>;
        const sourceText = typeof evidenceItem["source"] === "string" ? evidenceItem["source"].trim() : "";
        const excerpt = normalizeEvaluateText(typeof evidenceItem["excerpt"] === "string" ? evidenceItem["excerpt"] : "");
        const reason = normalizeEvaluateText(typeof evidenceItem["reason"] === "string" ? evidenceItem["reason"] : "");
        if (!sourceText || !excerpt || !reason) return [];
        return [{ source: sourceText, excerpt, reason }];
      })
      : [];
    return {
      scopeType,
      overallScore: clampSerializableScore(typeof source["overallScore"] === "number" ? source["overallScore"] : Number.NaN),
      dimensions,
      blockingIssues,
      evidence: evidence.length > 0 ? evidence : [buildAssistantEvaluateFallbackEvidence(buildUnknownAssistantEvaluateScope(scopeType))],
      ...(source["cached"] === true ? { cached: true } : {}),
    };
  }

  async function loadAssistantBookEvaluateSource(
    bookId: string,
    fileName: string,
  ): Promise<AssistantBookEvaluateSourceText | null> {
    const filePath = join(state.bookDir(bookId), "story", fileName);
    try {
      const [content, info] = await Promise.all([
        readFile(filePath, "utf-8"),
        stat(filePath),
      ]);
      return {
        fileName,
        content,
        size: info.size,
        updatedAtMs: info.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  async function loadAssistantBookEvaluateChapterSamples(
    input: AssistantBookEvaluateInput,
  ): Promise<ReadonlyArray<AssistantBookEvaluateChapterSample>> {
    const chaptersDir = join(state.bookDir(input.bookId), "chapters");
    let files: string[] = [];
    try {
      files = (await readdir(chaptersDir))
        .filter((file) => /^\d+_.+\.md$/u.test(file))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      return [];
    }
    const results: AssistantBookEvaluateChapterSample[] = [];
    const requestedRunIds = input.runIds ?? [];
    for (let index = 0; index < files.length; index += ASSISTANT_BOOK_EVALUATE_BATCH_SIZE) {
      const batch = files.slice(index, index + ASSISTANT_BOOK_EVALUATE_BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (fileName) => {
        const underscoreIndex = fileName.indexOf("_");
        if (underscoreIndex === -1) return null;
        const chapter = Number.parseInt(fileName.slice(0, underscoreIndex), 10);
        if (!Number.isInteger(chapter) || chapter < 1) return null;
        const filePath = join(chaptersDir, fileName);
        let content = "";
        try {
          content = await readFile(filePath, "utf-8");
        } catch {
          content = "";
        }
        const normalizedSnippet = normalizeEvaluateText(
          content
            .replace(/^#.*$/gmu, "")
            .replace(/\s+/gu, " "),
          ASSISTANT_BOOK_EVALUATE_SNIPPET_MAX_LENGTH,
        );
        const wordCount = content.trim().length;
        const chapterRuns = await chapterRunStore.listRuns(input.bookId, { chapter, limit: 8 });
        const latestRun = requestedRunIds.length > 0
          ? chapterRuns.find((run) => requestedRunIds.includes(run.runId)) ?? null
          : chapterRuns[0] ?? null;
        return {
          chapter,
          fileName,
          snippet: normalizedSnippet || `第${chapter}章暂无可提取正文片段。`,
          wordCount,
          normalizedSnippet,
          latestRun,
        } satisfies AssistantBookEvaluateChapterSample;
      }));
      results.push(...batchResults.flatMap((item) => item ? [item] : []));
    }
    return results.sort((left, right) => left.chapter - right.chapter);
  }

  function buildAssistantBookEvaluateCacheKey(input: {
    readonly storySources: ReadonlyArray<AssistantBookEvaluateSourceText>;
    readonly chapters: ReadonlyArray<AssistantBookEvaluateChapterSample>;
  }): string {
    return JSON.stringify({
      v: 2,
      story: input.storySources.map((source) => [source.fileName, source.size, Math.round(source.updatedAtMs)]),
      chapters: input.chapters.map((chapter) => [
        chapter.chapter,
        chapter.wordCount,
        chapter.latestRun?.runId ?? null,
        chapter.latestRun?.status ?? null,
        chapter.latestRun?.decision ?? null,
      ]),
    });
  }

  function deriveBookAssistantEvaluateReport(
    scope: AssistantEvaluateScopeBook,
    chapters: ReadonlyArray<AssistantBookEvaluateChapterSample>,
    storySources: ReadonlyArray<AssistantBookEvaluateSourceText>,
  ): AssistantEvaluateReport {
    const storyBible = storySources.find((item) => item.fileName === "story_bible.md") ?? null;
    const characterMatrix = storySources.find((item) => item.fileName === "character_matrix.md") ?? null;
    const pendingHooks = storySources.find((item) => item.fileName === "pending_hooks.md") ?? null;
    const volumeOutline = storySources.find((item) => item.fileName === "volume_outline.md") ?? null;
    const runs = chapters.flatMap((chapter) => chapter.latestRun ? [chapter.latestRun] : []);
    const failedRuns = runs.filter((run) => run.status === "failed").length;
    const unchangedRuns = runs.filter((run) => run.decision === "unchanged").length;
    const appliedRuns = runs.filter((run) => run.decision === "applied").length;
    const chapterWordCounts = chapters.map((chapter) => chapter.wordCount).filter((value) => value > 0);
    const coverage = chapters.length > 0 ? runs.length / chapters.length : 0;
    const duplicateCount = Math.max(0, chapters.length - new Set(
      chapters
        .map((chapter) => chapter.normalizedSnippet)
        .filter((snippet) => snippet.length > 0),
    ).size);
    const duplicateRatio = chapters.length > 0 ? duplicateCount / chapters.length : 0;
    const variation = coefficientOfVariation(chapterWordCounts);
    const hookCount = normalizeEvaluateText(pendingHooks?.content, 1000)
      .split(/[\n•\-]/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 3)
      .length;
    const dimensions: AssistantEvaluateDimensions = {
      mainline: clampSerializableScore(58 + (storyBible ? 18 : -10) + (volumeOutline ? 10 : 0) + coverage * 12 - failedRuns * 8),
      character: clampSerializableScore(56 + (characterMatrix ? 18 : -10) + Math.min(12, chapters.length * 2) - failedRuns * 5),
      foreshadowing: clampSerializableScore(52 + (pendingHooks ? 24 : -6) + Math.min(10, hookCount * 2) - Math.max(0, hookCount - 5) * 4),
      repetition: clampSerializableScore(88 - duplicateRatio * 55 - unchangedRuns * 4),
      style: clampSerializableScore(72 + Math.max(0, 10 - Math.abs(variation - 0.22) * 60) - failedRuns * 4),
      pacing: clampSerializableScore(70 + coverage * 12 - Math.max(0, variation - 0.45) * 30 - unchangedRuns * 3),
    };
    const dimensionValues = Object.values(dimensions).filter((value): value is number => value !== undefined);
    const overallScore = clampSerializableScore(
      dimensionValues.length > 0
        ? dimensionValues.reduce((sum, value) => sum + value, 0) / dimensionValues.length
        : 0,
    );
    const seenSnippets = new Set<string>();
    const repeatedChapter = chapters.find((chapter) => {
      if (!chapter.normalizedSnippet) return false;
      if (seenSnippets.has(chapter.normalizedSnippet)) {
        return true;
      }
      seenSnippets.add(chapter.normalizedSnippet);
      return false;
    }) ?? null;
    const lastChapter = chapters.at(-1);
    const evidence: AssistantEvaluateEvidence[] = [
      {
        source: storyBible ? `book-story:${scope.bookId}:story_bible.md` : `book:${scope.bookId}:chapters`,
        excerpt: normalizeEvaluateText(storyBible?.content ?? chapters[0]?.snippet ?? "暂无主线材料。", 500),
        reason: storyBible
          ? `主线评估基于 story_bible.md，并结合 ${chapters.length} 章的章节覆盖率 ${Math.round(coverage * 100)}%。`
          : "缺少 story_bible.md，主线分数退回到章节片段估算。",
      },
      {
        source: characterMatrix ? `book-story:${scope.bookId}:character_matrix.md` : `book:${scope.bookId}:chapters`,
        excerpt: normalizeEvaluateText(characterMatrix?.content ?? chapters.at(-1)?.snippet ?? "暂无角色矩阵材料。", 600),
        reason: characterMatrix
          ? "角色评分优先依据 character_matrix.md，并用章节样本校验人物行动是否持续出现。"
          : "缺少角色矩阵，仅能从章节正文推断角色连贯性。",
      },
      {
        source: pendingHooks ? `book-story:${scope.bookId}:pending_hooks.md` : `book:${scope.bookId}:chapters`,
        excerpt: normalizeEvaluateText(pendingHooks?.content ?? chapters[Math.max(0, Math.floor(chapters.length / 2))]?.snippet ?? "暂无伏笔材料。", 500),
        reason: pendingHooks
          ? `伏笔评分依据 pending_hooks.md 中识别出的 ${hookCount} 条钩子项。`
          : "缺少 pending_hooks.md，伏笔分数按正文估算。",
      },
      {
        source: repeatedChapter ? `book-chapter:${scope.bookId}:${repeatedChapter.chapter}` : `book:${scope.bookId}:chapters`,
        excerpt: repeatedChapter?.snippet ?? "章节片段重复率较低。",
        reason: duplicateCount > 0
          ? `检测到 ${duplicateCount} 章存在高重复片段，重复度评分已下调。`
          : "章节片段重复率较低，重复度评分保持稳定。",
      },
      {
        source: chapters[0] ? `book-chapter:${scope.bookId}:${chapters[0].chapter}` : `book:${scope.bookId}`,
        excerpt: chapters[0]?.snippet ?? "暂无章节风格样本。",
        reason: `风格评分结合章节字数波动系数 ${variation.toFixed(2)} 与 ${appliedRuns} 次已应用修订结果。`,
      },
      {
        source: lastChapter ? `book-chapter:${scope.bookId}:${lastChapter.chapter}` : `book:${scope.bookId}`,
        excerpt: lastChapter?.snippet ?? "暂无节奏样本。",
        reason: `节奏评分结合 ${chapters.length} 章样本、${runs.length} 条最新运行记录与章节长度离散度。`,
      },
    ];
    const blockingIssues = [
      ...(!storyBible ? ["缺少全书主线基线（story_bible.md），全书评估可信度受限。"] : []),
      ...(!characterMatrix ? ["缺少角色矩阵（character_matrix.md），角色线难以校验。"] : []),
      ...(hookCount > Math.max(12, chapters.length * 5) ? [`待回收伏笔较多（${hookCount} 条），建议先梳理 pending_hooks.md。`] : []),
      ...(duplicateRatio >= 0.25 ? [`章节片段重复率约 ${Math.round(duplicateRatio * 100)}%，建议去重并拉开桥段差异。`] : []),
      ...(failedRuns > 0 ? [`最新章节运行中有 ${failedRuns} 条失败记录，需先处理阻断问题。`] : []),
    ];
    return {
      scopeType: "book",
      overallScore,
      dimensions,
      blockingIssues,
      evidence: evidence.slice(0, 6),
    };
  }

  async function deriveAssistantBookEvaluateReport(
    scope: AssistantEvaluateScopeBook,
    runIds: ReadonlyArray<string>,
  ): Promise<AssistantEvaluateReport> {
    const storySources = (await Promise.all([
      loadAssistantBookEvaluateSource(scope.bookId, "story_bible.md"),
      loadAssistantBookEvaluateSource(scope.bookId, "volume_outline.md"),
      loadAssistantBookEvaluateSource(scope.bookId, "character_matrix.md"),
      loadAssistantBookEvaluateSource(scope.bookId, "pending_hooks.md"),
    ])).flatMap((item) => item ? [item] : []);
    const chapters = await loadAssistantBookEvaluateChapterSamples({
      bookId: scope.bookId,
      ...(runIds.length > 0 ? { runIds } : {}),
    });
    if (chapters.length === 0 && storySources.length === 0) {
      return {
        scopeType: "book",
        overallScore: 0,
        dimensions: {
          mainline: 0,
          character: 0,
          foreshadowing: 0,
          repetition: 0,
          style: 0,
          pacing: 0,
        },
        blockingIssues: ["当前书籍暂无可用于全书评估的章节或故事材料。"],
        evidence: [buildAssistantEvaluateFallbackEvidence(scope)],
      };
    }
    const cacheKey = buildAssistantBookEvaluateCacheKey({ storySources, chapters });
    const existingMemory = runIds.length === 0
      ? await assistantMemoryService.readMemory("book", { bookId: scope.bookId })
      : { memory: null };
    const existingData = existingMemory.memory?.data;
    const qualitySnapshots = existingData && typeof existingData === "object" && !Array.isArray(existingData)
      ? (existingData as Record<string, unknown>)["qualitySnapshots"]
      : null;
    const bookSnapshot = qualitySnapshots && typeof qualitySnapshots === "object" && !Array.isArray(qualitySnapshots)
      ? (qualitySnapshots as Record<string, unknown>)["book"]
      : null;
    if (runIds.length === 0 && bookSnapshot && typeof bookSnapshot === "object" && !Array.isArray(bookSnapshot)) {
      const cachedKey = typeof (bookSnapshot as Record<string, unknown>)["cacheKey"] === "string"
        ? (bookSnapshot as Record<string, unknown>)["cacheKey"] as string
        : "";
      const cachedReport = normalizeAssistantEvaluateReport((bookSnapshot as Record<string, unknown>)["report"]);
      if (cachedKey === cacheKey && cachedReport) {
        return { ...cachedReport, cached: true };
      }
    }
    const report = deriveBookAssistantEvaluateReport(scope, chapters, storySources);
    if (runIds.length === 0) {
      const previousData = existingData && typeof existingData === "object" && !Array.isArray(existingData)
        ? existingData as Record<string, unknown>
        : {};
      const previousSnapshots = previousData["qualitySnapshots"] && typeof previousData["qualitySnapshots"] === "object" && !Array.isArray(previousData["qualitySnapshots"])
        ? previousData["qualitySnapshots"] as Record<string, unknown>
        : {};
      await assistantMemoryService.writeMemory("book", {
        ...previousData,
        qualitySnapshots: {
          ...previousSnapshots,
          book: {
            cacheKey,
            report,
            updatedAt: new Date().toISOString(),
          },
        },
      }, { bookId: scope.bookId });
    }
    return report;
  }

  async function deriveAssistantEvaluateReport(
    runs: ReadonlyArray<ChapterRunRecord>,
    scope: AssistantEvaluateScope,
    runIds: ReadonlyArray<string>,
  ): Promise<AssistantEvaluateReport> {
    if (scope.type === "book") {
      return await deriveAssistantBookEvaluateReport(scope, runIds);
    }
    return deriveChapterAssistantEvaluateReport(runs, scope);
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

  function clampParallelCandidates(value: number | undefined): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.min(3, Math.trunc(value ?? 1)));
  }

  function buildAssistantCandidateSnapshot(
    nodeId: string,
    index: number,
    run: ChapterRunRecord,
    scope: AssistantEvaluateScope,
  ): AssistantTaskCandidateSnapshot {
    const report = deriveChapterAssistantEvaluateReport(
      [run],
      scope.type === "chapter"
        ? scope
        : { type: "chapter", bookId: scope.bookId, chapter: run.chapter },
    );
    const candidateRevision = extractCandidateRevision(run);
    const diff = parseDiffData(run);
    return {
      candidateId: `${nodeId}:c${index + 1}`,
      runId: run.runId,
      score: report.overallScore,
      status: run.status === "failed" ? "failed" : "succeeded",
      ...(run.decision !== undefined ? { decision: run.decision } : {}),
      excerpt: (candidateRevision?.content ?? diff.afterContent ?? run.unchangedReason ?? run.error ?? `${run.actionType} ${run.status}`).slice(0, 240),
      evidence: report.evidence.slice(0, 3),
      pendingApproval: diff.pendingApproval,
      ...(run.error ? { error: run.error } : {}),
      ...(candidateRevision ? { candidateRevision } : {}),
    };
  }

  function pickWinningAssistantCandidate(
    candidates: ReadonlyArray<AssistantTaskCandidateSnapshot>,
  ): AssistantTaskCandidateSnapshot | null {
    const ranked = [...candidates]
      .filter((candidate) => candidate.status === "succeeded")
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.candidateId.localeCompare(right.candidateId);
      });
    return ranked[0] ?? null;
  }

  function updateAssistantTaskNodeCandidateDecision(
    taskId: string,
    nodeId: string,
    candidateDecision: AssistantCandidateDecisionSnapshot,
    options?: {
      readonly nodeStatus?: TaskNodeStatus;
      readonly awaitingApproval?: AssistantTaskAwaitingApproval | null;
      readonly error?: string;
    },
  ): void {
    const previous = assistantTaskSnapshots.get(taskId);
    if (!previous) {
      return;
    }
    const previousNode = previous.nodes?.[nodeId];
    const nextNodes = {
      ...(previous.nodes ?? {}),
      [nodeId]: {
        nodeId,
        type: previousNode?.type ?? "task",
        ...(previousNode?.action ? { action: previousNode.action } : {}),
        ...(previousNode?.runId ? { runId: previousNode.runId } : {}),
        status: options?.nodeStatus ?? previousNode?.status ?? "running",
        parallelCandidates: candidateDecision.candidates.length,
        attempts: previousNode?.attempts ?? 1,
        maxRetries: previousNode?.maxRetries ?? 0,
        ...(previousNode?.startedAt ? { startedAt: previousNode.startedAt } : {}),
        ...(previousNode?.finishedAt ? { finishedAt: previousNode.finishedAt } : {}),
        ...(previousNode?.error ? { error: previousNode.error } : {}),
        ...(previousNode?.checkpoint ? { checkpoint: previousNode.checkpoint } : {}),
        ...(previousNode?.steeringContract ? { steeringContract: previousNode.steeringContract } : {}),
        ...(previousNode?.blueprint ? { blueprint: previousNode.blueprint } : {}),
        ...(previousNode?.sourceArtifactIds && previousNode.sourceArtifactIds.length > 0 ? { sourceArtifactIds: previousNode.sourceArtifactIds } : {}),
        candidateDecision,
      } satisfies AssistantTaskNodeSnapshot,
    };
    assistantTaskSnapshots.set(taskId, {
      ...previous,
      status: "running",
      currentStepId: nodeId,
      nodes: nextNodes,
      lastUpdatedAt: new Date().toISOString(),
      ...(options?.error ? { error: options.error } : previous.error ? { error: previous.error } : {}),
      ...(options?.awaitingApproval === undefined
        ? previous.awaitingApproval ? { awaitingApproval: previous.awaitingApproval } : {}
        : options.awaitingApproval ? { awaitingApproval: options.awaitingApproval } : {}),
    });
    scheduleAssistantTaskSnapshotPersistence();
  }

  async function approveAssistantCandidateRun(
    bookId: string,
    runId: string,
    message: string,
  ): Promise<void> {
    const run = await chapterRunStore.getRun(bookId, runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    if (run.status !== "succeeded" || run.decision !== "unchanged") {
      return;
    }
    const candidate = extractCandidateRevision(run);
    if (!candidate) {
      return;
    }
    await applyApprovedCandidateRevision({
      bookId,
      chapterNumber: run.chapter,
      candidate,
    });
    const diff = parseDiffData(run);
    await completeChapterRun({
      bookId,
      runId,
      status: "succeeded",
      decision: "applied",
      unchangedReason: null,
      message,
      data: {
        beforeContent: diff.beforeContent,
        afterContent: candidate.content,
        briefTrace: diff.briefTrace,
        approvedFromUnchangedRun: true,
      },
    });
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

  async function recordLengthNormalizationVersionRuns(
    bookId: string,
    chapterNumber: number,
    snapshots: ReadonlyArray<LengthNormalizationSnapshot> | undefined,
  ): Promise<void> {
    const visibleSnapshots = (snapshots ?? []).filter((snapshot) =>
      snapshot.beforeContent.trim().length > 0
      && snapshot.afterContent.trim().length > 0
      && snapshot.beforeContent.trim() !== snapshot.afterContent.trim()
    );
    for (const snapshot of visibleSnapshots) {
      try {
        const applied = snapshot.applied;
        const label = applied
          ? `审计前字数归一化 ${snapshot.beforeCount} -> ${snapshot.afterCount}`
          : `字数归一化候选（未应用） ${snapshot.beforeCount} -> ${snapshot.afterCount}`;
        const run = await chapterRunStore.createRun({
          bookId,
          chapter: chapterNumber,
          actionType: "length-normalize",
          appliedBrief: label,
        });
        await completeChapterRun({
          bookId,
          runId: run.runId,
          status: "succeeded",
          decision: "applied",
          data: {
            beforeContent: snapshot.beforeContent,
            afterContent: snapshot.afterContent,
            lengthNormalization: {
              stage: snapshot.stage,
              mode: snapshot.mode,
              beforeCount: snapshot.beforeCount,
              afterCount: snapshot.afterCount,
              applied,
              rejectedReason: snapshot.rejectedReason,
            },
          },
        });
        broadcast("chapter:version:created", {
          bookId,
          chapterNumber,
          versionId: run.runId,
          actionType: "length-normalize",
          label,
          applied,
          beforeCount: snapshot.beforeCount,
          afterCount: snapshot.afterCount,
          rejectedReason: snapshot.rejectedReason,
        });
      } catch {
        // Best-effort transparency record; never fail the write itself.
      }
    }
  }

  async function recordReviewSnapshotVersionRuns(
    bookId: string,
    chapterNumber: number,
    snapshots: ReadonlyArray<ChapterReviewSnapshot> | undefined,
  ): Promise<void> {
    const visibleSnapshots = (snapshots ?? [])
      .filter((snapshot) => snapshot.content.trim().length > 0)
      .filter((snapshot, index, all) =>
        index === all.findIndex((item) => item.stage === snapshot.stage && item.content.trim() === snapshot.content.trim())
      );
    for (const snapshot of visibleSnapshots) {
      try {
        const label = snapshot.stage === "writer-output"
          ? `Writer 原始稿（${snapshot.wordCount}）`
          : `审计前版本（${snapshot.wordCount}）`;
        const run = await chapterRunStore.createRun({
          bookId,
          chapter: chapterNumber,
          actionType: "pipeline-snapshot",
          appliedBrief: label,
        });
        await completeChapterRun({
          bookId,
          runId: run.runId,
          status: "succeeded",
          decision: "applied",
          data: {
            beforeContent: snapshot.content,
            afterContent: snapshot.content,
            pipelineSnapshot: {
              stage: snapshot.stage,
              wordCount: snapshot.wordCount,
            },
          },
        });
        broadcast("chapter:version:created", {
          bookId,
          chapterNumber,
          versionId: run.runId,
          actionType: "pipeline-snapshot",
          label,
          applied: true,
          beforeCount: snapshot.wordCount,
          afterCount: snapshot.wordCount,
        });
      } catch {
        // Best-effort transparency record; never fail the write itself.
      }
    }
  }

  // --- Books ---

  app.get("/api/books", async (c) => {
    const bookIds = await state.listBooks();
    const entries = await Promise.all(
      bookIds.map(async (id) => {
        try {
          const book = await state.loadBookConfig(id);
          const nextChapter = await state.getNextChapterNumber(id);
          return { ok: true as const, book: { ...book, chaptersWritten: nextChapter - 1 } };
        } catch (error) {
          return {
            ok: false as const,
            id,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const books = entries.filter((entry) => entry.ok).map((entry) => entry.book);
    const failed = entries.filter((entry) => !entry.ok).map((entry) => ({ id: entry.id, error: entry.error }));
    if (failed.length > 0) {
      return c.json({ books, warnings: failed });
    }
    return c.json({ books });
  });

  app.get("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const book = await loadBookConfigWithReleaseCandidateState(id);
      const chapters = await state.loadChapterIndex(id);
      const nextChapter = await state.getNextChapterNumber(id);
      return c.json({ book, chapters, nextChapter });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.get("/api/books/:id/story-graph", async (c) => {
    const id = c.req.param("id");
    try {
      const book = await loadBookConfigWithReleaseCandidateState(id);
      const chapters = await state.loadChapterIndex(id);
      const bookDir = state.bookDir(id);
      const truthFiles: Record<string, string> = {};
      const storyDir = join(bookDir, "story");
      const graphSourceFiles = [
        "author_intent.md",
        "story_bible.md",
        "volume_outline.md",
        "book_rules.md",
        "current_state.md",
        "current_focus.md",
        "pending_hooks.md",
        "chapter_summaries.md",
        "subplot_board.md",
        "emotional_arcs.md",
        "character_matrix.md",
        "style_guide.md",
        "style_profile.json",
        "parent_canon.md",
        "fanfic_canon.md",
      ];

      await Promise.all(graphSourceFiles.map(async (file) => {
        try {
          truthFiles[file] = await readFile(join(storyDir, file), "utf-8");
        } catch {
          truthFiles[file] = "";
        }
      }));

      const graph = buildStoryGraph({
        bookId: id,
        title: typeof book.title === "string" ? book.title : id,
        chapters: chapters.map((chapter) => ({
          number: chapter.number,
          title: chapter.title,
          status: chapter.status,
          wordCount: chapter.wordCount,
        })),
        truthFiles,
      });

      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "story_graph.json"), JSON.stringify(graph, null, 2), "utf-8");

      return c.json({ graph });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.get("/api/books/:id/release-candidate/evaluate", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await buildReleaseCandidateEvaluation(id, c.req.query("manualConfirmed") === "true"));
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.post("/api/books/:id/release-candidate/mark", async (c) => {
    const id = c.req.param("id");
    const requestBody = await c.req.json<unknown>().catch(() => null);
    const manualConfirmed = typeof requestBody === "object" && requestBody !== null && !Array.isArray(requestBody)
      ? (requestBody as Record<string, unknown>).manualConfirmed === true
      : false;
    try {
      const evaluation = await buildReleaseCandidateEvaluation(id, manualConfirmed);
      if (!evaluation.eligible) {
        return c.json({
          error: {
            code: "RELEASE_CANDIDATE_GATE_BLOCKED",
            message: "Release candidate gates are not satisfied.",
            evaluation,
          },
        }, 409);
      }
      const book = await writeBookReleaseCandidateState(id, true);
      return c.json({
        ok: true,
        book,
        evaluation: {
          ...evaluation,
          isReleaseCandidate: true,
        },
      });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.post("/api/books/:id/release-candidate/cancel", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json({
        ok: true,
        book: await writeBookReleaseCandidateState(id, false),
      });
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
      chapterLengthTolerancePercent?: number;
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
    const confirmedChapterBlueprint = parseConfirmedChapterBlueprint(steeringInput.blueprint);
    const directBrief = normalizeBriefValue((steeringInput as { brief?: unknown }).brief);
    const planBrief = normalizeBriefValue(planInput);
    const hasStructuredSteering = Boolean(
      directBrief !== undefined
      || planBrief !== undefined
      || steeringInput.chapterGoal
      || (steeringInput.mustInclude && steeringInput.mustInclude.length > 0)
      || (steeringInput.mustAvoid && steeringInput.mustAvoid.length > 0)
      || steeringInput.pace
      || steeringInput.steeringContract
      || steeringInput.blueprint
      || (steeringInput.sourceArtifactIds && steeringInput.sourceArtifactIds.length > 0),
    );
    const briefUsed = hasStructuredSteering;
    const chapterNumber = await resolveNextChapterNumber(id);

    // Pre-write: merge narrative graph patches into steering
    let mergedMustInclude = [...(steeringInput.mustInclude ?? [])];
    let mergedMustAvoid = [...(steeringInput.mustAvoid ?? [])];
    let mergedSceneBeats = [
      ...(steeringInput.steeringContract?.sceneBeats ?? []),
      ...buildBlueprintVerificationSceneBeats(confirmedChapterBlueprint),
    ];
    let mergedSourceArtifactIds = [...(steeringInput.sourceArtifactIds ?? [])];
    // Track graph-derived items separately so we can do conditional patch consumption
    let graphDerivedPatchIds: string[] = [];
    let graphDerivedPatchRequirements: PatchRequirements[] = [];
    try {
      const unconsumedPatches = await narrativeGraphService.getUnconsumedPatches(id);
      if (unconsumedPatches.length > 0) {
        const graphSteering = compileGraphPatchesToSteering(unconsumedPatches);
        mergedMustInclude = [...mergedMustInclude, ...graphSteering.mustInclude];
        mergedMustAvoid = [...mergedMustAvoid, ...graphSteering.mustAvoid];
        mergedSceneBeats = [...mergedSceneBeats, ...graphSteering.sceneBeats];
        mergedSourceArtifactIds = [...mergedSourceArtifactIds, ...graphSteering.sourcePatchIds];
        graphDerivedPatchIds = [...graphSteering.sourcePatchIds];
        graphDerivedPatchRequirements = [...graphSteering.patchRequirements];
      }
    } catch { /* best-effort */ }

    // Build effective steeringInput with merged values
    const effectiveSteeringInput = {
      ...steeringInput,
      mustInclude: mergedMustInclude.length > 0 ? mergedMustInclude : undefined,
      mustAvoid: mergedMustAvoid.length > 0 ? mergedMustAvoid : undefined,
      sourceArtifactIds: mergedSourceArtifactIds.length > 0 ? mergedSourceArtifactIds : undefined,
      blueprint: confirmedChapterBlueprint,
      steeringContract: steeringInput.steeringContract
        ? { ...steeringInput.steeringContract, sceneBeats: mergedSceneBeats, mustInclude: mergedMustInclude, mustAvoid: mergedMustAvoid }
        : mergedMustInclude.length > 0 || mergedMustAvoid.length > 0 || mergedSceneBeats.length > 0
          ? { mustInclude: mergedMustInclude, mustAvoid: mergedMustAvoid, sceneBeats: mergedSceneBeats, priority: "normal" as const }
          : undefined,
    };
    const resolvePlanOrFallbackChapterNumber = (plan: { chapterNumber?: unknown }): number | undefined =>
      typeof plan.chapterNumber === "number" ? plan.chapterNumber : chapterNumber;
    emitActionEvent("write-next", "start", {
      bookId: id,
      chapterNumber,
      briefUsed,
    });

    // Shared SSE callbacks used by all mode branches.
    type WriteResult = {
      chapterNumber: number;
      status: string;
      title: string;
      wordCount: number;
      lengthNormalizationSnapshots?: ReadonlyArray<LengthNormalizationSnapshot>;
      reviewSnapshots?: ReadonlyArray<ChapterReviewSnapshot>;
    };
    const onWriteComplete = async (result: WriteResult): Promise<void> => {
      const baseDetails = { status: result.status, title: result.title, wordCount: result.wordCount };
      const hasContract = Boolean(effectiveSteeringInput.steeringContract || effectiveSteeringInput.blueprint || (effectiveSteeringInput.mustInclude && effectiveSteeringInput.mustInclude.length > 0) || mergedSceneBeats.length > 0);
      // Emit compose:success synchronously; write-next:success includes verification metadata.
      emitActionEvent("compose", "success", { bookId: id, chapterNumber: result.chapterNumber, briefUsed, details: baseDetails });
      // Success payload includes steering metadata so the frontend can display intent context
      // before the async verification report arrives via write-next:verification.
      emitActionEvent("write-next", "success", {
        bookId: id,
        chapterNumber: result.chapterNumber,
        briefUsed,
        details: {
          ...baseDetails,
          sourceArtifactIds: mergedSourceArtifactIds.length > 0 ? mergedSourceArtifactIds : undefined,
          verificationPending: hasContract,
        },
      });
      const chapterSnippet = await readLatestChapterSnippet(id, result.chapterNumber);
      await recordReviewSnapshotVersionRuns(id, result.chapterNumber, result.reviewSnapshots);
      await recordLengthNormalizationVersionRuns(id, result.chapterNumber, result.lengthNormalizationSnapshots);
      if (chapterSnippet) {
        await refreshBookMemory(id, result.chapterNumber, "write-next", baseDetails, chapterSnippet);
      }
      // Post-success: verification + selective graph patch consumption (best-effort)
      if (hasContract) {
        const sessId = typeof rawBody === "object" && rawBody !== null && typeof (rawBody as Record<string, unknown>)?.sessionId === "string" ? (rawBody as Record<string, unknown>).sessionId as string : "";
        // Build a fallback graphPatchConsumption with all patches as pending (used on error paths)
        const buildEmptyPatchConsumption = (): GraphPatchConsumption => ({
          patches: graphDerivedPatchIds.map((patchId) => ({ patchId, status: "pending" as const, reason: "验证未执行", satisfiedRequirements: [], missingRequirements: [] })),
          consumed: [],
          pending: [...graphDerivedPatchIds],
          partiallyConsumed: [],
        });
        try {
          const fullContent = await readChapterContentSnapshot(id, result.chapterNumber) ?? chapterSnippet;
          if (!fullContent) {
            broadcast("write-next:verification", {
              bookId: id,
              chapterNumber: result.chapterNumber,
              report: { satisfactionRate: 0, items: [], shouldRewrite: true },
              contractSatisfaction: 0,
              satisfiedRequirements: [],
              missingRequirements: [],
              sourceArtifactIds: mergedSourceArtifactIds,
              graphPatchConsumption: buildEmptyPatchConsumption(),
              warning: "无法读取完整章节内容，验证跳过",
            });
            return;
          }
          const contract = effectiveSteeringInput.steeringContract ?? { mustInclude: effectiveSteeringInput.mustInclude ?? [], mustAvoid: effectiveSteeringInput.mustAvoid ?? [], sceneBeats: [] as string[] };
          const report = verifyContractSatisfaction({ chapterText: fullContent, mustInclude: contract.mustInclude ?? [], mustAvoid: contract.mustAvoid ?? [], sceneBeats: contract.sceneBeats ?? [], goal: contract.goal });

          // Per-patch granular consumption with sceneBeats-only support
          const graphPatchConsumption: GraphPatchConsumption = { patches: [], consumed: [], pending: [], partiallyConsumed: [] };
          if (graphDerivedPatchRequirements.length > 0) {
            for (const pr of graphDerivedPatchRequirements) {
              const isSceneBeatsOnly = pr.mustInclude.length === 0 && pr.mustAvoid.length === 0 && pr.sceneBeats.length > 0;
              let status: "consumed" | "pending" | "partially_consumed";
              let satisfiedRequirements: string[];
              let missingRequirements: string[];
              let reason: string;
              if (isSceneBeatsOnly) {
                // Soft evidence: sceneBeats must appear in verification report
                const satisfiedBeats = pr.sceneBeats.filter((beat) =>
                  report.items.some((item) => item.requirement.includes(beat) && item.status !== "missing"),
                );
                const missingBeats = pr.sceneBeats.filter((beat) =>
                  !report.items.some((item) => item.requirement.includes(beat) && item.status !== "missing"),
                );
                satisfiedRequirements = satisfiedBeats;
                missingRequirements = missingBeats;
                if (satisfiedBeats.length === 0) {
                  status = "pending";
                  reason = "场景节拍未在章节中体现";
                } else if (missingBeats.length === 0) {
                  status = "consumed";
                  reason = "所有场景节拍已体现";
                } else {
                  status = "partially_consumed";
                  reason = `部分场景节拍已体现（${satisfiedBeats.length}/${pr.sceneBeats.length}）`;
                }
              } else {
                // Hard requirements: mustInclude must be satisfied AND mustAvoid must not be violated
                const satisfiedHard = pr.mustInclude.filter((req) =>
                  report.items.some((item) => item.requirement.includes(req) && item.status !== "missing"),
                );
                const missingHard = pr.mustInclude.filter((req) =>
                  !report.items.some((item) => item.requirement.includes(req) && item.status !== "missing"),
                );
                // mustAvoid: status="missing" in report means the avoid was violated (bad)
                const violatedAvoid = pr.mustAvoid.filter((avoidItem) =>
                  report.items.some((item) => item.requirement.includes(avoidItem) && item.status === "missing"),
                );
                const honoredAvoid = pr.mustAvoid.filter((avoidItem) =>
                  !report.items.some((item) => item.requirement.includes(avoidItem) && item.status === "missing"),
                );
                satisfiedRequirements = [...satisfiedHard, ...honoredAvoid];
                missingRequirements = [...missingHard, ...violatedAvoid];
                if (missingRequirements.length === 0) {
                  status = "consumed";
                  reason = "所有硬性要求已满足";
                } else if (satisfiedRequirements.length > 0) {
                  status = "partially_consumed";
                  const totalReqs = pr.mustInclude.length + pr.mustAvoid.length;
                  reason = `部分硬性要求已满足（${satisfiedRequirements.length}/${totalReqs}）`;
                } else {
                  status = "pending";
                  reason = violatedAvoid.length > 0 && missingHard.length === 0
                    ? `mustAvoid 被违反：${violatedAvoid.slice(0, 2).join("；")}`
                    : "硬性要求未满足";
                }
              }
              graphPatchConsumption.patches.push({ patchId: pr.patchId, status, reason, satisfiedRequirements, missingRequirements });
              if (status === "consumed") graphPatchConsumption.consumed.push(pr.patchId);
              else if (status === "partially_consumed") graphPatchConsumption.partiallyConsumed.push(pr.patchId);
              else graphPatchConsumption.pending.push(pr.patchId);
            }
          } else if (graphDerivedPatchIds.length > 0) {
            for (const patchId of graphDerivedPatchIds) {
              graphPatchConsumption.patches.push({ patchId, status: "pending", reason: "无详细需求信息", satisfiedRequirements: [], missingRequirements: [] });
              graphPatchConsumption.pending.push(patchId);
            }
          }

          // Mark consumed and partially-consumed patches in the graph service
          for (const patchId of graphPatchConsumption.consumed) {
            try { await narrativeGraphService.markPatchConsumed(id, patchId, "consumed"); } catch { /* per-patch best-effort */ }
          }
          for (const patchId of graphPatchConsumption.partiallyConsumed) {
            try { await narrativeGraphService.markPatchConsumed(id, patchId, "partially_consumed"); } catch { /* per-patch best-effort */ }
          }

          const verificationSummary = {
            contractSatisfaction: report.satisfactionRate,
            satisfiedRequirements: report.items.filter((i) => i.status === "satisfied").map((i) => i.requirement),
            missingRequirements: report.items.filter((i) => i.status === "missing").map((i) => i.requirement),
            sourceArtifactIds: mergedSourceArtifactIds,
            graphPatchConsumption,
            ...(report.shouldRewrite ? { warning: "硬性用户要求未全部满足，建议修订" } : {}),
          };

          // ── Blueprint Fulfillment Audit (P4) ──────────────────────────
          // Only run when a confirmed blueprint was used for this write operation.
          let blueprintFulfillment: BlueprintFulfillmentReport | undefined;
          if (confirmedChapterBlueprint) {
            try {
              blueprintFulfillment = auditBlueprintFulfillment({
                chapterText: fullContent,
                blueprint: confirmedChapterBlueprint,
                chapterNumber: result.chapterNumber,
              });
              if (sessId) {
                await artifactService.create({
                  sessionId: sessId, bookId: id, type: "blueprint_fulfillment_report",
                  title: `蓝图兑现审计第${result.chapterNumber}章`,
                  payload: blueprintFulfillment as unknown as Record<string, unknown>,
                  summary: `score=${blueprintFulfillment.score}${blueprintFulfillment.shouldRewrite ? " [需重写]" : ""}`,
                  searchableText: JSON.stringify(blueprintFulfillment),
                });
              }
            } catch {
              // best-effort — never block verification broadcast
            }
          }

          // ── Blueprint P5 Auto-Revision Loop ────────────────────────────
          // When P4 audit fails on a confirmed blueprint, attempt one targeted
          // LLM revision. Instead of directly overwriting the chapter file,
          // the revised content is saved as a chapter-run candidate awaiting
          // user approval. Maximum one attempt per write-next call.
          let p5AutoRevision: P5AutoRevisionResult | undefined;
          if (blueprintFulfillment?.shouldRewrite && confirmedChapterBlueprint) {
            let editorReport: BlueprintEditorReport | undefined;
            try {
              // Step 1: Generate targeted rewrite plan (heuristic, no LLM)
              editorReport = generateBlueprintEditorReport(
                blueprintFulfillment,
                confirmedChapterBlueprint,
              );

              if (editorReport.targetedRewritePlan.fixCount > 0) {
                // Step 2: Get LLM client for the revision
                const pipelineConfig = await buildPipelineConfig();
                const reviser = new TargetedBlueprintReviser({
                  client: pipelineConfig.client,
                  model: pipelineConfig.model,
                  projectRoot: root,
                  bookId: id,
                });

                // Step 3: Run the LLM revision
                const reviseResult: TargetedReviseOutput = await reviser.revise({
                  chapterText: fullContent,
                  blueprint: confirmedChapterBlueprint,
                  plan: editorReport.targetedRewritePlan,
                  chapterNumber: result.chapterNumber,
                });

                if (reviseResult.revisedText.length > 0) {
                  // Step 4: Re-audit the revised content against the blueprint.
                  const revisedFulfillment = auditBlueprintFulfillment({
                    chapterText: reviseResult.revisedText,
                    blueprint: confirmedChapterBlueprint,
                    chapterNumber: result.chapterNumber,
                  });

                  // Step 4b: Re-verify user contract on the revised text (if a contract was active).
                  // If the revised text violates mustInclude/mustAvoid, the candidate must be
                  // marked still-failing even if the blueprint audit passed.
                  let contractVerificationAfter: P5AutoRevisionResult["contractVerificationAfter"];
                  const contractForP5 = effectiveSteeringInput.steeringContract
                    ?? ((effectiveSteeringInput.mustInclude?.length ?? 0) > 0 || (effectiveSteeringInput.mustAvoid?.length ?? 0) > 0
                      ? { mustInclude: effectiveSteeringInput.mustInclude ?? [], mustAvoid: effectiveSteeringInput.mustAvoid ?? [], sceneBeats: [] as string[] }
                      : null);
                  if (contractForP5) {
                    const contractReport = verifyContractSatisfaction({
                      chapterText: reviseResult.revisedText,
                      mustInclude: contractForP5.mustInclude ?? [],
                      mustAvoid: contractForP5.mustAvoid ?? [],
                      sceneBeats: (contractForP5 as { sceneBeats?: string[] }).sceneBeats ?? [],
                      goal: (contractForP5 as { goal?: string }).goal,
                    });
                    contractVerificationAfter = {
                      satisfactionRate: contractReport.satisfactionRate,
                      shouldRewrite: contractReport.shouldRewrite,
                      missingRequirements: contractReport.items
                        .filter((item) => item.status === "missing")
                        .map((item) => item.requirement),
                    };
                  }

                  // Effective fail = blueprint still needs rewrite OR contract verification failed.
                  const p5ShouldFail = revisedFulfillment.shouldRewrite
                    || (contractVerificationAfter?.shouldRewrite ?? false);

                  // Combined audit issues: blueprint blocking issues + contract missing requirements.
                  const combinedAuditIssues: string[] = [
                    ...(revisedFulfillment.shouldRewrite ? revisedFulfillment.blockingIssues : []),
                    ...(contractVerificationAfter?.missingRequirements.map((r) => `契约未满足: ${r}`) ?? []),
                  ];

                  // Step 5: Strip heading from revisedText for candidateRevision.content.
                  // applyApprovedCandidateRevision re-adds the heading from the current file,
                  // so candidate.content must be the chapter body only (no leading "# …" line).
                  const revisedLines = reviseResult.revisedText.split(/\r?\n/);
                  const hasHeading = revisedLines[0]?.trim().startsWith("# ");
                  const candidateContent = hasHeading
                    ? revisedLines.slice(1).join("\n").trimStart()
                    : reviseResult.revisedText;

                  // Step 6: Create a chapter-run candidate (decision="unchanged" = pending approval).
                  // Never write the revised content to disk here; the user must approve via the
                  // POST /api/books/:id/chapter-runs/:runId/approve endpoint.
                  // contentOnly: true marks that only chapter text is changed (no truth files).
                  const p5Run = await chapterRunStore.createRun({
                    bookId: id,
                    chapter: result.chapterNumber,
                    actionType: "blueprint-targeted-revise",
                    appliedBrief: `P5蓝图定点修订 score: ${blueprintFulfillment.score}→${revisedFulfillment.score}`,
                  });

                  const candidateRevision: ManualCandidateRevision = {
                    content: candidateContent,
                    wordCount: candidateContent.trim().length,
                    updatedState: "",   // P5 does not update truth files (contentOnly)
                    updatedLedger: "",  // P5 does not update truth files (contentOnly)
                    updatedHooks: "",   // P5 does not update truth files (contentOnly)
                    // status reflects the combined blueprint + contract result
                    status: p5ShouldFail ? "audit-failed" : "ready-for-review",
                    auditIssues: combinedAuditIssues,
                  };

                  await completeChapterRun({
                    bookId: id,
                    runId: p5Run.runId,
                    status: "succeeded",
                    decision: "unchanged", // signals pending-approval
                    data: {
                      beforeContent: fullContent,
                      afterContent: reviseResult.revisedText,
                      candidateRevision,
                      editorReport,
                      appliedFixes: reviseResult.appliedFixes,
                      // Store both before/after fulfillment for audit trail
                      blueprintFulfillmentBefore: blueprintFulfillment,
                      blueprintFulfillmentAfter: revisedFulfillment,
                      ...(contractVerificationAfter ? { contractVerificationAfter } : {}),
                      // Marker: P5 only rewrites chapter body, never truth files
                      contentOnly: true,
                    },
                  });

                  const p5Status: P5AutoRevisionResult["status"] = p5ShouldFail
                    ? "still-failing"
                    : "candidate_pending_approval";

                  p5AutoRevision = {
                    runId: p5Run.runId,
                    editorReport,
                    appliedFixes: reviseResult.appliedFixes,
                    revisedBlueprintFulfillment: revisedFulfillment,
                    status: p5Status,
                    ...(contractVerificationAfter ? { contractVerificationAfter } : {}),
                  };

                  // Step 7: Save editor_report artifact
                  if (sessId) {
                    await artifactService.create({
                      sessionId: sessId, bookId: id, type: "editor_report",
                      title: `P5蓝图定点修订第${result.chapterNumber}章`,
                      payload: {
                        runId: p5Run.runId,
                        editorReport: editorReport as unknown as Record<string, unknown>,
                        appliedFixes: reviseResult.appliedFixes,
                        revisedScore: revisedFulfillment.score,
                        status: p5Status,
                      } as Record<string, unknown>,
                      summary: `修复${editorReport.targetedRewritePlan.fixCount}处，修订后score=${revisedFulfillment.score}${p5Status === "candidate_pending_approval" ? " [待批准]" : " [仍需重写]"}`,
                      searchableText: JSON.stringify(editorReport),
                    });
                  }
                }
              }
            } catch (e) {
              // Surface the error in the broadcast payload instead of silently swallowing it.
              p5AutoRevision = {
                status: "failed",
                error: e instanceof Error ? e.message : String(e),
                ...(editorReport ? { editorReport } : {}),
              };
            }
          }

          broadcast("write-next:verification", { bookId: id, chapterNumber: result.chapterNumber, report, ...verificationSummary, ...(blueprintFulfillment ? { blueprintFulfillment } : {}), ...(p5AutoRevision ? { p5AutoRevision } : {}) });
          if (sessId) {
            await artifactService.create({
              sessionId: sessId, bookId: id, type: "contract_verification",
              title: `验证第${result.chapterNumber}章`,
              payload: { report, ...verificationSummary, ...(blueprintFulfillment ? { blueprintFulfillment } : {}), ...(p5AutoRevision ? { p5AutoRevision } : {}) } as unknown as Record<string, unknown>,
              summary: `rate=${report.satisfactionRate}${report.shouldRewrite ? " [未满足]" : ""}`,
              searchableText: JSON.stringify(verificationSummary),
            });
          }
        } catch (e) {
          // Guarantee write-next:verification is always broadcast when hasContract=true
          broadcast("write-next:verification", {
            bookId: id,
            chapterNumber: result.chapterNumber,
            report: { satisfactionRate: 0, items: [], shouldRewrite: true },
            contractSatisfaction: 0,
            satisfiedRequirements: [],
            missingRequirements: [],
            sourceArtifactIds: mergedSourceArtifactIds,
            graphPatchConsumption: buildEmptyPatchConsumption(),
            warning: `验证失败：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      } else if (graphDerivedPatchIds.length > 0) {
        // No contract to verify against — consume graph patches best-effort
        for (const patchId of graphDerivedPatchIds) {
          try { await narrativeGraphService.markPatchConsumed(id, patchId, "consumed"); } catch { /* */ }
        }
      }
    };

    const onWriteError = (e: unknown): void => {
      const error = e instanceof Error ? e.message : String(e);
      emitActionEvent("compose", "fail", { bookId: id, chapterNumber, briefUsed, error });
      emitActionEvent("write-next", "fail", { bookId: id, chapterNumber, briefUsed, error });
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
      // If a steering contract carries a rawRequest (full design proposal text from the agent),
      // prepend it to planInput so the plan stage also follows the design, not just the terse
      // user confirmation message like "非常棒 按照你的设计来写".
      const rawDesignForPlan = typeof (effectiveSteeringInput.steeringContract as Record<string, unknown> | undefined)?.rawRequest === "string"
        ? ((effectiveSteeringInput.steeringContract as Record<string, unknown>).rawRequest as string).trim()
        : undefined;
      const enrichedPlanInput = rawDesignForPlan
        ? `【参考设计方案 - 严格按此规划本章意图】\n${rawDesignForPlan}\n\n${planInput ?? directBrief ?? ""}`.trim()
        : (planInput ?? directBrief);
      planPipeline.planChapter(id, enrichedPlanInput)
        .then(async (plan) => {
          const planChapterNumber = resolvePlanOrFallbackChapterNumber(plan);
          emitActionEvent("plan", "success", {
            bookId: id,
            chapterNumber: planChapterNumber,
            briefUsed: planBrief !== undefined,
          });
          const externalContext = buildWriteNextContextFromPlan(plan, effectiveSteeringInput);
          emitActionEvent("compose", "start", {
            bookId: id,
            chapterNumber: planChapterNumber,
            briefUsed,
          });
          const writePipeline = new PipelineRunner(await buildPipelineConfig({ externalContext, confirmedChapterBlueprint }));
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
    } else if (mode === "quick" && !hasStructuredSteering) {
      // Quick mode: write directly without any context injection.
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      emitActionEvent("compose", "start", {
        bookId: id,
        chapterNumber,
        briefUsed,
      });
      pipeline.writeNextChapter(id, wordCount).then(onWriteComplete, onWriteError);
    } else {
      // manual-plan, legacy (no mode), or quick with steering: build externalContext from steering fields.
      const externalContext = buildWriteNextExternalContext(effectiveSteeringInput);
      const pipeline = new PipelineRunner(await buildPipelineConfig({ externalContext, confirmedChapterBlueprint }));
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

  app.get("/api/project/assistant-strategy", async (c) => {
    try {
      return c.json({ settings: await readAssistantStrategySettings() });
    } catch (e) {
      return c.json({ error: `Failed to read assistant strategy settings: ${String(e)}` }, 500);
    }
  });

  app.put("/api/project/assistant-strategy", async (c) => {
    const body = await c.req.json().catch(() => null);
    const validation = validateAssistantStrategyInput(body);
    if (!validation.ok) {
      return c.json({ code: "ASSISTANT_STRATEGY_VALIDATION_FAILED", errors: validation.errors }, 422);
    }
    try {
      const configPath = join(root, "inkos.json");
      const existing = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
      const baseSettings = normalizeAssistantStrategySettings(existing.assistantStrategy);
      const nextSettings = {
        ...baseSettings,
        ...validation.value,
        ...(validation.value.budget ? { budget: validation.value.budget } : {}),
        ...(validation.value.approvalSkills ? { approvalSkills: validation.value.approvalSkills } : {}),
        updatedAt: new Date().toISOString(),
      };
      existing.assistantStrategy = nextSettings;
      await writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true, settings: nextSettings });
    } catch (e) {
      return c.json({ error: `Failed to save assistant strategy settings: ${String(e)}` }, 500);
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

    // Expose P5-specific fields so the frontend can gate approval and show audit details.
    // These are read from the terminal success event's run data.
    const terminalEvent = [...run.events].reverse().find((e) => e.type === "success" || e.type === "fail");
    const runData = terminalEvent?.data as Record<string, unknown> | undefined;
    const candidateRevision = extractCandidateRevision(run);
    const p5Fields: Record<string, unknown> = {};
    if (candidateRevision) {
      p5Fields["candidateStatus"] = candidateRevision.status;
      p5Fields["candidateAuditIssues"] = candidateRevision.auditIssues;
    }
    if (runData?.["contentOnly"] === true) p5Fields["contentOnly"] = true;
    if (runData?.["blueprintFulfillmentBefore"]) p5Fields["blueprintFulfillmentBefore"] = runData["blueprintFulfillmentBefore"];
    if (runData?.["blueprintFulfillmentAfter"]) p5Fields["blueprintFulfillmentAfter"] = runData["blueprintFulfillmentAfter"];
    if (runData?.["contractVerificationAfter"]) p5Fields["contractVerificationAfter"] = runData["contractVerificationAfter"];

    return c.json({
      ...toChapterRunResponse(run),
      beforeContent: diff.beforeContent,
      afterContent: diff.afterContent,
      briefTrace: diff.briefTrace,
      pendingApproval: diff.pendingApproval,
      unchangedReason,
      ...p5Fields,
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

    // Safety gate: audit-failed candidates for blueprint-targeted-revise runs require
    // explicit { force: true } in the request body. Regular revise runs are unaffected
    // so as not to change existing behavior.
    const rawApproveBody = await c.req.json().catch(() => null);
    const forceApply = typeof rawApproveBody === "object"
      && rawApproveBody !== null
      && (rawApproveBody as Record<string, unknown>)["force"] === true;

    if (run.actionType === "blueprint-targeted-revise" && candidate.status === "audit-failed" && !forceApply) {
      return c.json({
        error: "候选修订未通过蓝图审计，请在确认风险后使用 { force: true } 强制应用。",
        candidateStatus: candidate.status,
        auditIssues: [...candidate.auditIssues],
      }, 409);
    }

    try {
      await applyApprovedCandidateRevision({
        bookId: id,
        chapterNumber: run.chapter,
        candidate,
      });

      const isForced = candidate.status === "audit-failed" && forceApply;
      const diff = parseDiffData(run);
      await completeChapterRun({
        bookId: id,
        runId,
        status: "succeeded",
        decision: "applied",
        unchangedReason: null,
        message: isForced ? "Audit-failed candidate force-approved by user." : "Candidate revision approved by user.",
        data: {
          beforeContent: diff.beforeContent,
          afterContent: candidate.content,
          briefTrace: diff.briefTrace,
          approvedFromUnchangedRun: true,
          ...(isForced ? { forcedAuditFailedApproval: true } : {}),
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
          message: isForced ? "Audit-failed candidate force-approved by user." : "Candidate revision approved by user.",
          ...(isForced ? { forcedAuditFailedApproval: true } : {}),
        },
      });

      // Refresh book memory after approval so the assistant reads the new chapter content.
      // Best-effort: failures must not block the API response.
      const approvedSnippet = await readLatestChapterSnippet(id, run.chapter).catch(() => "");
      await refreshBookMemory(id, run.chapter, "revise", {
        approvedFromRunId: runId,
        contentOnly: run.actionType === "blueprint-targeted-revise",
        ...(isForced ? { forcedAuditFailedApproval: true } : {}),
      }, approvedSnippet || undefined).catch(() => undefined);

      return c.json({
        ok: true,
        runId,
        chapter: run.chapter,
        decision: "applied",
        message: isForced ? "Audit-failed candidate force-applied and persisted." : "Candidate revision approved and persisted.",
        ...(isForced ? { forcedAuditFailedApproval: true } : {}),
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

  // --- Chapter Versions (built on chapter runs) ---

  app.get("/api/books/:id/chapters/:chapter/versions", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    if (Number.isNaN(chapterNum) || chapterNum < 1) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const runs = await chapterRunStore.listRuns(id, { chapter: chapterNum, limit: 100 });
    const versions = runs
      .filter((run) => run.status === "succeeded" && run.decision === "applied")
      .map((run) => {
        const diff = parseDiffData(run);
        return {
          versionId: run.runId,
          createdAt: run.finishedAt ?? run.startedAt,
          actionType: run.actionType,
          label: run.appliedBrief ?? run.actionType,
          hasContent: diff.beforeContent !== null || diff.afterContent !== null,
        };
      });
    return c.json({ chapter: chapterNum, versions });
  });

  app.get("/api/books/:id/chapters/:chapter/versions/:versionId", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const versionId = c.req.param("versionId");
    const run = await chapterRunStore.getRun(id, versionId);
    if (!run || run.chapter !== chapterNum) {
      return c.json({ error: "Version not found" }, 404);
    }
    const diff = parseDiffData(run);
    return c.json({
      versionId: run.runId,
      chapter: run.chapter,
      createdAt: run.finishedAt ?? run.startedAt,
      actionType: run.actionType,
      label: run.appliedBrief ?? run.actionType,
      beforeContent: diff.beforeContent,
      afterContent: diff.afterContent,
    });
  });

  app.get("/api/books/:id/chapters/:chapter/diff", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const fromId = c.req.query("from");
    const toId = c.req.query("to");
    if (!fromId || !toId) {
      return c.json({ error: "Both 'from' and 'to' query params required" }, 400);
    }
    const [fromRun, toRun] = await Promise.all([
      chapterRunStore.getRun(id, fromId),
      chapterRunStore.getRun(id, toId),
    ]);
    if (!fromRun || fromRun.chapter !== chapterNum) {
      return c.json({ error: `Version '${fromId}' not found` }, 404);
    }
    if (!toRun || toRun.chapter !== chapterNum) {
      return c.json({ error: `Version '${toId}' not found` }, 404);
    }
    const fromDiff = parseDiffData(fromRun);
    const toDiff = parseDiffData(toRun);
    return c.json({
      chapter: chapterNum,
      from: {
        versionId: fromRun.runId,
        content: fromDiff.afterContent ?? fromDiff.beforeContent,
      },
      to: {
        versionId: toRun.runId,
        content: toDiff.afterContent ?? toDiff.beforeContent,
      },
    });
  });

  app.post("/api/books/:id/chapters/:chapter/restore/:versionId", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const versionId = c.req.param("versionId");
    const run = await chapterRunStore.getRun(id, versionId);
    if (!run || run.chapter !== chapterNum) {
      return c.json({ error: "Version not found" }, 404);
    }
    const diff = parseDiffData(run);
    const contentToRestore = diff.beforeContent;
    if (!contentToRestore || contentToRestore.trim().length === 0) {
      return c.json({ error: "No restorable content in this version" }, 409);
    }

    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const chapterPrefix = String(chapterNum).padStart(4, "0");
    const files = await readdir(chaptersDir);
    const chapterFile = files.find((file) => file.startsWith(chapterPrefix) && file.endsWith(".md"));
    if (!chapterFile) {
      return c.json({ error: `Chapter ${chapterNum} file not found` }, 404);
    }
    const chapterPath = join(chaptersDir, chapterFile);

    const beforeRestore = await readFile(chapterPath, "utf-8").catch(() => "");
    await writeFile(chapterPath, contentToRestore, "utf-8");

    const restoreRun = await chapterRunStore.createRun({
      bookId: id,
      chapter: chapterNum,
      actionType: "revise",
      appliedBrief: `Restored to version ${versionId}`,
    });
    await completeChapterRun({
      bookId: id,
      runId: restoreRun.runId,
      status: "succeeded",
      decision: "applied",
      data: {
        beforeContent: beforeRestore,
        afterContent: contentToRestore,
        briefTrace: [],
        restoredFromVersionId: versionId,
      },
    });

    return c.json({
      ok: true,
      chapter: chapterNum,
      restoredFromVersionId: versionId,
      runId: restoreRun.runId,
    });
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
    let { dimension, bookId, chapter, keyword } = parsed.value;
    // Auto-resolve latest chapter when LLM omits chapter number for dimension=chapter
    if (dimension === "chapter" && chapter === undefined) {
      try {
        const index = await state.loadChapterIndex(bookId);
        chapter = index.length > 0 ? Math.max(...index.map((ch) => ch.number)) : undefined;
      } catch {
        // fallback: will be handled downstream
      }
    }
    const result = await resolveAssistantCrudRead({ dimension, bookId, chapter, keyword });
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

  app.get("/api/assistant/memory/:layer", async (c) => {
    const layerParam = c.req.param("layer");
    if (!isAssistantMemoryLayer(layerParam)) {
      return c.json({ code: "ASSISTANT_MEMORY_LAYER_INVALID", error: `Unsupported memory layer: ${layerParam}` }, 404);
    }

    const layer = layerParam;
    const bookId = c.req.query("bookId")?.trim();
    const sessionId = c.req.query("sessionId")?.trim();
    if (layer === "book" && (!bookId || !isSafeBookId(bookId))) {
      return c.json({ code: "ASSISTANT_MEMORY_VALIDATION_FAILED", errors: [{ field: "bookId", message: "bookId must be a safe non-empty string" }] }, 422);
    }
    if (layer === "session" && !sessionId) {
      return c.json({ code: "ASSISTANT_MEMORY_VALIDATION_FAILED", errors: [{ field: "sessionId", message: "sessionId is required for session memory" }] }, 422);
    }

    if (layer === "market") {
      const market = await assistantMemoryService.ensureMarketMemory(async () => {
        const pipeline = new PipelineRunner(await buildPipelineConfig());
        return await pipeline.runRadar();
      });
      return c.json({
        ok: true,
        layer,
        memory: market.memory,
        refreshed: market.refreshed,
        stale: market.stale,
        ...(toAssistantMemoryWarning(market.warning) ? { warning: toAssistantMemoryWarning(market.warning) } : {}),
      });
    }

    const result = await assistantMemoryService.readMemory(layer, {
      ...(bookId ? { bookId } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    return c.json({
      ok: true,
      layer,
      memory: result.memory,
      ...(toAssistantMemoryWarning(result.warning) ? { warning: toAssistantMemoryWarning(result.warning) } : {}),
    });
  });

  app.put("/api/assistant/memory/:layer", async (c) => {
    const layerParam = c.req.param("layer");
    if (!isAssistantMemoryLayer(layerParam)) {
      return c.json({ code: "ASSISTANT_MEMORY_LAYER_INVALID", error: `Unsupported memory layer: ${layerParam}` }, 404);
    }

    const payload = parseAssistantMemoryPayload(await c.req.json<unknown>().catch(() => null));
    if (!payload) {
      return c.json({ code: "ASSISTANT_MEMORY_VALIDATION_FAILED", errors: [{ field: "body", message: "Request body must be a JSON object" }] }, 422);
    }
    if (layerParam === "book" && (!payload.bookId || !isSafeBookId(payload.bookId))) {
      return c.json({ code: "ASSISTANT_MEMORY_VALIDATION_FAILED", errors: [{ field: "bookId", message: "bookId must be a safe non-empty string" }] }, 422);
    }
    if (layerParam === "session" && !payload.sessionId) {
      return c.json({ code: "ASSISTANT_MEMORY_VALIDATION_FAILED", errors: [{ field: "sessionId", message: "sessionId is required for session memory" }] }, 422);
    }

    const result = await assistantMemoryService.writeMemory(
      layerParam,
      payload.data,
      {
        ...(payload.bookId ? { bookId: payload.bookId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      },
      {
        ...(payload.summary ? { summary: payload.summary } : {}),
        ...(layerParam === "market"
          ? { expiresAt: new Date(Date.now() + ASSISTANT_MARKET_MEMORY_TTL_MS).toISOString() }
          : {}),
      },
    );

    if (!result.memory && result.warning) {
      return c.json({ code: "ASSISTANT_MEMORY_WRITE_FAILED", error: result.warning }, 500);
    }

    return c.json({
      ok: true,
      layer: layerParam,
      memory: result.memory,
      ...(toAssistantMemoryWarning(result.warning) ? { warning: toAssistantMemoryWarning(result.warning) } : {}),
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
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const scopeBookTitles = Array.isArray(payload.scopeBookTitles)
      ? (payload.scopeBookTitles as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const scopeBookIds = Array.isArray(payload.scopeBookIds)
      ? (payload.scopeBookIds as unknown[]).filter((value): value is string => typeof value === "string" && isSafeBookId(value))
      : [];
    const recentMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = Array.isArray(payload.recentMessages)
      ? (payload.recentMessages as unknown[])
          .filter((m): m is { role: string; content: string } =>
            typeof m === "object" && m !== null
            && typeof (m as { content?: unknown }).content === "string")
          .slice(-4)
          .map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: (m.content as string).slice(0, 1500) }))
      : [];
    if (!prompt) {
      return c.json({
        code: "ASSISTANT_CHAT_VALIDATION_FAILED",
        errors: [{ field: "prompt", message: "prompt must be a non-empty string" }],
      }, 422);
    }

    const resolveScopedBookId = async (): Promise<string | null> => {
      if (scopeBookIds.length === 1) {
        return scopeBookIds[0]!;
      }

      const allBookIds = await state.listBooks();

      if (sessionId.length > 0) {
        const sessionMemory = await assistantMemoryService.readMemory("session", { sessionId });
        const currentBookId = typeof (sessionMemory.memory?.data as { currentBookId?: unknown } | undefined)?.currentBookId === "string"
          ? ((sessionMemory.memory?.data as { currentBookId?: string }).currentBookId ?? "").trim()
          : "";
        if (currentBookId && isSafeBookId(currentBookId) && allBookIds.includes(currentBookId)) {
          return currentBookId;
        }
      }

      if (scopeBookTitles.length === 1) {
        const targetTitle = normalizeAssistantBookTitle(scopeBookTitles[0] ?? "");
        if (targetTitle.length > 0) {
          for (const bookId of allBookIds) {
            try {
              const book = await state.loadBookConfig(bookId);
              if (normalizeAssistantBookTitle(book.title ?? "") === targetTitle) {
                return bookId;
              }
            } catch {
              // ignore unreadable book metadata
            }
          }
        }
      }

      return null;
    };

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

    // ── Chat-to-Book 向导通道 ─────────────────────────────────────────────
    // 当请求触发创书意图关键词时，进入多轮向导（不限是否已选定书籍）。
    // 向导状态通过 session artifact (book_creation_draft) 跨轮持久化。
    const chatToBookUserRequest = extractAssistantUserRequest(prompt);
    const isChatToBookInitial = ASSISTANT_CHAT_TO_BOOK_PATTERN.test(chatToBookUserRequest);

    // Also detect continuation of an in-progress wizard (prior draft artifact exists in session).
    // Always load previous drafts — even on "initial" trigger — so context from prior turns is preserved.
    const sessIdForWizard = sessionId || `s_${Date.now().toString(36)}`;
    const existingWizardDraftArtifacts = await artifactService.listByType(sessIdForWizard, "book_creation_draft", 1);
    const isChatToBookContinuation = !isChatToBookInitial && existingWizardDraftArtifacts.length > 0;

    if (isChatToBookInitial || isChatToBookContinuation) {
      broadcast("agent:start", { instruction: prompt });
      return streamSSE(c, async (stream) => {
        try {
          // Load previous draft if any
          let previousDraft: BookCreationDraftPayload | null = null;
          if (existingWizardDraftArtifacts[0]) {
            const fullArtifact = await artifactService.getById(
              existingWizardDraftArtifacts[0].artifactId,
              sessIdForWizard,
            );
            if (fullArtifact) {
              previousDraft = fullArtifact.payload as unknown as BookCreationDraftPayload;
            }
          }

          // Detect confirmation
          const confirmIntent = previousDraft?.stage === "draft_ready"
            ? detectConfirmation(chatToBookUserRequest)
            : "refine";

          await stream.writeSSE({
            event: "assistant:progress",
            data: JSON.stringify({ type: "tool_call", tool: "draft_book_config", args: { stage: confirmIntent } }),
          });
          broadcast("log", `工具调用：draft_book_config（${confirmIntent}）`);

          // ── Confirm path ───────────────────────────────────────────────
          if (confirmIntent === "confirm" && previousDraft) {
            const confirmReq = draftToConfirmRequest(previousDraft);
            const createResp = await app.request(`${ASSISTANT_INTERNAL_API_BASE}/api/v2/books/create/confirm`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(confirmReq),
            });

            if (!createResp.ok) {
              const errorMsg = await parseApiErrorMessage(createResp);
              await stream.writeSSE({
                event: "assistant:done",
                data: JSON.stringify({ ok: false, error: errorMsg }),
              });
              broadcast("agent:error", { instruction: prompt, error: errorMsg });
              return;
            }

            const createPayload = await createResp.json().catch(() => null) as { bookId?: string } | null;
            const newBookId = createPayload?.bookId ?? "";

            // Mark draft as confirmed in artifact store
            const confirmedDraft: BookCreationDraftPayload = { ...previousDraft, stage: "confirmed" };
            await artifactService.create({
              sessionId: sessIdForWizard,
              type: "book_creation_draft",
              title: `书籍草案：《${previousDraft.title}》（已确认）`,
              payload: confirmedDraft as unknown as Record<string, unknown>,
              summary: `已确认创建《${previousDraft.title}》，bookId=${newBookId}`,
              searchableText: previousDraft.title,
            });

            await stream.writeSSE({
              event: "assistant:done",
              data: JSON.stringify({
                ok: true,
                response: `📖《${previousDraft.title}》已创建成功！书籍正在初始化，你可以去书库查看。`,
                cards: [{
                  type: "book_created",
                  payload: { bookId: newBookId, title: previousDraft.title },
                }],
              }),
            });
            broadcast("agent:complete", { instruction: prompt, response: `创建书籍成功：${previousDraft.title}` });
            return;
          }

          // ── Cancel path ────────────────────────────────────────────────
          if (confirmIntent === "cancel") {
            await stream.writeSSE({
              event: "assistant:done",
              data: JSON.stringify({ ok: true, response: "好的，已取消创书向导。你可以随时重新开始。" }),
            });
            broadcast("agent:complete", { instruction: prompt, response: "已取消创书向导" });
            return;
          }

          // ── Refine / Generate path ─────────────────────────────────────
          const currentConfig = await loadCurrentProjectConfig();
          const llmClient = createLLMClient(currentConfig.llm);
          const { chatCompletion } = await import("@actalk/inkos-core");

          const wizardInput: WizardTurnInput = {
            sessionId: sessIdForWizard,
            userText: chatToBookUserRequest,
            previousDraft,
            recentMessages,
            llmCall: async (systemPrompt: string) => {
              const resp = await chatCompletion(llmClient, currentConfig.llm.model, [
                { role: "user", content: systemPrompt },
              ], { maxTokens: 2048 });
              return resp.content;
            },
          };

          const wizardOutput = await processWizardTurn(wizardInput);

          // Persist draft as artifact
          await artifactService.create({
            sessionId: sessIdForWizard,
            type: "book_creation_draft",
            title: `书籍草案：《${wizardOutput.updatedDraft.title}》`,
            payload: wizardOutput.updatedDraft as unknown as Record<string, unknown>,
            summary: `草案阶段：${wizardOutput.updatedDraft.stage}，标题：${wizardOutput.updatedDraft.title}`,
            searchableText: [
              wizardOutput.updatedDraft.title,
              wizardOutput.updatedDraft.genre,
              wizardOutput.updatedDraft.protagonist,
            ].join(" "),
          });

          await stream.writeSSE({
            event: "assistant:done",
            data: JSON.stringify({
              ok: true,
              response: wizardOutput.responseText,
              cards: wizardOutput.readyToConfirm
                ? [{ type: "book_creation_draft", payload: wizardOutput.updatedDraft }]
                : [],
            }),
          });
          broadcast("agent:complete", { instruction: prompt, response: wizardOutput.responseText });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: false, error }) });
          broadcast("agent:error", { instruction: prompt, error });
        }
      });
    }

    // NovelOS shared variables
    const NOVELOS_PLOT_QUALITY_RE = /(?:剧情|小说|故事).{0,10}(?:写|写得|质量|如何|怎样|怎么样|评价|分析|优缺点|差距|吸引|好看)/;
    const novelosBookId = await resolveScopedBookId();

    // NovelOS P1: Steering/contract generation from analysis or explicit user constraints.
    // Must NOT fire when the user is explicitly requesting a rewrite/rework of an existing chapter
    // (e.g. "按照你的方案彻底重写第一章") — those belong to the direct-revise lane below.
    const NOVELOS_STEERING_RE = /(?:按[照]?你|就按你|照[这个那个刚才]).{0,15}(?:说|给|提|建议|方案|优缺点).{0,10}(?:规划|写|计划|安排|继续)/;
    const NOVELOS_MUST_RE = /(?:下一章|写第.{1,3}章).{0,20}(?:必须|一定要|要让|不要让|不能)/;
    const isRewriteExecution = ASSISTANT_REVISE_INTENT_PATTERN.test(prompt);
    if (novelosBookId && !isRewriteExecution && (NOVELOS_STEERING_RE.test(prompt) || NOVELOS_MUST_RE.test(prompt))) {
      broadcast("agent:start", { instruction: prompt });
      return streamSSE(c, async (stream) => {
        try {
          const sessId = sessionId || `s_${Date.now().toString(36)}`;
          const recentArtifacts = await artifactService.listRecentSessionArtifacts(sessId, 20);

          await stream.writeSSE({
            event: "assistant:progress",
            data: JSON.stringify({ type: "tool_call", tool: "resolve_context", args: { prompt } }),
          });
          broadcast("log", "工具调用：resolve_context");

          // Strip instruction-wrapper metadata (【当前锁定书籍】/【执行要求】/【用户请求】) so that
          // resolveContext and compileSteeringContract only see the user's actual request text.
          const cleanUserText = extractAssistantUserRequest(prompt);

          // Resolve references and extract requirements
          const resolved = resolveContext({ sessionId: sessId, userText: cleanUserText, recentArtifacts, bookId: novelosBookId });

          // Fetch referenced critique payloads
          let critiquePayload: Record<string, unknown> | undefined;
          for (const ref of resolved.resolvedReferences) {
            const art = await artifactService.getById(ref.artifactId, sessId, novelosBookId);
            if (art && art.type === "plot_critique") {
              critiquePayload = art.payload;
              break;
            }
          }

          await stream.writeSSE({
            event: "assistant:progress",
            data: JSON.stringify({ type: "tool_call", tool: "compile_steering_contract" }),
          });
          broadcast("log", "工具调用：compile_steering_contract");

          // Compile steering contract
          const contract = compileSteeringContract({
            userText: cleanUserText,
            resolvedRequirements: resolved.extractedUserRequirements,
            referencedCritiquePayload: critiquePayload as Parameters<typeof compileSteeringContract>[0]["referencedCritiquePayload"],
            sourceArtifactIds: resolved.resolvedReferences.map((r) => r.artifactId),
          });

          // Generate blueprint from contract
          const blueprint = buildBlueprintFromContract(contract, novelosBookId);

          // Save contract and blueprint as artifacts
          const contractArt = await artifactService.create({
            sessionId: sessId, bookId: novelosBookId,
            type: "chapter_steering_contract", title: "章节干预契约",
            payload: contract as unknown as Record<string, unknown>,
            summary: `Contract: ${contract.mustInclude.length} mustInclude, ${contract.mustAvoid.length} mustAvoid, priority=${contract.priority}`,
            searchableText: contract.rawRequest,
          });
          const blueprintPayloadWithMeta = {
            ...(blueprint as unknown as Record<string, unknown>),
            status: "draft" as const,
            version: 1,
            sourceArtifactIds: [contractArt.artifactId],
          };
          const blueprintArt = await artifactService.create({
            sessionId: sessId, bookId: novelosBookId,
            type: "chapter_blueprint", title: "章节戏剧蓝图",
            payload: blueprintPayloadWithMeta,
            summary: `Blueprint: ${blueprint.scenes.length} scenes, ending: ${blueprint.endingHook.slice(0, 30)}, status=draft`,
            searchableText: JSON.stringify(blueprint),
          });
          const blueprintCardPayload = {
            ...blueprintPayloadWithMeta,
            artifactId: blueprintArt.artifactId,
          };

          // Build response text
          const responseText = buildSteeringResponseText(contract, blueprint, resolved);

          await stream.writeSSE({
            event: "assistant:done",
            data: JSON.stringify({
              ok: true,
              response: responseText,
              // Only send the blueprint card — the contract details are already shown in the
              // response text markdown. Including both would render duplicate "下一章写作契约" blocks.
              cards: [
                { type: "blueprint", payload: blueprintCardPayload },
              ],
            }),
          });
          broadcast("agent:complete", { instruction: prompt, response: responseText });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          await stream.writeSSE({
            event: "assistant:done",
            data: JSON.stringify({ ok: false, error, response: `契约生成失败：${error}` }),
          });
          broadcast("agent:complete", { instruction: prompt, response: `失败：${error}` });
        }
      });
    }
    // Deterministic chapter-revise lane:
    // When user explicitly asks to modify a specific chapter, execute revise directly
    // instead of letting agent freely chain into write-next or unrelated tools.
    const userRequest = extractAssistantUserRequest(prompt);
    const targetChapter = parseAssistantChapterFromInput(userRequest);
    // When the user doesn't mention a chapter number but the request is a clear rewrite
    // execution (e.g. "按照你的方案彻底重写"), infer the chapter from recent conversation messages.
    const targetChapterResolved = targetChapter ??
      recentMessages.slice().reverse().reduce<number | undefined>(
        (found, msg) => found ?? parseAssistantChapterFromInput(msg.content),
        undefined,
      );
    // When both REVISE_INTENT and WRITE_NEXT patterns match (e.g. "按照方案重写第一章"),
    // the explicit rewrite intent takes priority over the write-next exclusion.
    const isExplicitRewrite = /重写|改写|彻底|大幅改|rework|chapter.redesign/iu.test(userRequest);
    const isRevisionPlanningOnly = ASSISTANT_REVISION_PLANNING_PATTERN.test(userRequest)
      && !/(?:执行|开始|直接|马上|立刻|现在|按.{0,12}(?:方案|设计|规划).{0,8}(?:改|重写|修订|执行)|去(?:改|重写|修订)|帮我(?:改|重写|修订))/iu.test(userRequest);
    const shouldDirectRevise = ASSISTANT_REVISE_INTENT_PATTERN.test(userRequest)
      && !ASSISTANT_TRUTH_FILE_EDIT_PATTERN.test(userRequest)
      && !isRevisionPlanningOnly
      && (isExplicitRewrite || !ASSISTANT_WRITE_NEXT_PATTERN.test(userRequest))
      && !ASSISTANT_OPINION_QUESTION_PATTERN.test(userRequest)
      && targetChapterResolved !== undefined;
    if (shouldDirectRevise) {
      const targetBookId = await resolveScopedBookId();
      if (!targetBookId) {
        // Fallback to regular agent loop when book scope cannot be resolved
        // (keeps backward compatibility for generic chat tests and legacy callers).
      } else {
      const reviseMode = inferAssistantReviseModeFromInput(userRequest);
      const chapterNum = targetChapterResolved!;
      broadcast("agent:start", { instruction: prompt });
      return streamSSE(c, async (stream) => {
        try {
          await stream.writeSSE({
            event: "assistant:progress",
            data: JSON.stringify({ type: "tool_call", tool: "revise_chapter", args: { bookId: targetBookId, chapterNumber: chapterNum, mode: reviseMode } }),
          });
          broadcast("log", "工具调用：revise_chapter");

          const reviseResponse = await app.request(`${ASSISTANT_INTERNAL_API_BASE}/api/books/${targetBookId}/revise/${chapterNum}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: reviseMode,
              brief: userRequest,
            }),
          });
          if (!reviseResponse.ok) {
            const errorMsg = await parseApiErrorMessage(reviseResponse);
            await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: false, error: errorMsg }) });
            broadcast("agent:error", { instruction: prompt, error: errorMsg });
            return;
          }

          const revisePayload = await reviseResponse.json().catch(() => null) as Record<string, unknown> | null;
          const runId = typeof revisePayload?.runId === "string" ? revisePayload.runId : "";
          if (!runId) {
            const errorMsg = "修订任务已提交，但未返回 runId。";
            await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: false, error: errorMsg }) });
            broadcast("agent:error", { instruction: prompt, error: errorMsg });
            return;
          }

          await stream.writeSSE({
            event: "assistant:progress",
            data: JSON.stringify({ type: "tool_result", tool: "revise_chapter", preview: `已提交第${chapterNum}章修订，等待完成…` }),
          });

          const run = await waitForChapterRunCompletion(targetBookId, runId, 12 * 60_000);
          if (run.status === "failed") {
            const errorMsg = run.error || "章节修订失败。";
            await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: false, error: errorMsg }) });
            broadcast("agent:error", { instruction: prompt, error: errorMsg });
            return;
          }

          const decision = run.decision ?? "unknown";
          const unchangedReason = run.decision === "unchanged"
            ? (run.unchangedReason ?? NO_REVISIONS_APPLIED_MESSAGE)
            : "";
          const pendingApproval = run.decision === "unchanged" && extractCandidateRevision(run) !== null;
          const response = run.decision === "unchanged"
            ? pendingApproval
              ? [
                  `已生成第${chapterNum}章候选修订（模式：${reviseMode}），但安全门未自动替换原文。`,
                  `原因：${unchangedReason}`,
                  `你可以在章节任务中心查看差异并手动批准，runId：${runId}`,
                ].join("\n")
              : `已执行第${chapterNum}章修订（模式：${reviseMode}），结果未改动：${unchangedReason}`
            : `已按你的要求完成第${chapterNum}章修订（模式：${reviseMode}，决策：${decision}）。`;
          await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: true, response }) });
          broadcast("agent:complete", { instruction: prompt, response });
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          await stream.writeSSE({ event: "assistant:done", data: JSON.stringify({ ok: false, error: errorMsg }) });
          broadcast("agent:error", { instruction: prompt, error: errorMsg });
        }
      });
      }
    }

    broadcast("agent:start", { instruction: prompt });

    const scopeHint = scopeBookTitles.length > 0
      ? `\n\n当前对话聚焦的书籍：${scopeBookTitles.join("、")}。若用户未明确切换书籍，优先基于这些书籍回答并执行。`
      : "";
    const memoryContext = await assistantMemoryService.buildAgentContext(scopeBookIds);
    const memoryPrompt = memoryContext.promptBlock.trim();
    const recentContextBlock = recentMessages.length > 0
      ? `【近期对话上下文】
以下内容仅用于理解指代和延续任务，不要复述近期对话原文。重要：如果用户说“按方案继续/按照你的设计写”，则提取结构化约束后调用 write_draft；但如果用户说的是“设计一下/你来设计/你设计/帮我设计/想想写什么”，则只输出文字设计方案，不调用 write_draft，方案末尾询问用户是否执行写作。
${recentMessages.map((m, index) => compactAssistantRecentMessageForAgentContext(m, {
  preserveDetail: index >= Math.max(0, recentMessages.length - 2),
})).join("\n---\n")}`
      : "";

    // ── Deterministic intent classification (eval-mode guard) ─────────────────
    // Strategy: two-signal approach.
    //   1. HARD_WRITE_SIGNAL_RE  — explicit write commands  → force write mode
    //   2. EVAL_SIGNAL_RE        — design/evaluation phrases → force eval mode
    // Eval mode is also triggered CONTEXT-AWARE: if the last assistant message
    // was a design output (ended with "要我按这个方案写吗?"), and the user's reply
    // contains no hard write signal, we assume they are still iterating on design.
    const cleanTextForConstraint = extractAssistantUserRequest(prompt);

    // Hard write commands — presence of any of these overrides eval mode
    const HARD_WRITE_SIGNAL_RE =
      /写下一章|继续写|续写|开始写|马上写|立刻写|现在写|执行写作|就按.{0,10}写|按照.{0,20}(?:设计|方案|规划).{0,12}(?:写|生成|落实|执行)|(?:采用|走|按|按照).{0,8}路径\s*[A-DＡ-Ｄ]/u;

    // Design / evaluation request phrases — any of these triggers eval mode
    const EVAL_SIGNAL_RE =
      /(?:设计一下|再来设计|你来设计|来设计一下|你设计|再设计|重新设计|如何设计|再来一版|再来个方案|帮我设计|帮我想想|应该如何写|如何写才能|怎么写才能|写的如何|写得如何|写得怎|如何才能写|如何写.{0,6}更|怎么写.{0,6}更|如何让.{0,15}更|下一章节?.{0,15}(?:应该|需要)?(?:如何|怎么|怎样)写|你来评价|评价.{0,20}(?:小说|写法|章节|剧情)|分析一下|想想怎么写|规划一下|你来规划|不够.{0,25}再.{0,8}(?:设计|来一版|想想)|还是.{0,20}(?:不够|不行|没新意|不刺激).{0,15}(?:再|重新).{0,6}(?:设计|来))/u;

    // Context-aware: if last assistant message was a design output (asked "要我写吗?"),
    // and current input has no hard write signal, keep in eval mode for design iteration.
    const lastAssistantMsgForEval = [...recentMessages].reverse().find((m) => m.role === "assistant");
    const prevWasDesignOutput = lastAssistantMsgForEval !== undefined
      && /(?:要我(?:按|按照)?这个?(?:方案|设计|规划)?(?:执行写作|写|开始写|续写)?吗|需要我现在.{0,8}(?:执行写作|写)|直接启动.{0,15}write_draft|是否.{0,8}执行写作|我可以.{0,5}(?:plan_chapter|compose_chapter|write))/u
        .test(lastAssistantMsgForEval.content);

    const isEvalAdviceOnly =
      (EVAL_SIGNAL_RE.test(cleanTextForConstraint) || ASSISTANT_REVISION_PLANNING_PATTERN.test(cleanTextForConstraint) || prevWasDesignOutput)
      && !HARD_WRITE_SIGNAL_RE.test(cleanTextForConstraint);

    const evalConstraintBlock = isEvalAdviceOnly
      ? "[系统约束：evaluation-mode] 此请求为评价/建议/设计模式。只能调用 read_chapter、read_truth_files、get_book_status 等读取类工具，然后以文字形式输出分析、设计方案或建议。绝对禁止调用 write_draft、write_full_pipeline、plan_chapter、compose_chapter、update_current_focus。输出方案后询问用户：「要我按这个方案执行写作吗？」"
      : "";

    const agentPrompt = [
      memoryPrompt ? `【记忆上下文】\n${memoryPrompt}` : "",
      recentContextBlock,
      evalConstraintBlock,
      `${prompt}${scopeHint}`,
    ]
      .filter((section) => section.length > 0)
      .join("\n\n");

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
        const finalResponse = dedupeRepeatedAssistantResponse(buildGroundedAssistantResponse(prompt, toolOutcomes, rawResponse));
        const outputDecision = await promptInjectionGuard.inspectOutput({
          route: c.req.path,
          requestId: promptInjectionGuard.getRequestId(c),
          content: finalResponse,
        });
        if (outputDecision) {
          await queueSSE("assistant:done", {
            ok: false,
            error: outputDecision.message,
            code: outputDecision.code,
            reason: outputDecision.reason,
            requestId: outputDecision.requestId,
            rule: outputDecision.ruleId,
          });
          broadcast("agent:error", { instruction: prompt, error: outputDecision.message, requestId: outputDecision.requestId });
          return;
        }
        // Background: if this was a plot quality question, save artifact for future reference
        if (NOVELOS_PLOT_QUALITY_RE.test(prompt) && novelosBookId && finalResponse.length > 100) {
          void (async () => {
            try {
              await artifactService.create({
                sessionId: sessionId || "",
                bookId: novelosBookId,
                type: "plot_critique",
                title: `剧情分析: ${novelosBookId}`,
                payload: { llmResponse: finalResponse },
                summary: finalResponse.slice(0, 200),
                searchableText: finalResponse,
              });
            } catch { /* best-effort */ }
          })();
        }
        // Background: if the assistant produced a concrete next-chapter design,
        // persist it as a chapter_plan artifact. This lets follow-up prompts like
        // "按你的设计方案写下一章" resolve to a real plan instead of only the latest
        // user emphasis sentence.
        if (sessionId && novelosBookId && shouldPersistChapterPlanArtifact(prompt, finalResponse)) {
          void (async () => {
            try {
              const sceneBeats = extractChapterPlanSceneBeats(finalResponse);
              const goal = extractChapterPlanGoal(finalResponse);
              await artifactService.create({
                sessionId,
                bookId: novelosBookId,
                type: "chapter_plan",
                title: `章节方案: ${novelosBookId}`,
                payload: {
                  userRequest: prompt,
                  response: finalResponse,
                  sceneBeats,
                  ...(goal ? { goal } : {}),
                  createdFrom: "assistant_chat",
                },
                summary: `章节方案：${goal ?? sceneBeats[0] ?? "下一章方案"}`,
                searchableText: finalResponse,
              });
            } catch { /* best-effort */ }
          })();
        }
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
    const planRecentMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = Array.isArray(body.recentMessages)
      ? (body.recentMessages as unknown[])
          .filter((m): m is { role?: unknown; content: string } =>
            typeof m === "object" && m !== null && typeof (m as { content?: unknown }).content === "string")
          .slice(-8)
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" as const : "user" as const,
            content: m.content.slice(0, 5000),
          }))
      : [];
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

    const intentType = parseAssistantIntentType(body.intentType);
    // Use routeAssistantIntent for richer intent detection (supports artifact references, mustInclude extraction)
    const routedIntent = routeAssistantIntent({
      sessionId,
      userText: input,
      selectedBookIds: parsedScope.scope.type === "book-list" ? parsedScope.scope.bookIds : [],
      recentMessages: planRecentMessages,
      recentArtifacts: sessionId ? await artifactService.listRecentSessionArtifacts(sessionId, 20) : [],
    });
    // Map routed intent types to plan intents
    function mapRoutedToPlanIntent(routedType: string): AssistantPlanIntent | null {
      switch (routedType) {
        case "plan_next_from_previous_analysis":
        case "write_next_with_user_plot":
        case "write_next_from_graph_change":
          return "write_next";
        case "audit_chapter":
          return "audit";
        case "revise_chapter":
          return "audit_and_optimize";
        case "edit_story_graph":
        case "query_story_graph":
          return null; // handled separately
        default:
          return null;
      }
    }
    const intent = intentType === "goal-to-book"
      ? "goal_to_book"
      : routedIntent.intentType !== "clarify"
        ? (mapRoutedToPlanIntent(routedIntent.intentType) ?? resolveAssistantPlanIntent(input))
        : resolveAssistantPlanIntent(input);
    if (!intent) {
      return c.json({
        error: {
          code: "ASSISTANT_PLAN_INTENT_UNKNOWN",
          message: "Unable to recognize assistant intent from input.",
        },
      }, 422);
    }

    const taskId = `asst_t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const resolveFallbackChapterForBook = async (bookId: string): Promise<number | undefined> => {
      const nextChapter = await state.getNextChapterNumber(bookId);
      if (!Number.isInteger(nextChapter)) {
        return undefined;
      }
      // Use the latest existing chapter when user says "当前章节" but does not provide a number.
      return Math.max(1, nextChapter - 1);
    };

    const hydratePlanChapters = async (plan: AssistantPlanStep[]): Promise<AssistantPlanStep[]> => {
      const cache = new Map<string, number>();
      const getFallback = async (bookId: string): Promise<number> => {
        const cached = cache.get(bookId);
        if (cached !== undefined) {
          return cached;
        }
        const resolved = await resolveFallbackChapterForBook(bookId);
        const value = resolved ?? 1;
        cache.set(bookId, value);
        return value;
      };

      const enriched: AssistantPlanStep[] = [];
      for (const step of plan) {
        const needsChapter = step.action === "audit" || step.action === "revise" || step.action === "re-audit";
        if (!needsChapter || step.chapter !== undefined) {
          enriched.push(step);
          continue;
        }
        const stepBookId = typeof step.bookId === "string"
          ? step.bookId
          : (Array.isArray(step.bookIds) && step.bookIds.length === 1 && typeof step.bookIds[0] === "string"
            ? step.bookIds[0]
            : undefined);
        if (!stepBookId) {
          enriched.push(step);
          continue;
        }
        const fallbackChapter = await getFallback(stepBookId);
        enriched.push({
          ...step,
          chapter: fallbackChapter,
        });
      }
      return enriched;
    };

    if (intent === "goal_to_book") {
      if (parsedScope.scope.type !== "book-list" || parsedScope.scope.bookIds.length !== 1) {
        return c.json({
          code: "ASSISTANT_PLAN_VALIDATION_FAILED",
          errors: [{
            field: "scope",
            message: "goal-to-book requires scope.type='book-list' with exactly one target bookId",
          }],
        }, 422);
      }
      const bookId = parsedScope.scope.bookIds[0]!;
      const nextChapter = await state.getNextChapterNumber(bookId);
      const chapterTarget = parseGoalToBookChapterTarget(input);
      const drafted = buildGoalToBookTaskGraph(taskId, bookId, nextChapter, chapterTarget);
      assistantTaskGraphs.set(taskId, drafted.graph);
      return c.json({
        taskId,
        intent,
        intentType: "goal-to-book",
        plan: drafted.plan,
        graph: drafted.graph,
        requiresConfirmation: true,
        risk: drafted.risk,
      });
    }
    const drafted = buildAssistantPlanDraft(intent, parsedScope.scope, input);
    // For write_next and plot-analysis-driven write_next: auto-load latest contract/blueprint artifacts.
    const needsBlueprintConfirm =
      routedIntent.intentType === "plan_next_from_previous_analysis" ||
      routedIntent.intentType === "write_next_with_user_plot";
    let latestSteering: Awaited<ReturnType<typeof loadLatestSteeringArtifacts>> | undefined;
    if (intent === "write_next" || needsBlueprintConfirm) {
      const bookId = parsedScope.scope.type === "book-list" && parsedScope.scope.bookIds.length === 1 ? parsedScope.scope.bookIds[0] : undefined;
      latestSteering = await loadLatestSteeringArtifacts(artifactService, sessionId, bookId);
    }
    const hydratedPlan = await hydratePlanChapters(drafted.plan);
    const requiresReleaseCandidateCheckpoint = ASSISTANT_RELEASE_CANDIDATE_PATTERN.test(input);
    let graph = requiresReleaseCandidateCheckpoint
      ? appendAssistantCheckpointAfterLeafTasks(buildAssistantTaskGraphFromPlan(taskId, hydratedPlan, drafted.risk.level))
      : buildAssistantTaskGraphFromPlan(taskId, hydratedPlan, drafted.risk.level);
    // Enrich write-next nodes with latest steering artifacts
    if (latestSteering && (latestSteering.contract || latestSteering.blueprint)) {
      graph = {
        ...graph,
        nodes: graph.nodes.map((node) => {
          if (node.action !== "write-next") return node;
          return {
            ...node,
            ...(latestSteering!.contract ? { steeringContract: latestSteering!.contract } : {}),
            ...(latestSteering!.blueprint ? { blueprint: latestSteering!.blueprint } : {}),
            ...(latestSteering!.sourceArtifactIds.length > 0 ? { sourceArtifactIds: latestSteering!.sourceArtifactIds } : {}),
          };
        }),
      };
    } else if (intent === "write_next" && !needsBlueprintConfirm && ASSISTANT_PLAN_REFERENCE_RE.test(input)) {
      // Inline fallback: user accepted a plan from recent messages but no artifact was found
      // (e.g. session mismatch, or plan not yet persisted). Search recent messages directly.
      const inlinePlanMsg = [...planRecentMessages].reverse().find(
        (m) => m.role === "assistant" && shouldPersistChapterPlanArtifact(input, m.content),
      );
      if (inlinePlanMsg) {
        const beats = extractChapterPlanSceneBeats(inlinePlanMsg.content);
        const goal = extractChapterPlanGoal(inlinePlanMsg.content);
        const inlineContract: Record<string, unknown> = {
          priority: "hard",
          mustInclude: beats.slice(0, 6),
          mustAvoid: [] as string[],
          sceneBeats: beats,
          ...(goal ? { goal } : {}),
          rawRequest: inlinePlanMsg.content,
          sourceArtifactIds: [] as string[],
          userContractPriority: "hard",
        };
        graph = {
          ...graph,
          nodes: graph.nodes.map((node) => {
            if (node.action !== "write-next") return node;
            return { ...node, steeringContract: inlineContract };
          }),
        };
      }
    }
    // For plot-driven write-next intents, prepend a blueprint-confirm checkpoint before write-next nodes
    if (needsBlueprintConfirm) {
      const planBookId = parsedScope.scope.type === "book-list" && parsedScope.scope.bookIds.length === 1
        ? parsedScope.scope.bookIds[0] : undefined;
      const explicitBlueprintAccepted = isExplicitChapterPlanAcceptance(input);

      // Resolve blueprint artifact id: confirmed > pending > auto-generate
      let bpArtifactId = latestSteering?.blueprintArtifactId ?? latestSteering?.pendingBlueprintArtifactId;
      let acceptedBlueprintPayload: Record<string, unknown> | undefined;

      const confirmBlueprintArtifactForAcceptedPlan = async (artifactId: string): Promise<Record<string, unknown> | undefined> => {
        if (!explicitBlueprintAccepted) return undefined;
        const art = await artifactService.getById(artifactId, sessionId, planBookId);
        if (!art || art.type !== "chapter_blueprint") return undefined;
        const payload = art.payload as Record<string, unknown>;
        const currentStatus = typeof payload.status === "string" ? payload.status : "draft";
        const currentVersion = typeof payload.version === "number" ? payload.version : 1;
        const confirmedPayload = {
          ...payload,
          artifactId,
          status: "confirmed",
          version: currentStatus === "confirmed" ? currentVersion : currentVersion + 1,
          confirmedAt: new Date().toISOString(),
          confirmedBy: "explicit-plan-acceptance",
        };
        await artifactService.update(artifactId, sessionId, {
          bookId: planBookId,
          payload: confirmedPayload,
          summary: `Blueprint v${confirmedPayload.version}: confirmed by explicit plan acceptance`,
          searchableText: JSON.stringify(confirmedPayload),
        });
        return confirmedPayload;
      };

      // If no blueprint artifact exists, auto-generate a draft blueprint so the checkpoint can be bound
      if (!bpArtifactId) {
        let contractForBp = latestSteering?.contract;
        if (!contractForBp) {
          // No steering contract in session — compile a minimal one from user input
          const recentArts = sessionId ? await artifactService.listRecentSessionArtifacts(sessionId, 20) : [];
          const resolvedCtx = resolveContext({ sessionId, userText: input, recentArtifacts: recentArts, bookId: planBookId });
          let referencedPlanText = "";
          let referencedPlanGoal: string | undefined;
          let referencedPlanBeats: string[] = [];
          const referencedPlanArtifactIds: string[] = [];
          const inlinePlanMessage = ASSISTANT_PLAN_REFERENCE_RE.test(input)
            ? [...planRecentMessages].reverse().find((message) =>
                message.role === "assistant" && shouldPersistChapterPlanArtifact(input, message.content),
              )
            : undefined;
          const inlinePlanArtifactId = inlinePlanMessage
            ? (await artifactService.create({
                sessionId,
                bookId: planBookId,
                type: "chapter_plan",
                title: `章节方案: ${planBookId ?? "当前书籍"}`,
                payload: {
                  userRequest: input,
                  response: inlinePlanMessage.content,
                  sceneBeats: extractChapterPlanSceneBeats(inlinePlanMessage.content),
                  ...(extractChapterPlanGoal(inlinePlanMessage.content) ? { goal: extractChapterPlanGoal(inlinePlanMessage.content) } : {}),
                  createdFrom: "assistant_plan_recent_message",
                },
                summary: `章节方案：${extractChapterPlanGoal(inlinePlanMessage.content) ?? "最近对话方案"}`,
                searchableText: inlinePlanMessage.content,
              })).artifactId
            : undefined;
          const referencedPlanIds = uniqueStrings([
            ...resolvedCtx.resolvedReferences.map((r) => r.artifactId),
            ...(inlinePlanArtifactId ? [inlinePlanArtifactId] : []),
            ...(ASSISTANT_PLAN_REFERENCE_RE.test(input)
              ? recentArts.filter((art) => art.type === "chapter_plan").map((art) => art.artifactId).slice(0, 1)
              : []),
          ]);
          for (const artifactId of referencedPlanIds) {
            const art = await artifactService.getById(artifactId, sessionId, planBookId);
            if (!art || art.type !== "chapter_plan") continue;
            referencedPlanArtifactIds.push(art.artifactId);
            const payload = art.payload as Record<string, unknown>;
            const response = typeof payload.response === "string" ? payload.response : "";
            referencedPlanText = response || art.searchableText || "";
            referencedPlanGoal = typeof payload.goal === "string"
              ? payload.goal
              : extractChapterPlanGoal(referencedPlanText);
            const payloadBeats = Array.isArray(payload.sceneBeats)
              ? payload.sceneBeats.filter((value): value is string => typeof value === "string")
              : [];
            referencedPlanBeats = uniqueStrings([
              ...payloadBeats,
              ...extractChapterPlanSceneBeats(referencedPlanText),
            ]);
            break;
          }
          const compiledFromInput = compileSteeringContract({
            userText: input,
            resolvedRequirements: resolvedCtx.extractedUserRequirements,
            sourceArtifactIds: uniqueStrings([
              ...resolvedCtx.resolvedReferences.map((r) => r.artifactId),
              ...referencedPlanArtifactIds,
            ]),
          });
          const sourceArtifactIds = uniqueStrings([
            ...compiledFromInput.sourceArtifactIds,
            ...referencedPlanArtifactIds,
          ]);
          const hasReferencedPlan = referencedPlanText.trim().length > 0;
          const compiledSceneBeats = Array.isArray(compiledFromInput.sceneBeats) ? compiledFromInput.sceneBeats : [];
          const compiledMustInclude = Array.isArray(compiledFromInput.mustInclude) ? compiledFromInput.mustInclude : [];
          const mustIncludeForBlueprint = hasReferencedPlan
            ? compiledMustInclude.filter((item) => !isMetaWritingQualityRequirement(item))
            : compiledMustInclude;
          const acceptedPlanHardRequirements = hasReferencedPlan
            ? referencedPlanBeats.slice(0, 6)
            : [];
          contractForBp = {
            ...(compiledFromInput as unknown as Record<string, unknown>),
            ...(referencedPlanGoal ? { goal: referencedPlanGoal } : {}),
            mustInclude: uniqueStrings([
              ...mustIncludeForBlueprint,
              ...acceptedPlanHardRequirements,
            ]),
            sceneBeats: hasReferencedPlan
              ? uniqueStrings([...referencedPlanBeats, ...compiledSceneBeats])
              : uniqueStrings([...compiledSceneBeats, ...referencedPlanBeats]),
            priority: (ASSISTANT_PLAN_ACCEPTANCE_RE.test(input) || hasReferencedPlan) ? "hard" : compiledFromInput.priority,
            sourceArtifactIds,
            rawRequest: referencedPlanText
              ? `${input}\n\n[引用章节方案]\n${referencedPlanText}`
              : compiledFromInput.rawRequest,
          };
          await artifactService.create({
            sessionId,
            bookId: planBookId,
            type: "chapter_steering_contract",
            title: "章节干预契约",
            payload: contractForBp,
            summary: `Contract: auto-generated from plan input`,
            searchableText: typeof contractForBp.rawRequest === "string" ? contractForBp.rawRequest : input,
          });
        }

        // Build draft blueprint from contract
        const contractFields = {
          goal: typeof contractForBp.goal === "string" ? contractForBp.goal : undefined,
          mustInclude: Array.isArray(contractForBp.mustInclude) ? contractForBp.mustInclude as string[] : [],
          mustAvoid: Array.isArray(contractForBp.mustAvoid) ? contractForBp.mustAvoid as string[] : [],
          sceneBeats: Array.isArray(contractForBp.sceneBeats) ? contractForBp.sceneBeats as string[] : [],
          payoffRequired: typeof contractForBp.payoffRequired === "string" ? contractForBp.payoffRequired : undefined,
          endingHook: typeof contractForBp.endingHook === "string" ? contractForBp.endingHook : undefined,
        };
        const autoBp = buildBlueprintFromContract(contractFields, planBookId ?? "");
        const autoBpPayload: Record<string, unknown> = {
          ...(autoBp as unknown as Record<string, unknown>),
          status: explicitBlueprintAccepted ? "confirmed" : "draft",
          version: 1,
          ...(explicitBlueprintAccepted ? {
            confirmedAt: new Date().toISOString(),
            confirmedBy: "explicit-plan-acceptance",
          } : {}),
          sourceArtifactIds: Array.isArray(contractForBp.sourceArtifactIds)
            ? contractForBp.sourceArtifactIds as string[]
            : latestSteering?.sourceArtifactIds ?? [],
        };
        const autoBpArt = await artifactService.create({
          sessionId,
          bookId: planBookId,
          type: "chapter_blueprint",
          title: "章节戏剧蓝图",
          payload: autoBpPayload,
          summary: `Blueprint v1: ${autoBp.scenes.length} scenes, status=${explicitBlueprintAccepted ? "confirmed" : "draft"} (auto-generated)`,
          searchableText: JSON.stringify(autoBpPayload),
        });
        // Self-describe: include artifactId in payload
        const autoBpPayloadWithId = { ...autoBpPayload, artifactId: autoBpArt.artifactId };
        await artifactService.update(autoBpArt.artifactId, sessionId, {
          bookId: planBookId,
          payload: autoBpPayloadWithId,
          summary: `Blueprint v1: ${autoBp.scenes.length} scenes, status=${explicitBlueprintAccepted ? "confirmed" : "draft"} (auto-generated)`,
          searchableText: JSON.stringify(autoBpPayloadWithId),
        });
        bpArtifactId = autoBpArt.artifactId;
        acceptedBlueprintPayload = explicitBlueprintAccepted ? autoBpPayloadWithId : undefined;
      } else if (explicitBlueprintAccepted) {
        acceptedBlueprintPayload = await confirmBlueprintArtifactForAcceptedPlan(bpArtifactId);
      }

      const writeNextNodeIds = graph.nodes
        .filter((n) => n.type === "task" && n.action === "write-next")
        .map((n) => n.nodeId);
      if (writeNextNodeIds.length > 0 && explicitBlueprintAccepted && acceptedBlueprintPayload) {
        graph = {
          ...graph,
          nodes: graph.nodes.map((node) => {
            if (node.action !== "write-next") return node;
            const existingSourceIds = Array.isArray(node.sourceArtifactIds) ? node.sourceArtifactIds : [];
            const bpSourceIds = Array.isArray(acceptedBlueprintPayload!.sourceArtifactIds)
              ? acceptedBlueprintPayload!.sourceArtifactIds.filter((value): value is string => typeof value === "string")
              : [];
            return {
              ...node,
              blueprint: acceptedBlueprintPayload,
              sourceArtifactIds: uniqueStrings([...existingSourceIds, bpArtifactId!, ...bpSourceIds]),
            };
          }),
        };
      }
      if (writeNextNodeIds.length > 0 && bpArtifactId && !explicitBlueprintAccepted) {
        const cpNodeId = nextAssistantCheckpointNodeId(graph);
        const cpNode: TaskNode = {
          nodeId: cpNodeId,
          type: "checkpoint",
          action: "checkpoint",
          mode: "blueprint-confirm",
          checkpoint: {
            nodeId: cpNodeId,
            requiredApproval: true,
            blueprintArtifactId: bpArtifactId,
            requiredBlueprintStatus: "confirmed",
          },
        };
        const targetSet = new Set(writeNextNodeIds);
        const firstTargetIndex = graph.nodes.findIndex((n) => targetSet.has(n.nodeId));
        const nextNodes = [...graph.nodes];
        nextNodes.splice(firstTargetIndex >= 0 ? firstTargetIndex : 0, 0, cpNode);
        const filteredEdges = graph.edges.filter((e) => !(targetSet.has(e.to) && !targetSet.has(e.from)));
        const newEdges = [...filteredEdges];
        for (const targetId of targetSet) {
          const incoming = graph.edges
            .filter((e) => e.to === targetId && !targetSet.has(e.from))
            .map((e) => e.from);
          if (incoming.length === 0) {
            newEdges.push({ from: cpNodeId, to: targetId });
          } else {
            for (const from of incoming) {
              newEdges.push({ from, to: cpNodeId });
            }
            newEdges.push({ from: cpNodeId, to: targetId });
          }
        }
        graph = {
          ...graph,
          nodes: nextNodes,
          edges: dedupeAssistantTaskEdges(newEdges),
        };
      }
    }
    assistantTaskGraphs.set(taskId, graph);
    return c.json({
      taskId,
      intent,
      plan: hydratedPlan,
      graph,
      requiresConfirmation: true,
      risk: {
        ...drafted.risk,
        reasons: requiresReleaseCandidateCheckpoint
          ? [...drafted.risk.reasons, "包含发布候选阶段 checkpoint，需人工确认后才能完成候选确认。"]
          : drafted.risk.reasons,
      },
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
    const autopilotParsed = parseAssistantAutopilotLevel(body.autopilotLevel);
    if (!autopilotParsed.ok) {
      errors.push(...autopilotParsed.errors);
    }
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_POLICY_VALIDATION_FAILED", errors }, 422);
    }
    const budgetInput = budgetParsed.ok ? budgetParsed.value : undefined;
    const permissionsInput = permissionsParsed.ok ? permissionsParsed.value : undefined;
    const planInput = (planParsed as { ok: true; value: AssistantPolicyPlanStep[] }).value;
    const strategy = await readAssistantStrategySettings();
    const autopilotLevel = (autopilotParsed as { ok: true; value?: AssistantAutopilotLevel }).value;

    const policy = evaluateAssistantPolicy({
      plan: planInput,
      approved: body.approved === true,
      strategy,
      ...(autopilotLevel ? { autopilotLevel } : {}),
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
    const budgetParsed = parseAssistantPolicyBudget(body.budget);
    if (!budgetParsed.ok) {
      errors.push(...budgetParsed.errors);
    }
    const permissionsParsed = parseAssistantPolicyPermissions(body.permissions);
    if (!permissionsParsed.ok) {
      errors.push(...permissionsParsed.errors);
    }
    const autopilotParsed = parseAssistantAutopilotLevel(body.autopilotLevel);
    if (!autopilotParsed.ok) {
      errors.push(...autopilotParsed.errors);
    }
    if (errors.length > 0) {
      return c.json({ code: "ASSISTANT_EXECUTE_VALIDATION_FAILED", errors }, 422);
    }
    const autopilotLevel = (autopilotParsed as { ok: true; value?: AssistantAutopilotLevel }).value;
    const strategy = await readAssistantStrategySettings();
    const effectiveAutopilotLevel = autopilotLevel ?? strategy.autopilotLevel;

    const storedGraph = assistantTaskGraphs.get(taskId);
    const bodyGraph = normalizeAssistantTaskGraph(body.graph, taskId);
    const legacyPlan = Array.isArray(body.plan)
      ? (body.plan as AssistantPlanStep[])
      : null;
    const graph = storedGraph
      ?? bodyGraph
      ?? (legacyPlan ? buildAssistantTaskGraphFromPlan(taskId, legacyPlan, "medium", effectiveAutopilotLevel) : null);
    if (!graph) {
      return c.json({
        code: "ASSISTANT_EXECUTE_VALIDATION_FAILED",
        errors: [{
          field: "taskId",
          message: "taskId must reference a planned graph, or body must include graph/plan fallback data",
        }],
      }, 422);
    }
    assistantTaskGraphs.set(taskId, graph);

    const executableNodes = collectAssistantExecutableNodes(graph);
    const hasAnyTaskNode = graph.nodes.some((node) => node.type === "task");
    if (!hasAnyTaskNode) {
      return c.json({
        code: "ASSISTANT_EXECUTE_VALIDATION_FAILED",
        errors: [{
          field: "graph",
          message: "graph must include at least one executable task node",
        }],
      }, 422);
    }
    const budgetInput = budgetParsed.ok ? budgetParsed.value : undefined;
    const permissionsInput = permissionsParsed.ok ? permissionsParsed.value : undefined;
    const policyPlan = flattenAssistantPolicyPlanFromGraph(graph);

    const skillAuthorization = executableNodes.length > 0
      ? authorizeAssistantSkillPlan(executableNodes, permissionsInput)
      : { allow: true as const, denied: [] };
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
      plan: policyPlan,
      approved,
      strategy,
      ...(autopilotLevel ? { autopilotLevel } : {}),
      ...(permissionsInput ? { permissions: permissionsInput } : {}),
      ...(budgetInput ? { budget: budgetInput } : {}),
    });
    const runtimeGraph = adaptAssistantTaskGraphForAutopilot(graph, policy.autopilot);
    const graphHasCheckpoint = runtimeGraph.nodes.some((node) => node.type === "checkpoint");
    const filteredPolicyReasons = graphHasCheckpoint && !approved
      ? policy.reasons.filter((reason) => reason !== ASSISTANT_HIGH_RISK_APPROVAL_REASON)
      : policy.reasons;
    const blockedMessage = policy.reasons.join("; ");
    const filteredBlockedMessage = filteredPolicyReasons.join("; ");
    const finalBlockedMessage = filteredBlockedMessage.length > 0
      ? filteredBlockedMessage
      : blockedMessage.length > 0
        ? blockedMessage
        : "Assistant execution blocked by policy guard.";
    if (policy.budgetWarning) {
      broadcast("assistant:budget:warning", {
        taskId,
        sessionId,
        level: "warn",
        severity: "warn",
        timestamp: new Date().toISOString(),
        autopilotLevel: policy.autopilot.level,
        reasonCode: policy.autopilot.level === "L3" || policy.autopilot.level === "autopilot"
          ? "autopilot-budget-exhausted"
          : policy.autopilot.reasonCode,
        ...policy.budgetWarning,
      });
    }
    if (filteredPolicyReasons.length > 0) {
      const autopilotPausedByBudget = (
        policy.autopilot.level === "L3" || policy.autopilot.level === "autopilot"
      ) && policy.budgetWarning !== undefined;
      const errorCode = autopilotPausedByBudget
        ? ASSISTANT_AUTOPILOT_BUDGET_PAUSED_CODE
        : "ASSISTANT_EXECUTE_POLICY_BLOCKED";
      broadcast("assistant:policy:blocked", {
        taskId,
        sessionId,
        level: "warn",
        severity: "warn",
        timestamp: new Date().toISOString(),
        autopilotLevel: policy.autopilot.level,
        riskLevel: policy.riskLevel,
        reasons: filteredPolicyReasons,
        requiredApprovals: policy.requiredApprovals,
        reasonCode: autopilotPausedByBudget ? "autopilot-budget-exhausted" : policy.autopilot.reasonCode,
        errorCode,
        message: finalBlockedMessage,
      });
      emitAssistantTaskEvent("assistant:done", {
        taskId,
        sessionId,
        status: "failed",
        autopilotLevel: policy.autopilot.level,
        reasonCode: autopilotPausedByBudget ? "autopilot-budget-exhausted" : policy.autopilot.reasonCode,
        errorCode,
        error: finalBlockedMessage,
      });
      return c.json({
        error: {
          code: errorCode,
          message: finalBlockedMessage,
          taskId,
          policy: {
            ...policy,
            allow: false,
            reasons: filteredPolicyReasons,
          },
        },
      }, 409);
    }

    if (policy.autopilot.shouldAutoExecute) {
      broadcast("assistant:policy:auto-execute", {
        taskId,
        sessionId,
        level: "info",
        severity: "info",
        timestamp: new Date().toISOString(),
        riskLevel: policy.riskLevel,
        autopilotLevel: policy.autopilot.level,
        reasonCode: policy.autopilot.reasonCode,
        reason: policy.autopilot.reason,
        checkpointStrategy: policy.autopilot.checkpointStrategy,
        ...(policy.autopilot.countdownSeconds !== undefined ? { countdownSeconds: policy.autopilot.countdownSeconds } : {}),
      });
    }

    assistantTaskExecutionAutopilotLevels.set(taskId, policy.autopilot.level);
    ensureAssistantTaskSnapshot(taskId, sessionId, runtimeGraph);
    const runner = assistantConductor.runGraph(runtimeGraph, {
      sessionId,
      autoApproveCheckpoints: approved || policy.autopilot.autoApproveCheckpoint,
      ...(policy.autopilot.level === "L3" || policy.autopilot.level === "autopilot"
        ? { pauseAfterConsecutiveFailures: 2 }
        : {}),
    });
    const firstEvent = await runner.next();
    if (!firstEvent.done && firstEvent.value) {
      applyAssistantConductorEvent(firstEvent.value);
      void (async () => {
        for await (const event of runner) {
          applyAssistantConductorEvent(event);
        }
      })();
    }
    return c.json(summarizeAssistantTaskRun(taskId));
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
    const report = await deriveAssistantEvaluateReport(scopedRuns, scope, runIds);
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
      const report = await deriveAssistantEvaluateReport(optimizeRuns, scope, runIds);
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

  app.post("/api/assistant/tasks/:taskId/approve/:nodeId", async (c) => {
    await assistantTaskSnapshotHydration;
    const taskId = c.req.param("taskId");
    const nodeId = c.req.param("nodeId");
    const requestBody = await c.req.json<unknown>().catch(() => null);
    const snapshot = assistantTaskSnapshots.get(taskId);
    if (!snapshot) {
      return c.json({
        error: {
          code: "ASSISTANT_TASK_NOT_FOUND",
          message: "Assistant task was not found.",
        },
      }, 404);
    }
    if (snapshot.awaitingApproval?.type === "candidate-selection" && snapshot.awaitingApproval.nodeId === nodeId) {
      const candidateId = typeof (requestBody as Record<string, unknown> | null)?.["candidateId"] === "string"
        ? ((requestBody as Record<string, unknown>).candidateId as string).trim()
        : "";
      const candidates = snapshot.awaitingApproval.candidates ?? [];
      if (!candidateId || !candidates.some((candidate) => candidate.candidateId === candidateId)) {
        return c.json({
          error: {
            code: "ASSISTANT_CANDIDATE_SELECTION_INVALID",
            message: "candidateId must reference one of the pending candidates.",
            taskId,
            nodeId,
          },
        }, 422);
      }
      const resolveCandidate = assistantCandidateApprovalResolvers.get(`${taskId}:${nodeId}`);
      if (!resolveCandidate) {
        return c.json({
          error: {
            code: "ASSISTANT_TASK_APPROVAL_UNAVAILABLE",
            message: "Assistant candidate selection is not waiting for approval.",
            taskId,
            nodeId,
          },
        }, 409);
      }
      resolveCandidate(candidateId);
      return c.json({
        ok: true,
        taskId,
        nodeId,
        candidateId,
        ...summarizeAssistantTaskRun(taskId),
      });
    }
    // For blueprint-confirm checkpoints: verify the bound blueprint artifact is confirmed
    const graphNode = snapshot.graph?.nodes.find((n) => n.nodeId === nodeId);
    if (graphNode?.mode === "blueprint-confirm" && graphNode?.checkpoint?.blueprintArtifactId) {
      const bpArtifactId = graphNode.checkpoint.blueprintArtifactId;
      const requiredStatus = graphNode.checkpoint.requiredBlueprintStatus ?? "confirmed";
      const bpArt = await artifactService.getById(bpArtifactId, snapshot.sessionId);
      if (!bpArt || bpArt.payload.status !== requiredStatus) {
        return c.json({
          error: {
            code: "BLUEPRINT_NOT_CONFIRMED",
            message: `Blueprint artifact ${bpArtifactId} must have status "${requiredStatus}" before this checkpoint can be approved. Current status: ${bpArt ? String(bpArt.payload.status ?? "unknown") : "not found"}.`,
            blueprintArtifactId: bpArtifactId,
          },
        }, 409);
      }
    }
    const approved = assistantConductor.approve(taskId, nodeId, "manual");
    if (!approved) {
      return c.json({
        error: {
          code: "ASSISTANT_TASK_APPROVAL_UNAVAILABLE",
          message: "Assistant task node is not waiting for approval.",
          taskId,
          nodeId,
        },
      }, 409);
    }
    return c.json({
      ok: true,
      taskId,
      nodeId,
      ...summarizeAssistantTaskRun(taskId),
    });
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

  app.get("/api/assistant/metrics", async (c) => {
    try {
      const rangeDays = normalizeAssistantMetricsRange(c.req.query("range"));
      return c.json(await buildAssistantMetricsResponse(rangeDays));
    } catch {
      return c.json({
        series: [],
        summary: {
          firstSuccessRate: 0,
          autoFixSuccessRate: 0,
          manualInterventionRate: 0,
          averageChapterScore: 0,
          tokenConsumption: 0,
          activeTasks: 0,
        },
        meta: {
          generatedAt: new Date().toISOString(),
          rangeDays: normalizeAssistantMetricsRange(c.req.query("range")),
          taskSnapshotLimit: ASSISTANT_METRICS_TASK_SNAPSHOT_LIMIT,
          runLimitPerBook: ASSISTANT_METRICS_RUN_LIMIT_PER_BOOK,
          totalRunLimit: ASSISTANT_METRICS_TOTAL_RUN_LIMIT,
          booksScanned: 0,
          tasksConsidered: 0,
          runsConsidered: 0,
          truncated: false,
        },
      } satisfies AssistantMetricsResponse);
    }
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

  // --- NovelOS P0/P1: Artifact, Plot Critique, Steering Compile, Verify ---

  app.get("/api/assistant/artifacts", async (c) => {
    const sessionId = c.req.query("sessionId") ?? "";
    const bookId = c.req.query("bookId");
    const type = c.req.query("type") as AssistantArtifactType | undefined;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);

    if (type) {
      return c.json({ artifacts: await artifactService.listByType(sessionId, type, limit) });
    }
    if (bookId) {
      return c.json({ artifacts: await artifactService.listRecentBookArtifacts(bookId, limit) });
    }
    return c.json({ artifacts: await artifactService.listRecentSessionArtifacts(sessionId, limit) });
  });

  app.post("/api/assistant/plot-critique", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "PLOT_CRITIQUE_INVALID_BODY", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : `asst_s_${Date.now().toString(36)}`;
    const bookId = typeof body.bookId === "string" ? body.bookId : "";
    if (!bookId) {
      return c.json({ code: "PLOT_CRITIQUE_BOOK_REQUIRED", errors: [{ field: "bookId", message: "bookId is required" }] }, 422);
    }

    try {
      const bookDir = join(root, "books", bookId);
      const chapterIndex = await state.loadChapterIndex(bookId);
      const chapters = await Promise.all(
        chapterIndex.slice(-10).map(async (ch) => {
          const content = await readChapterContentSnapshot(bookId, ch.number);
          return { number: ch.number, title: ch.title, content: content ?? "", wordCount: ch.wordCount ?? 0 };
        }),
      );
      const truthFiles = await Promise.all(
        ["story_bible", "current_state", "current_focus", "pending_hooks"].map(async (name) => {
          try {
            const content = await readFile(join(bookDir, "story", `${name}.md`), "utf-8");
            return { name, content };
          } catch {
            return { name, content: "" };
          }
        }),
      );

      const minChapter = chapters.length > 0 ? chapters[0].number : 1;
      const maxChapter = chapters.length > 0 ? chapters[chapters.length - 1].number : 1;
      const critique = generatePlotCritique({
        bookId,
        chapterRange: { from: minChapter, to: maxChapter },
        chapters: chapters.filter((c) => c.content.length > 0),
        truthFiles: truthFiles.filter((t) => t.content.length > 0),
        focus: typeof body.focus === "string" ? body.focus : undefined,
      });

      const artifact = await artifactService.create({
        sessionId,
        bookId,
        type: "plot_critique",
        title: `剧情分析: ${bookId} 章节 ${minChapter}-${maxChapter}`,
        payload: critique as unknown as Record<string, unknown>,
        summary: `剧情分析：${critique.strengths.length} 个优势，${critique.weaknesses.length} 个问题，${critique.nextChapterOpportunities.length} 个机会`,
        searchableText: JSON.stringify(critique),
      });

      return c.json({ artifact, critique });
    } catch (e) {
      return c.json({ code: "PLOT_CRITIQUE_FAILED", error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/assistant/steering/compile", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "STEERING_COMPILE_INVALID", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const userText = typeof body.userText === "string" ? body.userText : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const bookId = typeof body.bookId === "string" ? body.bookId : undefined;

    // Resolve context
    const recentSummaries = sessionId
      ? await artifactService.listRecentSessionArtifacts(sessionId, 20)
      : [];
    const resolved = resolveContext({ sessionId, userText, recentArtifacts: recentSummaries, bookId });

    // Fetch referenced critique payloads
    let critiquePayload: { nextChapterOpportunities?: ReadonlyArray<{ title: string; why: string; mustInclude: ReadonlyArray<string>; risk: string; payoff: string }>; weaknesses?: ReadonlyArray<string> } | undefined;
    for (const ref of resolved.resolvedReferences) {
      const art = await artifactService.getById(ref.artifactId, sessionId, bookId);
      if (art && art.type === "plot_critique") {
        critiquePayload = art.payload as typeof critiquePayload;
        break;
      }
    }

    // Compile contract
    const contract = compileSteeringContract({
      userText,
      resolvedRequirements: resolved.extractedUserRequirements,
      referencedCritiquePayload: critiquePayload,
      sourceArtifactIds: resolved.resolvedReferences.map((r) => r.artifactId),
    });

    // Store contract as artifact
    const artifact = await artifactService.create({
      sessionId,
      bookId,
      type: "chapter_steering_contract",
      title: "章节干预契约",
      payload: contract as unknown as Record<string, unknown>,
      summary: `Contract: ${contract.mustInclude.length} mustInclude, ${contract.mustAvoid.length} mustAvoid, priority=${contract.priority}`,
      searchableText: contract.rawRequest,
    });

    return c.json({ contract, artifact, resolvedContext: resolved });
  });

  app.post("/api/assistant/contract/verify", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "CONTRACT_VERIFY_INVALID", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const chapterText = typeof body.chapterText === "string" ? body.chapterText : "";
    const contract = body.contract as Record<string, unknown> | undefined;
    if (!chapterText || !contract) {
      return c.json({ code: "CONTRACT_VERIFY_MISSING_FIELDS", message: "chapterText and contract are required" }, 422);
    }

    const report = verifyContractSatisfaction({
      chapterText,
      mustInclude: Array.isArray(contract.mustInclude) ? contract.mustInclude as string[] : [],
      mustAvoid: Array.isArray(contract.mustAvoid) ? contract.mustAvoid as string[] : [],
      sceneBeats: Array.isArray(contract.sceneBeats) ? contract.sceneBeats as string[] : [],
      goal: typeof contract.goal === "string" ? contract.goal : undefined,
    });

    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const bookId = typeof body.bookId === "string" ? body.bookId : undefined;
    if (sessionId) {
      await artifactService.create({
        sessionId,
        bookId,
        type: "contract_verification",
        title: "契约验证报告",
        payload: report as unknown as Record<string, unknown>,
        summary: `satisfactionRate=${report.satisfactionRate}, shouldRewrite=${report.shouldRewrite}`,
        searchableText: JSON.stringify(report),
      });
    }

    return c.json({ report });
  });

  // --- P2: Narrative Graph API ---

  app.get("/api/books/:id/narrative-graph", async (c) => {
    const id = c.req.param("id");
    try {
      const graph = await narrativeGraphService.loadGraph(id);
      return c.json({ graph });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/books/:id/narrative-graph/patches", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "PATCH_INVALID", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const operations = body.operations as ReadonlyArray<NarrativeGraphOperation> | undefined;
    const reason = typeof body.reason === "string" ? body.reason : "user edit";
    if (!operations || !Array.isArray(operations) || operations.length === 0) {
      return c.json({ code: "PATCH_NO_OPERATIONS", message: "operations array is required" }, 422);
    }
    try {
      const patch = await narrativeGraphService.createPatch(id, operations, reason);
      return c.json({ patch });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/books/:id/narrative-graph/patches/:patchId/apply", async (c) => {
    const id = c.req.param("id");
    const patchId = c.req.param("patchId");
    try {
      const graph = await narrativeGraphService.applyPatch(id, patchId);
      return c.json({ ok: true, graph });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/books/:id/narrative-graph/patches/:patchId/rollback", async (c) => {
    const id = c.req.param("id");
    const patchId = c.req.param("patchId");
    try {
      const graph = await narrativeGraphService.rollbackPatch(id, patchId);
      return c.json({ ok: true, graph });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get("/api/books/:id/narrative-graph/patches", async (c) => {
    const id = c.req.param("id");
    const patches = await narrativeGraphService.listPatches(id);
    return c.json({ patches });
  });

  app.post("/api/books/:id/narrative-graph/patches/:patchId/compile-steering", async (c) => {
    const id = c.req.param("id");
    const patchId = c.req.param("patchId");
    try {
      const patches = await narrativeGraphService.getUnconsumedPatches(id);
      const targetPatches = patchId === "all" ? patches : patches.filter((p) => p.patchId === patchId);
      const result = compileGraphPatchesToSteering(targetPatches);
      return c.json({ steering: result });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });


  // --- Blueprint Preview (P1) ---

  app.post("/api/assistant/blueprint/preview", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "BLUEPRINT_INVALID", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : `sess_${Date.now().toString(36)}`;
    const bookId = typeof body.bookId === "string" && body.bookId.trim() ? body.bookId.trim() : undefined;

    // Accept either an explicit compiled contract or a raw contract object
    const rawContract = body.contract as Record<string, unknown> | undefined;
    if (!rawContract) {
      return c.json({ code: "BLUEPRINT_NO_CONTRACT", message: "contract is required" }, 422);
    }
    const compiled = {
      goal: typeof rawContract.goal === "string" ? rawContract.goal : undefined,
      mustInclude: Array.isArray(rawContract.mustInclude) ? rawContract.mustInclude as string[] : [],
      mustAvoid: Array.isArray(rawContract.mustAvoid) ? rawContract.mustAvoid as string[] : [],
      sceneBeats: Array.isArray(rawContract.sceneBeats) ? rawContract.sceneBeats as string[] : [],
      payoffRequired: typeof rawContract.payoffRequired === "string" ? rawContract.payoffRequired : undefined,
      endingHook: typeof rawContract.endingHook === "string" ? rawContract.endingHook : undefined,
    };
    const sourceArtifactIds: string[] = Array.isArray(rawContract.sourceArtifactIds)
      ? rawContract.sourceArtifactIds.filter((x): x is string => typeof x === "string")
      : [];

    const blueprint = buildBlueprintFromContract(compiled, bookId ?? "");
    const blueprintWithMeta = {
      ...blueprint,
      status: "draft" as const,
      version: 1,
      sourceArtifactIds,
    };

    // Save as artifacts for session history
    const contractArt = await artifactService.create({
      sessionId,
      bookId,
      type: "chapter_steering_contract",
      title: "章节干预契约",
      payload: rawContract,
      summary: `Contract: ${compiled.mustInclude.length} mustInclude, priority=${typeof rawContract.priority === "string" ? rawContract.priority : "normal"}`,
      searchableText: typeof rawContract.rawRequest === "string" ? rawContract.rawRequest : JSON.stringify(compiled.mustInclude),
    });
    const blueprintArt = await artifactService.create({
      sessionId,
      bookId,
      type: "chapter_blueprint",
      title: "章节戏剧蓝图",
      payload: blueprintWithMeta as unknown as Record<string, unknown>,
      summary: `Blueprint v1: ${blueprint.scenes.length} scenes, status=draft`,
      searchableText: JSON.stringify(blueprintWithMeta),
    });
    // Patch artifact payload to be self-describing (includes its own artifactId)
    const blueprintWithArtifactId = { ...blueprintWithMeta, artifactId: blueprintArt.artifactId };
    await artifactService.update(blueprintArt.artifactId, sessionId, {
      bookId,
      payload: blueprintWithArtifactId as unknown as Record<string, unknown>,
      summary: `Blueprint v1: ${blueprint.scenes.length} scenes, status=draft`,
      searchableText: JSON.stringify(blueprintWithArtifactId),
    });

    return c.json({
      blueprint: blueprintWithArtifactId,
      artifactIds: {
        contract: contractArt.artifactId,
        blueprint: blueprintArt.artifactId,
      },
    });
  });

  // --- Blueprint fetch (GET) ---

  app.get("/api/assistant/artifact/:artifactId", async (c) => {
    const artifactId = c.req.param("artifactId");
    const sessionId = c.req.query("sessionId") ?? "";
    const bookId = c.req.query("bookId");
    const art = await artifactService.getById(artifactId, sessionId, bookId);
    if (!art) {
      return c.json({ code: "ARTIFACT_NOT_FOUND", message: `Artifact ${artifactId} not found` }, 404);
    }
    return c.json({ artifact: art });
  });

  // --- Blueprint edit (PUT) ---

  app.put("/api/assistant/blueprint/:artifactId", async (c) => {
    const artifactId = c.req.param("artifactId");
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "BLUEPRINT_INVALID", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : "";
    if (!sessionId) {
      return c.json({ code: "BLUEPRINT_EDIT_VALIDATION_FAILED", errors: [{ field: "sessionId", message: "sessionId is required" }] }, 422);
    }
    const bookId = typeof body.bookId === "string" && body.bookId.trim() ? body.bookId.trim() : undefined;
    const patch = body.patch as Record<string, unknown> | undefined;
    if (!patch) {
      return c.json({ code: "BLUEPRINT_EDIT_VALIDATION_FAILED", errors: [{ field: "patch", message: "patch is required" }] }, 422);
    }

    const existing = await artifactService.getById(artifactId, sessionId, bookId);
    if (!existing) {
      return c.json({ code: "BLUEPRINT_NOT_FOUND", message: `Blueprint artifact ${artifactId} not found` }, 404);
    }
    if (existing.type !== "chapter_blueprint") {
      return c.json({ code: "BLUEPRINT_TYPE_MISMATCH", message: `Artifact ${artifactId} is not a chapter_blueprint` }, 422);
    }

    const currentVersion = typeof existing.payload.version === "number" ? existing.payload.version : 1;
    const merged: Record<string, unknown> = {
      ...existing.payload,
      ...patch,
      status: "edited" as const,
      version: currentVersion + 1,
      previousArtifactId: artifactId,
    };

    const sceneCount = Array.isArray(merged.scenes) ? merged.scenes.length : "?";
    const updated = await artifactService.update(artifactId, sessionId, {
      bookId,
      payload: merged,
      summary: `Blueprint v${currentVersion + 1}: ${sceneCount} scenes, status=edited`,
      searchableText: JSON.stringify(merged),
    });
    if (!updated) {
      return c.json({ code: "BLUEPRINT_UPDATE_FAILED", message: "Failed to update artifact" }, 500);
    }

    return c.json({ blueprint: merged, artifactId });
  });

  // --- Blueprint confirm (POST) ---

  app.post("/api/assistant/blueprint/:artifactId/confirm", async (c) => {
    const artifactId = c.req.param("artifactId");
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "BLUEPRINT_INVALID", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : "";
    if (!sessionId) {
      return c.json({ code: "BLUEPRINT_CONFIRM_VALIDATION_FAILED", errors: [{ field: "sessionId", message: "sessionId is required" }] }, 422);
    }
    const bookId = typeof body.bookId === "string" && body.bookId.trim() ? body.bookId.trim() : undefined;

    const existing = await artifactService.getById(artifactId, sessionId, bookId);
    if (!existing) {
      return c.json({ code: "BLUEPRINT_NOT_FOUND", message: `Blueprint artifact ${artifactId} not found` }, 404);
    }
    if (existing.type !== "chapter_blueprint") {
      return c.json({ code: "BLUEPRINT_TYPE_MISMATCH", message: `Artifact ${artifactId} is not a chapter_blueprint` }, 422);
    }

    const currentVersion = typeof existing.payload.version === "number" ? existing.payload.version : 1;
    const confirmed = {
      ...existing.payload,
      status: "confirmed" as const,
      version: currentVersion + 1,
      previousArtifactId: artifactId,
    };

    const updated = await artifactService.update(artifactId, sessionId, {
      bookId,
      payload: confirmed,
      summary: `Blueprint v${currentVersion + 1}: confirmed`,
      searchableText: JSON.stringify(confirmed),
    });
    if (!updated) {
      return c.json({ code: "BLUEPRINT_CONFIRM_FAILED", message: "Failed to confirm artifact" }, 500);
    }

    return c.json({ blueprint: confirmed, artifactId });
  });

  // --- P5: Developmental Editor API ---

  app.post("/api/assistant/editor/evaluate", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ code: "EDITOR_INVALID", errors: [{ field: "body", message: "Must be a JSON object" }] }, 422);
    }
    const chapterText = typeof body.chapterText === "string" ? body.chapterText : "";
    const chapterNumber = typeof body.chapterNumber === "number" ? body.chapterNumber : 1;
    const contract = body.steeringContract as Record<string, unknown> | undefined;
    const report = evaluateChapterDrama({
      chapterText,
      chapterNumber,
      steeringContract: contract ? {
        mustInclude: Array.isArray(contract.mustInclude) ? contract.mustInclude as string[] : [],
        mustAvoid: Array.isArray(contract.mustAvoid) ? contract.mustAvoid as string[] : [],
      } : undefined,
    });
    return c.json({ report });
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
    const reviseMode = (body.mode ?? "spot-fix") as "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect" | "chapter-redesign";

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
        reviseMode as never,
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
          if (typeof afterContent === "string" && afterContent.trim().length > 0) {
            await refreshBookMemory(id, chapterNum, "revise", {
              mode: reviseMode,
              decision,
              fixedCount: result.fixedIssues.length,
              status: result.status,
            }, afterContent);
          }
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
      chapterLengthTolerancePercent?: number;
      targetChapters?: number;
      status?: string;
      language?: string;
    }>();
    try {
      const book = await state.loadBookConfig(id);
      const isReleaseCandidate = (await readPersistedBookConfigRecord(id))?.is_release_candidate === true;
      const updated = {
        ...book,
        is_release_candidate: isReleaseCandidate,
        ...(updates.chapterWordCount !== undefined ? { chapterWordCount: Number(updates.chapterWordCount) } : {}),
        ...(updates.chapterLengthTolerancePercent !== undefined ? { chapterLengthTolerancePercent: clampChapterLengthTolerance(Number(updates.chapterLengthTolerancePercent)) } : {}),
        ...(updates.targetChapters !== undefined ? { targetChapters: Number(updates.targetChapters) } : {}),
        ...(updates.status !== undefined ? { status: updates.status as typeof book.status } : {}),
        ...(updates.language !== undefined ? { language: updates.language as "zh" | "en" } : {}),
        updatedAt: new Date().toISOString(),
      };
      await state.saveBookConfig(id, updated);
      await persistBookConfigRecord(id, updated);
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
      await assistantMemoryService.writeMemory(
        "market",
        result,
        {},
        { expiresAt: new Date(Date.now() + ASSISTANT_MARKET_MEMORY_TTL_MS).toISOString() },
      );
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
      await chatCompletion(client, currentConfig.llm.model, [
        { role: "user", content: "用中文只回复两个字：正常" },
      ], { maxTokens: 256 });
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
  const config = await loadProjectConfig(root, { requireApiKey: false });

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
        const server = serve({ fetch: app.fetch, port: tryPort, hostname: "127.0.0.1" }, () => {
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
