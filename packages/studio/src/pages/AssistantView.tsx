import { useEffect, useMemo, useRef, useState } from "react";
import { BotMessageSquare, Loader2, Send, Sparkles } from "lucide-react";
import type { Theme } from "../hooks/use-theme";
import type { StringKey, TFunction } from "../hooks/use-i18n";
import { fetchJson, postApi, useApi } from "../hooks/use-api";
import {
  parseAssistantOperatorCommand,
  type AssistantOperatorParseResult,
} from "../api/services/assistant-command-parser";
import { TaskPlanCard } from "../components/assistant/TaskPlanCard";
import { QualityReportCard, type QualityReportPayload } from "../components/assistant/QualityReportCard";
import {
  WorldConsistencyMarketCard,
  type AssistantWorldConsistencyMarketReport,
} from "../components/assistant/WorldConsistencyMarketCard";
import { cn } from "../lib/utils";
import { useSSE, type SSEMessage } from "../hooks/use-sse";

interface Nav {
  toDashboard: () => void;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
}

export interface AssistantComposerState {
  readonly input: string;
  readonly messages: ReadonlyArray<AssistantMessage>;
  readonly loading: boolean;
  readonly nextMessageId: number;
  readonly taskPlan: AssistantTaskPlan | null;
  readonly taskExecution: AssistantTaskExecution | null;
  readonly qualityReport: QualityReportPayload | null;
  readonly worldConsistencyReport: AssistantWorldConsistencyMarketReport | null;
  readonly suggestedNextActions: ReadonlyArray<string>;
  readonly operatorSession: AssistantOperatorSession;
}

export interface AssistantQuickAction {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export interface AssistantOperatorSession {
  readonly goal: string | null;
  readonly paused: boolean;
  readonly traceEnabled: boolean;
  readonly lastApprovedTarget: string | null;
  readonly lastRollbackRunId: string | null;
  readonly budget: {
    readonly spent: number;
    readonly limit: number;
    readonly currency: string;
  };
}

export type AssistantBookScopeMode = "single" | "multi" | "all-active";

export type AssistantBookActionType = "write-next" | "audit" | "template";
export type AssistantTemplateRiskLevel = "L0" | "L1";

export interface AssistantConfirmationDraft {
  readonly action: AssistantBookActionType;
  readonly prompt: string;
  readonly targetBookIds: ReadonlyArray<string>;
  readonly chapterNumber?: number;
  readonly templateId?: string;
  readonly templateRiskLevel?: AssistantTemplateRiskLevel;
  readonly templateNextAction?: string;
}

export type AssistantTaskPlanStatus = "draft" | "awaiting-confirm" | "running" | "succeeded" | "failed" | "cancelled";

export interface AssistantTaskPlan extends AssistantConfirmationDraft {
  readonly id: string;
  readonly status: AssistantTaskPlanStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AssistantTaskTimelineEntry {
  readonly id: string;
  readonly event: "assistant:step:start" | "assistant:step:success" | "assistant:step:fail" | "assistant:done";
  readonly taskId: string;
  readonly stepId?: string;
  readonly action?: string;
  readonly message: string;
  readonly timestamp: number;
}

export interface AssistantTaskExecution {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly stepRunIds?: Record<string, string>;
  readonly timeline: ReadonlyArray<AssistantTaskTimelineEntry>;
  readonly lastSyncedAt: number;
  readonly nextSequence: number;
}

export interface AssistantEvaluateResponse {
  readonly taskId: string;
  readonly report: QualityReportPayload;
  readonly suggestedNextActions: ReadonlyArray<string>;
}

export interface AssistantWorldReportResponse {
  readonly bookId: string;
  readonly report: AssistantWorldConsistencyMarketReport;
}

export type AssistantCrudReadDimension = "book" | "volume" | "chapter" | "character" | "hook";

export interface AssistantCrudEvidence {
  readonly source: string;
  readonly locator: string;
  readonly excerpt: string;
}

export interface AssistantCrudReadResponse {
  readonly ok: boolean;
  readonly dimension: AssistantCrudReadDimension;
  readonly bookId: string;
  readonly chapter?: number;
  readonly keyword?: string;
  readonly summary: string;
  readonly evidence: ReadonlyArray<AssistantCrudEvidence>;
}

export interface AssistantCrudDeletePreviewResponse {
  readonly ok: boolean;
  readonly requiresConfirmation: boolean;
  readonly preview: {
    readonly target: "chapter" | "run";
    readonly bookId: string;
    readonly impactSummary: string;
    readonly evidence: ReadonlyArray<AssistantCrudEvidence>;
    readonly previewId: string;
    readonly confirmBy: string;
  };
}

export interface AssistantCrudDeleteExecuteResponse {
  readonly ok: boolean;
  readonly target: "chapter" | "run";
  readonly bookId: string;
  readonly chapter?: number;
  readonly runId?: string;
  readonly restoreId: string;
  readonly deletedAt: string;
  readonly recoverBefore: string;
}

export interface AssistantPromptTemplate {
  readonly id: string;
  readonly labelKey: StringKey;
  readonly prompt: string;
  readonly riskLevel: AssistantTemplateRiskLevel;
  readonly defaultNextAction: string;
}

interface AssistantTaskSnapshot {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly currentStepId?: string;
  readonly steps: Record<string, {
    readonly stepId: string;
    readonly action?: string;
    readonly status: "running" | "succeeded" | "failed";
    readonly startedAt?: string;
    readonly finishedAt?: string;
    readonly error?: string;
  }>;
  readonly lastUpdatedAt: string;
  readonly error?: string;
}

const MOCK_ASSISTANT_RESPONSE_DELAY_MS = 450;
const ASSISTANT_TIMELINE_MAX_ENTRIES = 50;
const ASSISTANT_TASK_SNAPSHOT_POLL_INTERVAL_MS = 2000;
const ASSISTANT_TASK_RECOVERY_STORAGE_KEY = "inkos.assistant.task-recovery";
const BOOK_STATUS_ACTIVE = "active";
const WRITE_NEXT_ACTION_PATTERN = /写下一章|write[-\s]?next/u;
const AUDIT_ACTION_PATTERN = /审计|audit/iu;
const CRUD_READ_ACTION_PATTERN = /查询|查看|检索|read|search/iu;
const CRUD_DELETE_ACTION_PATTERN = /删除|delete/iu;
const CRUD_RESTORE_ACTION_PATTERN = /恢复|restore/iu;
const WORLD_REPORT_ACTION_PATTERN = /(一致性报告|world\s*consistency|市场策略|market\s*(strategy|memory)|题材趋势)/iu;
const CRUD_DIMENSION_VOLUME_PATTERN = /卷|volume/iu;
const CRUD_DIMENSION_CHAPTER_PATTERN = /章|chapter/iu;
const CRUD_DIMENSION_CHARACTER_PATTERN = /角色|character/iu;
const CRUD_DIMENSION_HOOK_PATTERN = /伏笔|hook/iu;
const CRUD_RUN_ID_PATTERN = /(run[_-][a-z0-9-]+)/iu;
const AUDIT_CHAPTER_ZH_PATTERN = /第\s*(\d+)\s*章/u;
const AUDIT_CHAPTER_EN_PATTERN = /chapter\s*(\d+)/iu;
const ACTION_LABEL_KEY_BY_TYPE: Record<AssistantBookActionType, "assistant.actionWriteNext" | "assistant.actionAudit" | "assistant.actionTemplate"> = {
  "write-next": "assistant.actionWriteNext",
  audit: "assistant.actionAudit",
  template: "assistant.actionTemplate",
};
const ASSISTANT_EVENT_SET = new Set([
  "assistant:step:start",
  "assistant:step:success",
  "assistant:step:fail",
  "assistant:done",
]);
const VALID_ASSISTANT_TASK_PLAN_TRANSITIONS: Record<AssistantTaskPlanStatus, ReadonlyArray<AssistantTaskPlanStatus>> = {
  draft: ["awaiting-confirm", "cancelled"],
  "awaiting-confirm": ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
const ASSISTANT_OPERATOR_RECEIPT_PREFIX = "[Operator Receipt]";
const ASSISTANT_DEFAULT_OPERATOR_SESSION: AssistantOperatorSession = {
  goal: null,
  paused: false,
  traceEnabled: false,
  lastApprovedTarget: null,
  lastRollbackRunId: null,
  budget: {
    spent: 0,
    limit: 0,
    currency: "tokens",
  },
};

export const ASSISTANT_QUICK_ACTIONS: ReadonlyArray<AssistantQuickAction> = [
  { id: "outline", label: "生成大纲", prompt: "请帮我生成下一章节的大纲。" },
  { id: "recap", label: "总结进度", prompt: "请总结当前剧情进度和关键冲突。" },
  { id: "style", label: "优化文风", prompt: "请给我 3 条当前文本的文风优化建议。" },
];

export const ASSISTANT_PROMPT_TEMPLATES: ReadonlyArray<AssistantPromptTemplate> = [
  {
    id: "template-structure",
    labelKey: "assistant.templateStructure",
    prompt: "请基于当前目标输入生成 3 卷 30 章结构，并给出蓝图与章节计划。",
    riskLevel: "L1",
    defaultNextAction: "write-next",
  },
  {
    id: "template-write-next",
    labelKey: "assistant.templateWriteNextAudit",
    prompt: "请按当前设定写下一章并完成一次自审。",
    riskLevel: "L0",
    defaultNextAction: "re-audit",
  },
  {
    id: "template-audit-repair",
    labelKey: "assistant.templateRecentAuditRepair",
    prompt: "请审计最近三章并给出最小修复方案，然后执行 spot-fix。",
    riskLevel: "L1",
    defaultNextAction: "write-next",
  },
  {
    id: "template-weekly-plan",
    labelKey: "assistant.templateWeeklyPlan",
    prompt: "请生成本周更新计划（字数、节奏、伏笔）并标注关键风险。",
    riskLevel: "L0",
    defaultNextAction: "write-next",
  },
];

export function createAssistantInitialState(): AssistantComposerState {
  return {
    input: "",
    messages: [],
    loading: false,
    nextMessageId: 1,
    taskPlan: null,
    taskExecution: null,
    qualityReport: null,
    worldConsistencyReport: null,
    suggestedNextActions: [],
    operatorSession: ASSISTANT_DEFAULT_OPERATOR_SESSION,
  };
}

export function parseAssistantEventTimestamp(input: unknown, fallback = Date.now()): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

interface AssistantTaskRecoveryPayload {
  readonly version: 1;
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: AssistantTaskExecution["status"];
  readonly taskPlan?: AssistantTaskPlan;
  readonly persistedAt: number;
}

export function buildAssistantTaskRecoveryPayload(state: AssistantComposerState, now = Date.now()): AssistantTaskRecoveryPayload | null {
  if (!state.taskExecution) {
    return null;
  }
  return {
    version: 1,
    taskId: state.taskExecution.taskId,
    sessionId: state.taskExecution.sessionId,
    status: state.taskExecution.status,
    ...(state.taskPlan ? { taskPlan: state.taskPlan } : {}),
    persistedAt: now,
  };
}

export function parseAssistantTaskRecoveryPayload(raw: string | null): AssistantTaskRecoveryPayload | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") {
      return {
        version: 1,
        taskId: parsed,
        sessionId: "",
        status: "running",
        persistedAt: Date.now(),
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const payload = parsed as Record<string, unknown>;
    const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
    if (!taskId) {
      return null;
    }
    const status = payload.status === "succeeded" || payload.status === "failed" ? payload.status : "running";
    return {
      version: 1,
      taskId,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      status,
      ...(typeof payload.taskPlan === "object" && payload.taskPlan !== null && !Array.isArray(payload.taskPlan)
        ? { taskPlan: payload.taskPlan as AssistantTaskPlan }
        : {}),
      persistedAt: typeof payload.persistedAt === "number" && Number.isFinite(payload.persistedAt)
        ? payload.persistedAt
        : Date.now(),
    };
  } catch {
    return null;
  }
}

export function recoverAssistantStateFromSnapshot(
  state: AssistantComposerState,
  snapshot: AssistantTaskSnapshot,
  payload: AssistantTaskRecoveryPayload,
): AssistantComposerState {
  const recoveredTaskPlan = state.taskPlan
    ?? (payload.taskPlan ? transitionAssistantTaskPlan(payload.taskPlan, snapshot.status, Date.now()) : null);
  const seeded: AssistantComposerState = {
    ...state,
    loading: snapshot.status === "running" || state.loading,
    taskPlan: recoveredTaskPlan,
    taskExecution: {
      taskId: snapshot.taskId,
      sessionId: snapshot.sessionId || payload.sessionId,
      status: snapshot.status,
      timeline: state.taskExecution?.taskId === snapshot.taskId ? state.taskExecution.timeline : [],
      lastSyncedAt: state.taskExecution?.taskId === snapshot.taskId ? state.taskExecution.lastSyncedAt : Date.now(),
      nextSequence: state.taskExecution?.taskId === snapshot.taskId ? state.taskExecution.nextSequence : 0,
      ...(state.taskExecution?.taskId === snapshot.taskId && state.taskExecution.stepRunIds ? { stepRunIds: state.taskExecution.stepRunIds } : {}),
    },
  };
  return reconcileAssistantTaskFromSnapshot(seeded, snapshot);
}

export function formatAssistantTimelineMessage(
  event: AssistantTaskTimelineEntry["event"],
  payload: { readonly stepId?: string; readonly action?: string; readonly error?: string; readonly status?: string },
): string {
  if (event === "assistant:done") {
    return payload.status === "succeeded" ? "任务完成" : `任务失败${payload.error ? `：${payload.error}` : ""}`;
  }
  const stepText = payload.stepId ? `步骤 ${payload.stepId}` : "步骤";
  const actionText = payload.action ? `（${payload.action}）` : "";
  if (event === "assistant:step:start") return `${stepText}${actionText} 开始`;
  if (event === "assistant:step:success") return `${stepText}${actionText} 成功`;
  return `${stepText}${actionText} 失败${payload.error ? `：${payload.error}` : ""}`;
}

export function applyAssistantTaskEventFromSSE(state: AssistantComposerState, message: SSEMessage): AssistantComposerState {
  if (!ASSISTANT_EVENT_SET.has(message.event)) {
    return state;
  }
  const payload = typeof message.data === "object" && message.data !== null ? message.data as Record<string, unknown> : null;
  const taskId = typeof payload?.taskId === "string" ? payload.taskId : "";
  if (!taskId || (state.taskExecution && state.taskExecution.taskId !== taskId)) {
    return state;
  }
  const timestamp = parseAssistantEventTimestamp(payload?.timestamp, message.timestamp);
  const currentExecution = state.taskExecution ?? {
    taskId,
    sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : "",
    status: "running" as const,
    timeline: [],
    lastSyncedAt: timestamp,
    nextSequence: 0,
  };
  const nextEntry: AssistantTaskTimelineEntry = {
    id: `${taskId}-${currentExecution.nextSequence}`,
    event: message.event as AssistantTaskTimelineEntry["event"],
    taskId,
    ...(typeof payload?.stepId === "string" ? { stepId: payload.stepId } : {}),
    ...(typeof payload?.action === "string" ? { action: payload.action } : {}),
    message: formatAssistantTimelineMessage(
      message.event as AssistantTaskTimelineEntry["event"],
      {
        ...(typeof payload?.stepId === "string" ? { stepId: payload.stepId } : {}),
        ...(typeof payload?.action === "string" ? { action: payload.action } : {}),
        ...(typeof payload?.error === "string" ? { error: payload.error } : {}),
        ...(typeof payload?.status === "string" ? { status: payload.status } : {}),
      },
    ),
    timestamp,
  };
  const terminal = message.event === "assistant:done";
  const taskStatus = message.event === "assistant:done"
    ? (payload?.status === "succeeded" ? "succeeded" : "failed")
    : "running";
  return {
    ...state,
    loading: terminal ? false : state.loading,
    taskPlan: terminal
      ? (state.taskPlan ? transitionAssistantTaskPlan(state.taskPlan, taskStatus, timestamp) : state.taskPlan)
      : state.taskPlan,
    taskExecution: {
      ...currentExecution,
      status: taskStatus,
      timeline: [...currentExecution.timeline.slice(-(ASSISTANT_TIMELINE_MAX_ENTRIES - 1)), nextEntry],
      lastSyncedAt: timestamp,
      nextSequence: currentExecution.nextSequence + 1,
    },
  };
}

export function reconcileAssistantTaskFromSnapshot(
  state: AssistantComposerState,
  snapshot: AssistantTaskSnapshot,
): AssistantComposerState {
  if (!state.taskExecution || state.taskExecution.taskId !== snapshot.taskId) {
    return state;
  }
  const timeline = Object.values(snapshot.steps)
    .flatMap((step) => {
      const entries: AssistantTaskTimelineEntry[] = [];
      if (step.startedAt) {
        const startedAt = parseAssistantEventTimestamp(step.startedAt);
        entries.push({
          id: `${snapshot.taskId}-${step.stepId}-start-${startedAt}`,
          event: "assistant:step:start",
          taskId: snapshot.taskId,
          stepId: step.stepId,
          ...(step.action ? { action: step.action } : {}),
          message: formatAssistantTimelineMessage("assistant:step:start", { stepId: step.stepId, action: step.action }),
          timestamp: startedAt,
        });
      }
      if (step.status !== "running" && step.finishedAt) {
        const event = step.status === "succeeded" ? "assistant:step:success" : "assistant:step:fail";
        const finishedAt = parseAssistantEventTimestamp(step.finishedAt);
        entries.push({
          id: `${snapshot.taskId}-${step.stepId}-${event}-${finishedAt}`,
          event,
          taskId: snapshot.taskId,
          stepId: step.stepId,
          ...(step.action ? { action: step.action } : {}),
          message: formatAssistantTimelineMessage(event, { stepId: step.stepId, action: step.action, error: step.error }),
          timestamp: finishedAt,
        });
      }
      return entries;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  if (snapshot.status !== "running") {
    const doneAt = parseAssistantEventTimestamp(snapshot.lastUpdatedAt);
    timeline.push({
      id: `${snapshot.taskId}-done-${doneAt}`,
      event: "assistant:done",
      taskId: snapshot.taskId,
      message: formatAssistantTimelineMessage("assistant:done", { status: snapshot.status, error: snapshot.error }),
      timestamp: doneAt,
    });
  }
  const done = snapshot.status !== "running";
  return {
    ...state,
    loading: done ? false : state.loading,
    taskPlan: done ? (state.taskPlan ? transitionAssistantTaskPlan(state.taskPlan, snapshot.status, Date.now()) : state.taskPlan) : state.taskPlan,
    taskExecution: {
      taskId: snapshot.taskId,
      sessionId: snapshot.sessionId,
      status: snapshot.status,
      stepRunIds: state.taskExecution.stepRunIds,
      timeline,
      lastSyncedAt: Date.now(),
      nextSequence: timeline.length,
    },
  };
}

export function AssistantTimeline({ entries }: { readonly entries: ReadonlyArray<AssistantTaskTimelineEntry> }) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <section
      className="mt-3 rounded-md border border-border/70 bg-card/40 p-3"
      data-testid="assistant-task-timeline"
      aria-label="assistant task timeline"
    >
      <div className="text-xs text-muted-foreground mb-2">任务进度</div>
      <ul className="space-y-1 text-xs">
        {entries.map((entry) => (
          <li key={entry.id} data-testid="assistant-task-timeline-item">
            {new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })} · {entry.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function createAssistantTaskPlanDraft(draft: AssistantConfirmationDraft, now = Date.now()): AssistantTaskPlan {
  return {
    ...draft,
    id: `plan-${now}`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionAssistantTaskPlan(
  taskPlan: AssistantTaskPlan,
  status: AssistantTaskPlanStatus,
  now = Date.now(),
): AssistantTaskPlan {
  if (taskPlan.status === status) {
    return taskPlan;
  }
  if (!VALID_ASSISTANT_TASK_PLAN_TRANSITIONS[taskPlan.status].includes(status)) {
    return taskPlan;
  }
  return {
    ...taskPlan,
    status,
    updatedAt: now,
  };
}

export function applyAssistantInput(state: AssistantComposerState, input: string): AssistantComposerState {
  return {
    ...state,
    input,
  };
}

export function applyAssistantIncomingPrompt(state: AssistantComposerState, prompt: string): AssistantComposerState {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return state;
  }
  return applyAssistantInput(state, normalizedPrompt);
}

export function submitAssistantInput(
  state: AssistantComposerState,
  prompt: string,
  now = Date.now(),
): AssistantComposerState {
  const normalized = prompt.trim();
  if (!normalized || state.loading) {
    return state;
  }

  return {
    input: "",
    loading: true,
    messages: [...state.messages, { id: `msg-${state.nextMessageId}`, role: "user", content: normalized, timestamp: now }],
    nextMessageId: state.nextMessageId + 1,
    taskPlan: state.taskPlan,
    taskExecution: state.taskExecution,
    qualityReport: state.qualityReport,
    worldConsistencyReport: state.worldConsistencyReport,
    suggestedNextActions: state.suggestedNextActions,
    operatorSession: state.operatorSession,
  };
}

export function completeAssistantResponse(
  state: AssistantComposerState,
  prompt: string,
  now = Date.now(),
): AssistantComposerState {
  return {
    ...state,
    loading: false,
    taskPlan: state.taskPlan,
    taskExecution: state.taskExecution,
    qualityReport: state.qualityReport,
    worldConsistencyReport: state.worldConsistencyReport,
    suggestedNextActions: state.suggestedNextActions,
    operatorSession: state.operatorSession,
    messages: [...state.messages, {
      id: `msg-${state.nextMessageId}`,
      role: "assistant",
      content: generateAssistantSkeletonReply(prompt),
      timestamp: now,
    }],
    nextMessageId: state.nextMessageId + 1,
  };
}

export function applyAssistantQuickAction(
  state: AssistantComposerState,
  action: AssistantQuickAction,
  now = Date.now(),
): AssistantComposerState {
  return submitAssistantInput(state, action.prompt, now);
}

function appendAssistantOperatorExchange(
  state: AssistantComposerState,
  prompt: string,
  receipt: string,
  now = Date.now(),
): AssistantComposerState {
  return {
    ...state,
    input: "",
    loading: false,
    messages: [
      ...state.messages,
      { id: `msg-${state.nextMessageId}`, role: "user", content: prompt, timestamp: now },
      { id: `msg-${state.nextMessageId + 1}`, role: "assistant", content: receipt, timestamp: now },
    ],
    nextMessageId: state.nextMessageId + 2,
    qualityReport: state.qualityReport,
    worldConsistencyReport: state.worldConsistencyReport,
    suggestedNextActions: state.suggestedNextActions,
  };
}

function buildAssistantOperatorReceipt(rawCommand: string, result: "ok" | "error", message: string): string {
  const safeCommand = sanitizeAssistantOperatorReceiptValue(rawCommand);
  const safeMessage = sanitizeAssistantOperatorReceiptValue(message);
  return `${ASSISTANT_OPERATOR_RECEIPT_PREFIX}\n- command: ${safeCommand}\n- result: ${result}\n- message: ${safeMessage}`;
}

function sanitizeAssistantOperatorReceiptValue(value: string): string {
  return value.replace(/\r?\n/gu, " ").trim();
}

function buildAssistantOperatorStatusMessage(operatorSession: AssistantOperatorSession): string {
  const budget = operatorSession.budget;
  return [
    `goal=${operatorSession.goal ?? "未设置"}`,
    `session=${operatorSession.paused ? "paused" : "running"}`,
    `trace=${operatorSession.traceEnabled ? "on" : "off"}`,
    `budget=${budget.spent}/${budget.limit} ${budget.currency}`,
  ].join("; ");
}

export function applyAssistantOperatorCommand(
  state: AssistantComposerState,
  prompt: string,
  now = Date.now(),
): AssistantComposerState | null {
  const parsed = parseAssistantOperatorCommand(prompt);
  if (parsed.kind === "not-command") {
    return null;
  }
  if (parsed.kind === "error") {
    return appendAssistantOperatorExchange(
      state,
      parsed.raw,
      buildAssistantOperatorReceipt(parsed.raw, "error", parsed.error),
      now,
    );
  }

  const rawCommand = parsed.raw;
  const commandResult = runAssistantOperatorCommand(state.operatorSession, parsed);
  return appendAssistantOperatorExchange(
    {
      ...state,
      operatorSession: commandResult.session,
    },
    rawCommand,
    buildAssistantOperatorReceipt(rawCommand, commandResult.result, commandResult.message),
    now,
  );
}

function runAssistantOperatorCommand(
  operatorSession: AssistantOperatorSession,
  parsed: Extract<AssistantOperatorParseResult, { kind: "command" }>,
): { readonly session: AssistantOperatorSession; readonly result: "ok" | "error"; readonly message: string } {
  const command = parsed.command;
  switch (command.name) {
    case "goal":
      return {
        session: { ...operatorSession, goal: command.goal },
        result: "ok",
        message: `已更新目标：${command.goal}`,
      };
    case "status":
      return {
        session: operatorSession,
        result: "ok",
        message: buildAssistantOperatorStatusMessage(operatorSession),
      };
    case "pause":
      if (operatorSession.paused) {
        return {
          session: operatorSession,
          result: "error",
          message: "命令执行失败：会话已处于暂停状态。",
        };
      }
      return {
        session: { ...operatorSession, paused: true },
        result: "ok",
        message: "会话已暂停。",
      };
    case "resume":
      if (!operatorSession.paused) {
        return {
          session: operatorSession,
          result: "error",
          message: "命令执行失败：会话当前未暂停。",
        };
      }
      return {
        session: { ...operatorSession, paused: false },
        result: "ok",
        message: "会话已恢复。",
      };
    case "approve":
      return {
        session: { ...operatorSession, lastApprovedTarget: command.targetId },
        result: "ok",
        message: `已审批：${command.targetId}`,
      };
    case "rollback":
      return {
        session: { ...operatorSession, lastRollbackRunId: command.runId },
        result: "ok",
        message: `已触发回滚：${command.runId}`,
      };
    case "trace":
      return {
        session: { ...operatorSession, traceEnabled: command.enabled },
        result: "ok",
        message: `追踪已${command.enabled ? "开启" : "关闭"}。`,
      };
    case "budget":
      return {
        session: operatorSession,
        result: "ok",
        message: `预算使用：${operatorSession.budget.spent}/${operatorSession.budget.limit} ${operatorSession.budget.currency}`,
      };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function resolveAssistantScopeBookIds(
  scopeMode: AssistantBookScopeMode,
  selectedBookIds: ReadonlyArray<string>,
  activeBookIds: ReadonlyArray<string>,
): string[] {
  const activeBookSet = new Set(activeBookIds);
  if (scopeMode === "all-active") {
    return [...activeBookIds];
  }
  if (scopeMode === "single") {
    const selected = selectedBookIds.find((id) => activeBookSet.has(id));
    return selected ? [selected] : [];
  }
  return Array.from(new Set(selectedBookIds.filter((id) => activeBookSet.has(id))));
}

export function canRunScopedBookAction(
  scopeMode: AssistantBookScopeMode,
  selectedBookIds: ReadonlyArray<string>,
  activeBookIds: ReadonlyArray<string>,
): boolean {
  return resolveAssistantScopeBookIds(scopeMode, selectedBookIds, activeBookIds).length > 0;
}

export function resolveAssistantBookTitlesByIds(
  targetBookIds: ReadonlyArray<string>,
  titleById: ReadonlyMap<string, string>,
  t: TFunction,
): string[] {
  return targetBookIds.map((id) => titleById.get(id) ?? t("assistant.scopeUnknownBook"));
}

export function resolveAssistantPromptTemplate(templateId: string): AssistantPromptTemplate | null {
  return ASSISTANT_PROMPT_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

export function buildAssistantTemplateConfirmationDraft(
  template: AssistantPromptTemplate,
  scopeMode: AssistantBookScopeMode,
  selectedBookIds: ReadonlyArray<string>,
  activeBookIds: ReadonlyArray<string>,
): AssistantConfirmationDraft | null {
  const targetBookIds = resolveAssistantScopeBookIds(scopeMode, selectedBookIds, activeBookIds);
  if (targetBookIds.length === 0) return null;
  return {
    action: "template",
    prompt: template.prompt,
    targetBookIds,
    templateId: template.id,
    templateRiskLevel: template.riskLevel,
    templateNextAction: template.defaultNextAction,
  };
}

export function resolveAssistantTemplateSuggestedActions(
  taskPlan: AssistantTaskPlan | null,
  suggestedNextActions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (suggestedNextActions.length > 0) {
    return suggestedNextActions;
  }
  if (taskPlan?.action === "template" && taskPlan.templateNextAction) {
    return [taskPlan.templateNextAction];
  }
  return [];
}

export function detectAssistantBookAction(prompt: string): AssistantBookActionType | null {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return null;
  if (WRITE_NEXT_ACTION_PATTERN.test(normalized)) return "write-next";
  if (AUDIT_ACTION_PATTERN.test(normalized)) return "audit";
  return null;
}

export function parseAssistantCrudReadRequest(prompt: string): {
  readonly dimension: AssistantCrudReadDimension;
  readonly chapter?: number;
  readonly keyword?: string;
} | null {
  const normalized = prompt.trim();
  if (!normalized || !CRUD_READ_ACTION_PATTERN.test(normalized)) {
    return null;
  }
  const dimension: AssistantCrudReadDimension = CRUD_DIMENSION_HOOK_PATTERN.test(normalized)
    ? "hook"
    : CRUD_DIMENSION_CHARACTER_PATTERN.test(normalized)
      ? "character"
      : CRUD_DIMENSION_VOLUME_PATTERN.test(normalized)
        ? "volume"
        : CRUD_DIMENSION_CHAPTER_PATTERN.test(normalized)
          ? "chapter"
          : "book";
  const chapter = dimension === "chapter" ? extractAssistantAuditChapter(normalized) : undefined;
  const keywordMatch = normalized.match(/["“](.+?)["”]/u);
  const keyword = keywordMatch?.[1]?.trim();
  return {
    dimension,
    ...(chapter !== undefined ? { chapter } : {}),
    ...(keyword ? { keyword } : {}),
  };
}

export function parseAssistantCrudDeleteRequest(prompt: string): { readonly target: "chapter" | "run"; readonly chapter?: number; readonly runId?: string } | null {
  const normalized = prompt.trim();
  if (!normalized || !CRUD_DELETE_ACTION_PATTERN.test(normalized)) {
    return null;
  }
  const runId = normalized.match(CRUD_RUN_ID_PATTERN)?.[1];
  if (runId) {
    return { target: "run", runId };
  }
  const chapter = extractAssistantAuditChapter(normalized);
  if (chapter !== undefined) {
    return { target: "chapter", chapter };
  }
  return null;
}

export function parseAssistantCrudRestoreId(prompt: string): string | null {
  const normalized = prompt.trim();
  if (!normalized || !CRUD_RESTORE_ACTION_PATTERN.test(normalized)) {
    return null;
  }
  const token = normalized.match(/(asst_restore_[a-z0-9]+)/iu)?.[1];
  return token ?? null;
}

export function extractAssistantAuditChapter(prompt: string): number | undefined {
  const zhMatch = prompt.match(AUDIT_CHAPTER_ZH_PATTERN);
  if (zhMatch?.[1]) return Number.parseInt(zhMatch[1], 10);
  const enMatch = prompt.match(AUDIT_CHAPTER_EN_PATTERN);
  if (enMatch?.[1]) return Number.parseInt(enMatch[1], 10);
  return undefined;
}

export function buildAssistantConfirmationDraft(
  prompt: string,
  scopeMode: AssistantBookScopeMode,
  selectedBookIds: ReadonlyArray<string>,
  activeBookIds: ReadonlyArray<string>,
): AssistantConfirmationDraft | null {
  const action = detectAssistantBookAction(prompt);
  if (!action) return null;
  const targetBookIds = resolveAssistantScopeBookIds(scopeMode, selectedBookIds, activeBookIds);
  if (targetBookIds.length === 0) return null;
  return {
    action,
    prompt,
    targetBookIds,
    chapterNumber: action === "audit" ? extractAssistantAuditChapter(prompt) : undefined,
  };
}

export function requestAssistantConfirmation(
  state: AssistantComposerState,
  draft: AssistantConfirmationDraft,
  now = Date.now(),
): AssistantComposerState {
  const normalizedPrompt = draft.prompt.trim();
  if (!normalizedPrompt || state.loading || state.taskPlan?.status === "awaiting-confirm" || state.taskPlan?.status === "running") {
    return state;
  }
  const taskPlanDraft = createAssistantTaskPlanDraft(draft, now);
  return {
    ...state,
    input: "",
    loading: false,
    taskPlan: transitionAssistantTaskPlan(taskPlanDraft, "awaiting-confirm", now),
    taskExecution: null,
    qualityReport: null,
    worldConsistencyReport: null,
    suggestedNextActions: [],
    operatorSession: state.operatorSession,
    messages: [...state.messages, { id: `msg-${state.nextMessageId}`, role: "user", content: normalizedPrompt, timestamp: now }],
    nextMessageId: state.nextMessageId + 1,
  };
}

export function confirmAssistantPendingAction(state: AssistantComposerState, now = Date.now()): AssistantComposerState {
  if (!state.taskPlan || state.loading || state.taskPlan.status !== "awaiting-confirm") {
    return state;
  }
  return {
    ...state,
    loading: true,
    taskPlan: transitionAssistantTaskPlan(state.taskPlan, "running", now),
    qualityReport: null,
    worldConsistencyReport: null,
    suggestedNextActions: [],
  };
}

export function cancelAssistantPendingAction(state: AssistantComposerState, now = Date.now()): AssistantComposerState {
  if (!state.taskPlan) {
    return state;
  }
  return {
    ...state,
    loading: false,
    taskPlan: transitionAssistantTaskPlan(state.taskPlan, "cancelled", now),
    taskExecution: null,
    qualityReport: null,
    worldConsistencyReport: null,
    suggestedNextActions: [],
  };
}

export function completeAssistantTaskPlanExecution(
  state: AssistantComposerState,
  status: "succeeded" | "failed",
  now = Date.now(),
): AssistantComposerState {
  if (!state.taskPlan || state.taskPlan.status !== "running") {
    return state;
  }
  return {
    ...state,
    loading: false,
    taskPlan: transitionAssistantTaskPlan(state.taskPlan, status, now),
  };
}

export function generateAssistantSkeletonReply(prompt: string): string {
  return `收到：${prompt}\n\n这是主页面骨架阶段的模拟响应，后续将接入编排与工具调用。`;
}

export function buildAssistantNextActionPrompt(action: string, taskPlan: AssistantTaskPlan | null): string {
  const normalized = action.trim().toLowerCase();
  const chapterLabel = taskPlan?.chapterNumber ? `第${taskPlan.chapterNumber}章` : "当前章节";
  if (normalized === "spot-fix") {
    return `请对${chapterLabel}执行 spot-fix 修复，并聚焦阻断问题。`;
  }
  if (normalized === "re-audit") {
    return `请重新审计${chapterLabel}并给出质量结论。`;
  }
  if (normalized === "write-next") {
    return "请写下一章。";
  }
  return `请执行下一步动作：${action}`;
}

export function buildAssistantWorldRepairPrompt(
  report: AssistantWorldConsistencyMarketReport | null,
  stepId: string,
): string {
  const task = report?.repairTasks.find((item) => item.stepId === stepId);
  if (!task) {
    return `请执行一致性修复任务 ${stepId}。`;
  }
  return `请对第${task.chapter}章执行 ${task.mode} 修复，目标：${task.objective}`;
}

export function collectAssistantStepRunIds(stepRunIds: Record<string, string> | undefined): string[] {
  if (!stepRunIds) return [];
  return Object.entries(stepRunIds).reduce<string[]>((acc, [, runId]) => {
    if (runId.length > 0) {
      acc.push(runId);
    }
    return acc;
  }, []);
}

function EmptyConversation() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground/80 px-6" data-testid="assistant-empty-state">
      <div className="w-14 h-14 rounded-2xl border border-dashed border-border bg-secondary/30 flex items-center justify-center mb-4">
        <BotMessageSquare size={24} className="text-muted-foreground" />
      </div>
      <p className="text-sm">开始一段新对话，或使用下方快捷动作。</p>
    </div>
  );
}

function LoadingConversation() {
  return (
    <div className="h-full flex items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="assistant-loading-state">
      <Loader2 size={16} className="animate-spin" />
      <span>AI 助手正在思考…</span>
    </div>
  );
}

function MessageList({ messages }: { readonly messages: ReadonlyArray<AssistantMessage> }) {
  return (
    <div className="space-y-3">
      {messages.map((message) => (
        <div
          key={message.id}
          className={cn(
            "max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed border",
            message.role === "user"
              ? "ml-auto bg-primary text-primary-foreground border-primary/30"
              : "bg-card text-card-foreground border-border",
          )}
        >
          {message.content}
        </div>
      ))}
    </div>
  );
}

function AssistantCrudReadCard({ result }: { readonly result: AssistantCrudReadResponse }) {
  return (
    <section className="mt-3 rounded-md border border-border/70 bg-card/40 p-3" data-testid="assistant-crud-read-card">
      <div className="text-xs text-muted-foreground">Read · {result.dimension}</div>
      <div className="text-sm mt-1">{result.summary}</div>
      <ul className="mt-2 space-y-1 text-xs">
        {result.evidence.map((item, index) => (
          <li key={`${item.source}-${item.locator}-${index}`}>
            <span className="font-medium">{item.source}</span> ({item.locator}) · {item.excerpt}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssistantCrudDeleteCard({
  preview,
  result,
  busy,
  onConfirm,
  onRestore,
}: {
  readonly preview: AssistantCrudDeletePreviewResponse["preview"] | null;
  readonly result: AssistantCrudDeleteExecuteResponse | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onRestore: (restoreId: string) => void;
}) {
  if (!preview && !result) {
    return null;
  }
  return (
    <section className="mt-3 rounded-md border border-border/70 bg-card/40 p-3" data-testid="assistant-crud-delete-card">
      {preview && (
        <>
          <div className="text-xs text-muted-foreground">Delete Preview · {preview.target}</div>
          <div className="text-sm mt-1">{preview.impactSummary}</div>
          <ul className="mt-2 space-y-1 text-xs">
            {preview.evidence.map((item, index) => (
              <li key={`${item.source}-${item.locator}-${index}`}>
                <span className="font-medium">{item.source}</span> ({item.locator}) · {item.excerpt}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            onClick={onConfirm}
            disabled={busy}
            data-testid="assistant-crud-delete-confirm"
          >
            确认删除（软删除）
          </button>
        </>
      )}
      {result && (
        <>
          <div className="text-xs text-muted-foreground mt-2">Delete Executed · {result.target}</div>
          <div className="text-sm mt-1">恢复编号：{result.restoreId}</div>
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            onClick={() => onRestore(result.restoreId)}
            disabled={busy}
            data-testid="assistant-crud-delete-restore"
          >
            恢复
          </button>
        </>
      )}
    </section>
  );
}

export function AssistantTemplateSuggestionCard({
  t,
  taskId,
  suggestedNextActions,
  onRunNextAction,
}: {
  readonly t: TFunction;
  readonly taskId: string;
  readonly suggestedNextActions: ReadonlyArray<string>;
  readonly onRunNextAction: (action: string) => void;
}) {
  if (suggestedNextActions.length === 0) {
    return null;
  }
  return (
    <section
      className="mt-3 rounded-xl border border-border/70 bg-card/40 p-3 space-y-2"
      data-testid="assistant-template-suggestion-card"
      aria-label={t("assistant.flywheelLabel")}
    >
      <div className="text-xs text-muted-foreground">{t("assistant.flywheelLabel")} · taskId={taskId}</div>
      <div className="flex flex-wrap items-center gap-2">
        {suggestedNextActions.map((action) => (
          <button
            key={`template-next-${action}`}
            type="button"
            onClick={() => onRunNextAction(action)}
            className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:text-primary"
            data-testid="assistant-template-next-action"
          >
            {t("assistant.templateContinuePrefix")}{action}
          </button>
        ))}
      </div>
    </section>
  );
}

export function AssistantView({
  nav,
  theme: _theme,
  t,
  initialPrompt,
  initialPromptKey,
}: {
  nav: Nav;
  theme: Theme;
  t: TFunction;
  initialPrompt?: string;
  initialPromptKey?: string;
}) {
  const [state, setState] = useState<AssistantComposerState>(() => createAssistantInitialState());
  const { data: booksData } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { messages: sseMessages } = useSSE();
  const sseCursorRef = useRef(0);
  const evaluatedTaskIdRef = useRef<string | null>(null);
  const activeBooks = useMemo(
    () => (booksData?.books ?? []).filter((book) => book.status === BOOK_STATUS_ACTIVE),
    [booksData?.books],
  );
  const [scopeMode, setScopeMode] = useState<AssistantBookScopeMode>("all-active");
  const [selectedBookIds, setSelectedBookIds] = useState<ReadonlyArray<string>>([]);
  const [scopeBlockHint, setScopeBlockHint] = useState("");
  const [crudReadResult, setCrudReadResult] = useState<AssistantCrudReadResponse | null>(null);
  const [crudDeletePreview, setCrudDeletePreview] = useState<AssistantCrudDeletePreviewResponse["preview"] | null>(null);
  const [crudDeleteResult, setCrudDeleteResult] = useState<AssistantCrudDeleteExecuteResponse | null>(null);
  const [crudBusy, setCrudBusy] = useState(false);
  const consumedPromptKeyRef = useRef<string | null>(null);
  const taskRecoveryAppliedRef = useRef<string | null>(null);

  const quickActions = useMemo(() => ASSISTANT_QUICK_ACTIONS, []);
  const promptTemplates = useMemo(() => ASSISTANT_PROMPT_TEMPLATES, []);
  const activeBookIds = useMemo(() => activeBooks.map((book) => book.id), [activeBooks]);
  const selectedScopeBookIds = useMemo(
    () => resolveAssistantScopeBookIds(scopeMode, selectedBookIds, activeBookIds),
    [scopeMode, selectedBookIds, activeBookIds],
  );
  const activeBookTitleById = useMemo(
    () => new Map(activeBooks.map((book) => [book.id, book.title] as const)),
    [activeBooks],
  );
  const selectedBookTitles = useMemo(
    () => resolveAssistantBookTitlesByIds(selectedScopeBookIds, activeBookTitleById, t),
    [selectedScopeBookIds, activeBookTitleById, t],
  );
  const taskPlanTargetBookTitles = useMemo(
    () => (state.taskPlan ? resolveAssistantBookTitlesByIds(state.taskPlan.targetBookIds, activeBookTitleById, t) : []),
    [state.taskPlan, activeBookTitleById, t],
  );
  const taskPlanActionLabel = useMemo(() => {
    if (!state.taskPlan) {
      return "";
    }
    const baseLabel = t(ACTION_LABEL_KEY_BY_TYPE[state.taskPlan.action] ?? "assistant.actionTemplate");
    if (state.taskPlan.action !== "template") {
      return baseLabel;
    }
    const template = state.taskPlan.templateId ? resolveAssistantPromptTemplate(state.taskPlan.templateId) : null;
    const templateLabel = template ? t(template.labelKey) : baseLabel;
    const riskLabel = state.taskPlan.templateRiskLevel ? ` · ${t("assistant.templateRiskPrefix")}${state.taskPlan.templateRiskLevel}` : "";
    return `${templateLabel}${riskLabel}`;
  }, [state.taskPlan, t]);

  useEffect(() => {
    const key = initialPromptKey ?? initialPrompt ?? "";
    if (!key || consumedPromptKeyRef.current === key) {
      return;
    }
    consumedPromptKeyRef.current = key;
    if (!initialPrompt) {
      return;
    }
    setScopeBlockHint("");
    setState((prev) => applyAssistantIncomingPrompt(prev, initialPrompt));
  }, [initialPrompt, initialPromptKey]);

  useEffect(() => {
    if (sseCursorRef.current >= sseMessages.length) {
      return;
    }
    const pending = sseMessages.slice(sseCursorRef.current);
    sseCursorRef.current = sseMessages.length;
    setState((prev) => pending.reduce((next, message) => applyAssistantTaskEventFromSSE(next, message), prev));
  }, [sseMessages]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let payload: AssistantTaskRecoveryPayload | null = null;
    try {
      payload = parseAssistantTaskRecoveryPayload(window.localStorage.getItem(ASSISTANT_TASK_RECOVERY_STORAGE_KEY));
    } catch {
      payload = null;
    }
    if (!payload || payload.status !== "running" || taskRecoveryAppliedRef.current === payload.taskId) {
      return;
    }
    taskRecoveryAppliedRef.current = payload.taskId;
    void (async () => {
      try {
        const snapshot = await fetchJson<AssistantTaskSnapshot>(`/assistant/tasks/${payload.taskId}`);
        setState((prev) => recoverAssistantStateFromSnapshot(prev, snapshot, payload));
      } catch {
        // ignore persisted task recovery errors
      }
    })();
  }, []);

  useEffect(() => {
    if (!state.taskExecution || state.taskExecution.status !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const snapshot = await fetchJson<AssistantTaskSnapshot>(`/assistant/tasks/${state.taskExecution?.taskId}`);
          setState((prev) => reconcileAssistantTaskFromSnapshot(prev, snapshot));
        } catch {
          // ignore polling errors and continue relying on SSE
        }
      })();
    }, ASSISTANT_TASK_SNAPSHOT_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [state.taskExecution?.taskId, state.taskExecution?.status]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const payload = buildAssistantTaskRecoveryPayload(state);
      if (!payload) {
        window.localStorage.removeItem(ASSISTANT_TASK_RECOVERY_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(ASSISTANT_TASK_RECOVERY_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage write failures
    }
  }, [state.taskExecution, state.taskPlan]);

  useEffect(() => {
    if (!state.taskExecution || state.taskExecution.status === "running" || !state.taskPlan) {
      return;
    }
    if (evaluatedTaskIdRef.current === state.taskExecution.taskId) {
      return;
    }
    evaluatedTaskIdRef.current = state.taskExecution.taskId;

    const scope = state.taskPlan.chapterNumber !== undefined
      ? {
          type: "chapter" as const,
          bookId: state.taskPlan.targetBookIds[0] ?? "",
          chapter: state.taskPlan.chapterNumber,
        }
      : {
          type: "book" as const,
          bookId: state.taskPlan.targetBookIds[0] ?? "",
        };
    if (!scope.bookId) {
      return;
    }
    const runIds = collectAssistantStepRunIds(state.taskExecution.stepRunIds);
    const taskId = state.taskExecution.taskId;
    const applySuggestedNextActions = (
      prev: AssistantComposerState,
      suggestedNextActions: ReadonlyArray<string>,
    ): AssistantComposerState => ({
      ...prev,
      suggestedNextActions: resolveAssistantTemplateSuggestedActions(prev.taskPlan, suggestedNextActions),
    });
    void (async () => {
      try {
        const result = await postApi<AssistantEvaluateResponse>("/assistant/evaluate", {
          taskId,
          scope,
          ...(runIds.length > 0 ? { runIds } : {}),
        });
        setState((prev) => ({
          ...applySuggestedNextActions(prev, result.suggestedNextActions),
          qualityReport: result.report,
        }));
      } catch {
        setState((prev) => {
          const suggestedNextActions = resolveAssistantTemplateSuggestedActions(prev.taskPlan, prev.suggestedNextActions);
          if (
            suggestedNextActions.length === prev.suggestedNextActions.length
            && suggestedNextActions.every((item, index) => item === prev.suggestedNextActions[index])
          ) {
            return prev;
          }
          return {
            ...prev,
            suggestedNextActions,
          };
        });
      }
    })();
  }, [state.taskExecution, state.taskPlan]);

  const handleRunTemplate = (template: AssistantPromptTemplate) => {
    if (state.loading || state.taskPlan?.status === "awaiting-confirm" || state.taskPlan?.status === "running") {
      return;
    }
    const draft = buildAssistantTemplateConfirmationDraft(template, scopeMode, selectedBookIds, activeBookIds);
    if (!draft) {
      setScopeBlockHint(t("assistant.scopeBlocked"));
      return;
    }
    setScopeBlockHint((prev) => {
      if (template.riskLevel === "L1") {
        return t("assistant.templateRiskGateHint");
      }
      const riskHint = t("assistant.templateRiskGateHint");
      return prev === riskHint ? "" : prev;
    });
    setState((prev) => requestAssistantConfirmation(prev, draft));
  };

  const sendPrompt = (rawPrompt: string) => {
    const normalizedPrompt = rawPrompt.trim();
    if (!normalizedPrompt) {
      return;
    }

    const commandState = applyAssistantOperatorCommand(state, normalizedPrompt);
    if (commandState) {
      setScopeBlockHint("");
      setState(commandState);
      return;
    }
    if (state.loading || state.taskPlan?.status === "awaiting-confirm" || state.taskPlan?.status === "running") {
      return;
    }

    const readRequest = parseAssistantCrudReadRequest(normalizedPrompt);
    if (readRequest) {
      const targetBookId = selectedScopeBookIds[0] ?? activeBookIds[0];
      if (!targetBookId) {
        setScopeBlockHint(t("assistant.scopeBlocked"));
        return;
      }
      setScopeBlockHint("");
      setCrudBusy(true);
      setState((prev) => submitAssistantInput(prev, normalizedPrompt));
      void (async () => {
        try {
          const response = await postApi<AssistantCrudReadResponse>("/assistant/read", {
            ...readRequest,
            bookId: targetBookId,
          });
          setCrudReadResult(response);
          setCrudDeletePreview(null);
          setCrudDeleteResult(null);
          setState((prev) => completeAssistantResponse(prev, `已返回 ${response.dimension} 查询结果。`));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setScopeBlockHint(`查询失败：${message}`);
          setState((prev) => completeAssistantResponse(prev, "查询失败，请重试。"));
        } finally {
          setCrudBusy(false);
        }
      })();
      return;
    }

    const restoreIdFromPrompt = parseAssistantCrudRestoreId(normalizedPrompt);
    if (restoreIdFromPrompt) {
      setCrudBusy(true);
      setState((prev) => submitAssistantInput(prev, normalizedPrompt));
      void (async () => {
        try {
          await postApi<{ ok: boolean; restoreId: string }>("/assistant/delete/restore", { restoreId: restoreIdFromPrompt });
          setCrudDeletePreview(null);
          setCrudDeleteResult((prev) => (prev && prev.restoreId === restoreIdFromPrompt ? null : prev));
          setState((prev) => completeAssistantResponse(prev, `恢复成功：${restoreIdFromPrompt}`));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setScopeBlockHint(`恢复失败：${message}`);
          setState((prev) => completeAssistantResponse(prev, "恢复失败，请检查恢复编号。"));
        } finally {
          setCrudBusy(false);
        }
      })();
      return;
    }

    const deleteRequest = parseAssistantCrudDeleteRequest(normalizedPrompt);
    if (deleteRequest) {
      const targetBookId = selectedScopeBookIds[0] ?? activeBookIds[0];
      if (!targetBookId) {
        setScopeBlockHint(t("assistant.scopeBlocked"));
        return;
      }
      setScopeBlockHint("");
      setCrudBusy(true);
      setState((prev) => submitAssistantInput(prev, normalizedPrompt));
      void (async () => {
        try {
          const preview = await postApi<AssistantCrudDeletePreviewResponse>("/assistant/delete/preview", {
            ...deleteRequest,
            bookId: targetBookId,
          });
          setCrudDeletePreview(preview.preview);
          setCrudDeleteResult(null);
          setCrudReadResult(null);
          setState((prev) => completeAssistantResponse(prev, "已生成删除影响预览，请确认后执行。"));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setScopeBlockHint(`删除预览失败：${message}`);
          setState((prev) => completeAssistantResponse(prev, "删除预览失败，请重试。"));
        } finally {
          setCrudBusy(false);
        }
      })();
      return;
    }

    if (WORLD_REPORT_ACTION_PATTERN.test(normalizedPrompt)) {
      const targetBookId = selectedScopeBookIds[0] ?? activeBookIds[0];
      if (!targetBookId) {
        setScopeBlockHint(t("assistant.scopeBlocked"));
        return;
      }
      setScopeBlockHint("");
      setCrudBusy(true);
      setState((prev) => submitAssistantInput(prev, normalizedPrompt));
      void (async () => {
        try {
          const response = await postApi<AssistantWorldReportResponse>("/assistant/world/report", {
            bookId: targetBookId,
          });
          setState((prev) => ({
            ...completeAssistantResponse(prev, "已生成全书一致性报告与市场策略建议。"),
            worldConsistencyReport: response.report,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setScopeBlockHint(`报告生成失败：${message}`);
          setState((prev) => completeAssistantResponse(prev, "一致性报告生成失败，请重试。"));
        } finally {
          setCrudBusy(false);
        }
      })();
      return;
    }

    const draft = buildAssistantConfirmationDraft(normalizedPrompt, scopeMode, selectedBookIds, activeBookIds);
    if (detectAssistantBookAction(normalizedPrompt)) {
      if (!draft) {
        setScopeBlockHint(t("assistant.scopeBlocked"));
        return;
      }
      setScopeBlockHint("");
      setState((prev) => requestAssistantConfirmation(prev, draft));
      return;
    }

    setScopeBlockHint("");
    setState((prev) => submitAssistantInput(prev, normalizedPrompt));

    setTimeout(() => {
      setState((prev) => completeAssistantResponse(prev, normalizedPrompt));
    }, MOCK_ASSISTANT_RESPONSE_DELAY_MS);
  };

  const handleConfirmAction = async () => {
    if (!state.taskPlan || state.taskPlan.status !== "awaiting-confirm") {
      return;
    }
    setState((prev) => confirmAssistantPendingAction(prev));
    try {
      const sessionId = `asst_s_${Date.now().toString(36)}`;
      const scope = state.taskPlan.targetBookIds.length === activeBookIds.length
        ? { type: "all-active" as const }
        : { type: "book-list" as const, bookIds: [...state.taskPlan.targetBookIds] };
      const planned = await postApi<{
        readonly taskId: string;
        readonly plan: ReadonlyArray<Record<string, unknown>>;
      }>("/assistant/plan", {
        sessionId,
        input: state.taskPlan.prompt,
        scope,
      });
      const executeResult = await postApi<{
        readonly stepRunIds?: Record<string, string>;
      }>("/assistant/execute", {
        taskId: planned.taskId,
        sessionId,
        approved: true,
        plan: planned.plan,
      });
      setState((prev) => ({
        ...prev,
        taskExecution: {
          taskId: planned.taskId,
          sessionId,
          status: "running",
          stepRunIds: executeResult.stepRunIds,
          timeline: prev.taskExecution?.taskId === planned.taskId ? prev.taskExecution.timeline : [],
          lastSyncedAt: Date.now(),
          nextSequence: prev.taskExecution?.taskId === planned.taskId ? prev.taskExecution.nextSequence : 0,
        },
        qualityReport: null,
        worldConsistencyReport: null,
        suggestedNextActions: [],
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScopeBlockHint(`任务执行失败：${message}`);
      setState((prev) => completeAssistantTaskPlanExecution(prev, "failed"));
    }
  };

  const handleRunNextAction = (action: string) => {
    sendPrompt(buildAssistantNextActionPrompt(action, state.taskPlan));
  };

  const handleRunWorldRepairTask = (stepId: string) => {
    sendPrompt(buildAssistantWorldRepairPrompt(state.worldConsistencyReport, stepId));
  };

  const handleConfirmDelete = async () => {
    if (!crudDeletePreview) return;
    setCrudBusy(true);
    try {
      const result = await postApi<AssistantCrudDeleteExecuteResponse>("/assistant/delete/execute", {
        previewId: crudDeletePreview.previewId,
        confirmed: true,
      });
      setCrudDeleteResult(result);
      setCrudDeletePreview(null);
      setState((prev) => completeAssistantResponse(prev, `删除已执行，可在窗口期内恢复：${result.restoreId}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScopeBlockHint(`删除执行失败：${message}`);
    } finally {
      setCrudBusy(false);
    }
  };

  const handleRestoreDelete = async (restoreId: string) => {
    setCrudBusy(true);
    try {
      await postApi("/assistant/delete/restore", { restoreId });
      setCrudDeleteResult(null);
      setState((prev) => completeAssistantResponse(prev, `已恢复：${restoreId}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScopeBlockHint(`恢复失败：${message}`);
    } finally {
      setCrudBusy(false);
    }
  };

  const showLoading = state.loading && state.messages.length === 0;

  return (
    <div className="h-full min-h-[640px] flex flex-col gap-4">
      <section className="shrink-0 rounded-xl border border-border/70 bg-card/50 px-4 py-3" data-testid="assistant-context-bar">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <Sparkles size={16} className="text-primary" />
            <span className="font-medium">{t("assistant.title")}</span>
            <span className="text-muted-foreground">· {t("assistant.workspace")}</span>
          </div>
          <button onClick={nav.toDashboard} className="text-xs text-muted-foreground hover:text-primary transition-colors">
            {t("assistant.backHome")}
          </button>
        </div>
        <div className="mt-3 space-y-2" data-testid="assistant-scope-selector">
          <div className="text-xs text-muted-foreground">{t("assistant.scopeLabel")}</div>
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                checked={scopeMode === "single"}
                onChange={() => {
                  setScopeMode("single");
                  setState((prev) => cancelAssistantPendingAction(prev));
                  setSelectedBookIds((prev) => {
                    const selected = prev.find((id) => activeBookIds.includes(id));
                    return selected ? [selected] : [];
                  });
                }}
              />
              <span>{t("assistant.scopeSingle")}</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                checked={scopeMode === "multi"}
                onChange={() => {
                  setScopeMode("multi");
                  setState((prev) => cancelAssistantPendingAction(prev));
                }}
              />
              <span>{t("assistant.scopeMulti")}</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                checked={scopeMode === "all-active"}
                onChange={() => {
                  setScopeMode("all-active");
                  setState((prev) => cancelAssistantPendingAction(prev));
                }}
              />
              <span>{t("assistant.scopeAllActive")}</span>
            </label>
          </div>
          {scopeMode === "single" && (
            <select
              value={selectedBookIds[0] ?? ""}
              onChange={(event) => setSelectedBookIds(event.target.value ? [event.target.value] : [])}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="">{t("assistant.scopeSelectBook")}</option>
              {activeBooks.map((book) => (
                <option key={book.id} value={book.id}>{book.title}</option>
              ))}
            </select>
          )}
          {scopeMode === "multi" && (
            <div className="grid gap-1 sm:grid-cols-2">
              {activeBooks.length === 0 ? (
                <span className="text-xs text-muted-foreground">{t("assistant.scopeNoBooks")}</span>
              ) : activeBooks.map((book) => {
                const checked = selectedBookIds.includes(book.id);
                return (
                  <label key={book.id} className="inline-flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setSelectedBookIds((prev) => [...new Set([...prev, book.id])]);
                        } else {
                          setSelectedBookIds((prev) => prev.filter((id) => id !== book.id));
                        }
                      }}
                    />
                    <span className="truncate">{book.title}</span>
                  </label>
                );
              })}
            </div>
          )}
          <div className="text-xs text-muted-foreground" data-testid="assistant-scope-summary">
            {selectedBookTitles.length > 0 ? selectedBookTitles.join("、") : t("assistant.scopeNoneSelected")}
          </div>
          {scopeBlockHint && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-testid="assistant-scope-blocked">
              {scopeBlockHint}
            </div>
          )}
        </div>
      </section>

        <section className="flex-1 min-h-[360px] overflow-y-auto rounded-xl border border-border/70 bg-background/70 p-4" data-testid="assistant-message-list">
          {showLoading ? <LoadingConversation /> : state.messages.length === 0 ? <EmptyConversation /> : <MessageList messages={state.messages} />}
          {state.taskPlan && (
            <TaskPlanCard
              t={t}
              taskPlan={state.taskPlan}
              actionLabel={taskPlanActionLabel}
              chapterLabel={state.taskPlan.chapterNumber ? `${t("assistant.confirmChapterPrefix")}${state.taskPlan.chapterNumber}` : undefined}
              targetBookTitles={taskPlanTargetBookTitles}
              onConfirm={handleConfirmAction}
              onCancel={() => setState((prev) => cancelAssistantPendingAction(prev))}
            />
          )}
          {state.qualityReport && (
            <QualityReportCard
              report={state.qualityReport}
              suggestedNextActions={state.suggestedNextActions}
              onRunNextAction={handleRunNextAction}
            />
          )}
          {state.worldConsistencyReport && (
            <WorldConsistencyMarketCard
              report={state.worldConsistencyReport}
              onRunRepairTask={handleRunWorldRepairTask}
            />
          )}
          {crudReadResult && <AssistantCrudReadCard result={crudReadResult} />}
          <AssistantCrudDeleteCard
            preview={crudDeletePreview}
            result={crudDeleteResult}
            busy={crudBusy}
            onConfirm={handleConfirmDelete}
            onRestore={handleRestoreDelete}
          />
          <AssistantTimeline entries={state.taskExecution?.timeline ?? []} />
          {state.taskExecution && state.taskExecution.status !== "running" && (
            <AssistantTemplateSuggestionCard
              t={t}
              taskId={state.taskExecution.taskId}
              suggestedNextActions={resolveAssistantTemplateSuggestedActions(state.taskPlan, state.suggestedNextActions)}
              onRunNextAction={handleRunNextAction}
            />
          )}
      </section>

      <section className="shrink-0 rounded-xl border border-border/70 bg-card/40 p-4 space-y-3" data-testid="assistant-input-panel">
        <div className="space-y-2" data-testid="assistant-template-panel">
          <div className="text-xs text-muted-foreground">{t("assistant.templateTitle")}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {promptTemplates.map((template) => (
              <button
                key={template.id}
                onClick={() => handleRunTemplate(template)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-left text-xs hover:border-primary/40 hover:bg-primary/5"
                data-testid={`assistant-template-${template.id}`}
                aria-label={`${t(template.labelKey)} ${t("assistant.templateRiskPrefix")}${template.riskLevel}`}
              >
                <span className="block text-foreground">{t(template.labelKey)}</span>
                <span className="mt-1 block text-muted-foreground">{t("assistant.templateRiskPrefix")}{template.riskLevel}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {quickActions.map((action) => (
            <button
              key={action.id}
              onClick={() => sendPrompt(action.prompt)}
              className="px-3 py-1.5 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
            >
              {action.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            value={state.input}
            onChange={(event) => setState((prev) => applyAssistantInput(prev, event.target.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                sendPrompt(state.input);
              }
            }}
            placeholder={t("assistant.inputPlaceholder")}
            className="flex-1 h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            data-testid="assistant-input"
          />
          <button
            onClick={() => sendPrompt(state.input)}
            disabled={crudBusy || state.loading || state.taskPlan?.status === "awaiting-confirm" || state.taskPlan?.status === "running"}
            className="h-10 w-10 rounded-lg bg-primary text-primary-foreground disabled:opacity-50 flex items-center justify-center"
            data-testid="assistant-send"
          >
            {state.loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </section>
    </div>
  );
}
