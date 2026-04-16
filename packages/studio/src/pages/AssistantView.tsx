import { useEffect, useMemo, useRef, useState } from "react";
import { BotMessageSquare, Loader2, Send, Sparkles } from "lucide-react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { fetchJson, postApi, useApi } from "../hooks/use-api";
import {
  parseAssistantOperatorCommand,
  type AssistantOperatorParseResult,
} from "../api/services/assistant-command-parser";
import { TaskPlanCard } from "../components/assistant/TaskPlanCard";
import { QualityReportCard, type QualityReportPayload } from "../components/assistant/QualityReportCard";
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

export type AssistantBookActionType = "write-next" | "audit";

export interface AssistantConfirmationDraft {
  readonly action: AssistantBookActionType;
  readonly prompt: string;
  readonly targetBookIds: ReadonlyArray<string>;
  readonly chapterNumber?: number;
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
const BOOK_STATUS_ACTIVE = "active";
const WRITE_NEXT_ACTION_PATTERN = /写下一章|write[-\s]?next/u;
const AUDIT_ACTION_PATTERN = /审计|audit/iu;
const AUDIT_CHAPTER_ZH_PATTERN = /第\s*(\d+)\s*章/u;
const AUDIT_CHAPTER_EN_PATTERN = /chapter\s*(\d+)/iu;
const ACTION_LABEL_KEY_BY_TYPE: Record<AssistantBookActionType, "assistant.actionWriteNext" | "assistant.actionAudit"> = {
  "write-next": "assistant.actionWriteNext",
  audit: "assistant.actionAudit",
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

export function createAssistantInitialState(): AssistantComposerState {
  return {
    input: "",
    messages: [],
    loading: false,
    nextMessageId: 1,
    taskPlan: null,
    taskExecution: null,
    qualityReport: null,
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

export function detectAssistantBookAction(prompt: string): AssistantBookActionType | null {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return null;
  if (WRITE_NEXT_ACTION_PATTERN.test(normalized)) return "write-next";
  if (AUDIT_ACTION_PATTERN.test(normalized)) return "audit";
  return null;
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

export function AssistantView({ nav, theme: _theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
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

  const quickActions = useMemo(() => ASSISTANT_QUICK_ACTIONS, []);
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

  useEffect(() => {
    if (sseCursorRef.current >= sseMessages.length) {
      return;
    }
    const pending = sseMessages.slice(sseCursorRef.current);
    sseCursorRef.current = sseMessages.length;
    setState((prev) => pending.reduce((next, message) => applyAssistantTaskEventFromSSE(next, message), prev));
  }, [sseMessages]);

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
    void (async () => {
      try {
        const result = await postApi<AssistantEvaluateResponse>("/assistant/evaluate", {
          taskId,
          scope,
          ...(runIds.length > 0 ? { runIds } : {}),
        });
        setState((prev) => ({
          ...prev,
          qualityReport: result.report,
          suggestedNextActions: result.suggestedNextActions,
        }));
      } catch {
        // ignore evaluate errors, task timeline remains available
      }
    })();
  }, [state.taskExecution, state.taskPlan]);

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
              actionLabel={t(ACTION_LABEL_KEY_BY_TYPE[state.taskPlan.action])}
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
          <AssistantTimeline entries={state.taskExecution?.timeline ?? []} />
      </section>

      <section className="shrink-0 rounded-xl border border-border/70 bg-card/40 p-4 space-y-3" data-testid="assistant-input-panel">
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
            disabled={state.loading || state.taskPlan?.status === "awaiting-confirm" || state.taskPlan?.status === "running"}
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
