import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotMessageSquare, Loader2, Send, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Theme } from "../hooks/use-theme";
import type { StringKey, TFunction } from "../hooks/use-i18n";
import { fetchJson, postApi, useApi, buildApiUrl, invalidateApiPaths } from "../hooks/use-api";
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
  readonly streamingStatus: string;
  readonly streamingProgress: ReadonlyArray<string>;
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
  readonly status: "running" | "waiting_approval" | "succeeded" | "failed";
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

interface AssistantChatResponse {
  readonly ok: boolean;
  readonly response: string;
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
  readonly nodes?: Record<string, {
    readonly nodeId: string;
    readonly type: "task" | "checkpoint";
    readonly action?: string;
    readonly status: "pending" | "running" | "waiting_approval" | "succeeded" | "failed";
    readonly attempts: number;
    readonly maxRetries: number;
    readonly startedAt?: string;
    readonly finishedAt?: string;
    readonly error?: string;
    readonly checkpoint?: {
      readonly nodeId: string;
      readonly requiredApproval: boolean;
      readonly approvedAt?: string;
      readonly approvedBy?: string;
    };
  }>;
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

const ASSISTANT_TIMELINE_MAX_ENTRIES = 50;
const ASSISTANT_TASK_SNAPSHOT_POLL_INTERVAL_MS = 2000;
const ASSISTANT_TASK_RECOVERY_STORAGE_KEY = "inkos.assistant.task-recovery";
const ASSISTANT_CHAT_HISTORY_STORAGE_KEY = "inkos.assistant.chat-history";
const ASSISTANT_CHAT_HISTORY_MAX_MESSAGES = 200;
const ASSISTANT_CHAT_PENDING_KEY = "inkos.assistant.chat-pending";
const ASSISTANT_CHAT_PENDING_TTL_MS = 300_000;
const ASSISTANT_CHAT_PENDING_POLL_MS = 500;
const GENERATION_INTENT_PATTERN = /生成|创建|创作|大纲|计划|规划|建议|优化|改进|总结|分析|generate|create|plan|outline|suggest|summarize|analyze/iu;

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  list_books: "查询书籍列表",
  get_book_status: "获取书籍状态",
  read_truth_files: "读取书籍数据",
  create_book: "创建新书",
  plan_chapter: "规划章节",
  compose_chapter: "生成章节上下文",
  write_draft: "写草稿",
  audit_chapter: "审计章节",
  revise_chapter: "修订章节",
  scan_market: "扫描市场趋势",
  update_author_intent: "更新作者意图",
  update_current_focus: "更新关注点",
  write_full_pipeline: "完整写作管线",
  web_fetch: "抓取网页",
  import_style: "导入文风",
  import_canon: "导入正典",
  import_chapters: "导入章节",
  write_truth_file: "写入真相文件",
};

interface AssistantStreamCallbacks {
  readonly onProgress: (status: string) => void;
  readonly onMessage: (content: string) => void;
  readonly onDone: (result: { ok: boolean; response?: string; error?: string }) => void;
  readonly abortSignal?: AbortSignal;
}

function normalizeAssistantStreamError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "请求已取消";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|network request failed/i.test(message)) {
    return "连接中断（可能是请求耗时过长或代理超时），请重试";
  }
  return message;
}

async function streamAssistantChat(
  prompt: string,
  scopeBookTitles: ReadonlyArray<string>,
  callbacks: AssistantStreamCallbacks,
): Promise<void> {
  const url = buildApiUrl("/assistant/chat");
  if (!url) {
    callbacks.onDone({ ok: false, error: "Invalid API path" });
    return;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, scopeBookTitles }),
      signal: callbacks.abortSignal,
    });
  } catch (e) {
    callbacks.onDone({ ok: false, error: normalizeAssistantStreamError(e) });
    return;
  }

  if (!response.ok || !response.body) {
    callbacks.onDone({ ok: false, error: `HTTP ${response.status}` });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastResponse = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventName = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:") && eventName) {
          const rawData = line.slice(5).trim();
          try {
            const data = JSON.parse(rawData) as Record<string, unknown>;
            if (eventName === "assistant:progress") {
              const toolName = typeof data.tool === "string" ? data.tool : "";
              const displayName = TOOL_DISPLAY_NAMES[toolName] ?? toolName;
              if (data.type === "tool_call") {
                callbacks.onProgress(`正在调用 ${displayName}…`);
              } else if (data.type === "tool_result") {
                callbacks.onProgress(`${displayName} 完成`);
              }
            } else if (eventName === "assistant:message") {
              if (typeof data.content === "string") {
                lastResponse = data.content;
                callbacks.onMessage(data.content);
              }
            } else if (eventName === "assistant:done") {
              const finalResponse = typeof data.response === "string" ? data.response : lastResponse;
              callbacks.onDone({ ok: data.ok !== false, response: finalResponse, error: typeof data.error === "string" ? data.error : undefined });
              return;
            }
          } catch { /* skip unparseable SSE data */ }
          eventName = "";
        } else if (line === "") {
          eventName = "";
        }
      }
    }
    // Stream ended without explicit done event
    if (lastResponse) {
      callbacks.onDone({ ok: true, response: lastResponse });
    } else {
      callbacks.onDone({ ok: false, error: "Stream ended without response" });
    }
  } catch (e) {
    if (callbacks.abortSignal?.aborted) return;
    callbacks.onDone({ ok: false, error: normalizeAssistantStreamError(e) });
  }
}
const BOOK_STATUS_ACTIVE = "active";
const WRITE_NEXT_ACTION_PATTERN = /写下一章|下一章节?写|下一章写|创作下一章|写第\s*\d+\s*章|继续写|续写|write[-\s]?next|next\s*chapter|continue\s*writing/iu;
const AUDIT_ACTION_PATTERN = /审计|审核|审一下|审下|审一审|检查|audit|review/iu;
const CRUD_READ_ACTION_PATTERN = /查询|查看|检索|read|search/iu;
const CRUD_DELETE_ACTION_PATTERN = /删除|delete/iu;
const CRUD_RESTORE_ACTION_PATTERN = /恢复|restore/iu;
const WORLD_REPORT_ACTION_PATTERN = /(一致性报告|world\s*consistency|市场策略|market\s*(strategy|memory)|题材趋势)/iu;
const CRUD_DIMENSION_VOLUME_PATTERN = /卷|volume/iu;
const CRUD_DIMENSION_CHAPTER_PATTERN = /章|chapter/iu;
const CRUD_DIMENSION_CHARACTER_PATTERN = /角色|character/iu;
const CRUD_DIMENSION_HOOK_PATTERN = /伏笔|hook/iu;
const NOVEL_QA_HINT_PATTERN = /主角|角色|人物|设定|世界观|伏笔|章节|剧情|冲突|书里|book|chapter|character|hook|volume/iu;
const CRUD_RUN_ID_PATTERN = /(run[_-][a-z0-9-]+)/iu;
const AUDIT_CHAPTER_ZH_PATTERN = /第\s*(\d+)\s*章/u;
const AUDIT_CHAPTER_EN_PATTERN = /chapter\s*(\d+)/iu;

// --- Smart book context resolution ---
const BOOK_TITLE_BRACKET_PATTERN = /[《「]([^》」]+)[》」]/gu;

function normalizeBookLookupText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[《》「」"'\s]/gu, "")
    .replace(/[：:·\-—_|]/gu, "");
}

export interface ChatBookContext {
  readonly id: string;
  readonly title: string;
}

/**
 * Resolve which book the user is referring to from the prompt text.
 * Returns:
 * - `{ match: book }` if exactly one book matches
 * - `{ candidates: books }` if multiple books match (disambiguation needed)
 * - `null` if no book reference detected in the prompt
 */
export function resolveBookFromPrompt(
  prompt: string,
  activeBooks: ReadonlyArray<{ readonly id: string; readonly title: string }>,
): { match: { id: string; title: string } } | { candidates: ReadonlyArray<{ id: string; title: string }> } | null {
  if (activeBooks.length === 0) return null;
  const normalizedPromptCompact = normalizeBookLookupText(prompt);

  // 1. Try explicit bracket references: 《书名》or「書名」
  const bracketMatches = [...prompt.matchAll(BOOK_TITLE_BRACKET_PATTERN)].map((m) => m[1].trim());
  if (bracketMatches.length > 0) {
    for (const ref of bracketMatches) {
      const exact = activeBooks.find((b) => normalizeBookLookupText(b.title) === normalizeBookLookupText(ref));
      if (exact) return { match: { id: exact.id, title: exact.title } };
      // Partial match: book title contains the reference or reference contains part of the title
      const normalizedRef = normalizeBookLookupText(ref);
      const partials = activeBooks.filter((b) =>
        normalizeBookLookupText(b.title).includes(normalizedRef)
        || normalizedRef.includes(normalizeBookLookupText(b.title)),
      );
      if (partials.length === 1) return { match: { id: partials[0].id, title: partials[0].title } };
      if (partials.length > 1) return { candidates: partials.map((b) => ({ id: b.id, title: b.title })) };
    }
  }

  // 2. Try fuzzy matching: check if prompt contains a significant portion of any book title
  const normalized = prompt.toLowerCase();
  const scored: Array<{ book: { id: string; title: string }; score: number }> = [];
  for (const book of activeBooks) {
    const titleLower = book.title.toLowerCase();
    const compactTitle = normalizeBookLookupText(book.title);
    // Extract meaningful segments from book title (split by common separators)
    const segments = titleLower.split(/[:：\s·\-—_|]/u).filter((s) => s.length >= 2);
    let maxScore = 0;
    // Check full title
    if (normalized.includes(titleLower) || normalizedPromptCompact.includes(compactTitle)) {
      maxScore = titleLower.length;
    } else {
      // Check individual segments
      for (const seg of segments) {
        const compactSeg = normalizeBookLookupText(seg);
        if ((normalized.includes(seg) || normalizedPromptCompact.includes(compactSeg)) && seg.length > maxScore) {
          maxScore = seg.length;
        }
      }
      // Check if prompt contains a prefix of the title (at least 3 chars for CJK, 4 for latin)
      if (maxScore === 0) {
        const minLen = /[\u4e00-\u9fff]/u.test(titleLower) ? 3 : 4;
        for (let len = titleLower.length; len >= minLen; len--) {
          const prefix = titleLower.slice(0, len);
          if (normalized.includes(prefix)) {
            maxScore = prefix.length;
            break;
          }
        }
      }
    }
    if (maxScore >= 2) {
      scored.push({ book: { id: book.id, title: book.title }, score: maxScore });
    }
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  // If top match is significantly better, use it
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return { match: scored[0].book };
  }
  // Multiple equal-scored matches → disambiguation
  const topScore = scored[0].score;
  const topCandidates = scored.filter((s) => s.score === topScore).map((s) => s.book);
  return topCandidates.length === 1 ? { match: topCandidates[0] } : { candidates: topCandidates };
}
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

export function createAssistantInitialState(
  restoredMessages?: ReadonlyArray<AssistantMessage>,
): AssistantComposerState {
  const messages = restoredMessages ?? [];
  const maxId = messages.reduce((max, m) => {
    const num = Number.parseInt(m.id.replace("msg-", ""), 10);
    return Number.isFinite(num) && num > max ? num : max;
  }, 0);
  return {
    input: "",
    messages,
    loading: false,
    streamingStatus: "",
    streamingProgress: [],
    nextMessageId: maxId + 1,
    taskPlan: null,
    taskExecution: null,
    qualityReport: null,
    worldConsistencyReport: null,
    suggestedNextActions: [],
    operatorSession: ASSISTANT_DEFAULT_OPERATOR_SESSION,
  };
}

function restoreChatHistory(): ReadonlyArray<AssistantMessage> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(ASSISTANT_CHAT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m: unknown): m is AssistantMessage =>
        typeof m === "object" && m !== null
        && typeof (m as Record<string, unknown>).id === "string"
        && typeof (m as Record<string, unknown>).role === "string"
        && typeof (m as Record<string, unknown>).content === "string"
        && typeof (m as Record<string, unknown>).timestamp === "number",
    );
  } catch {
    return [];
  }
}

function saveChatHistory(messages: ReadonlyArray<AssistantMessage>): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = messages.length > ASSISTANT_CHAT_HISTORY_MAX_MESSAGES
      ? messages.slice(-ASSISTANT_CHAT_HISTORY_MAX_MESSAGES)
      : messages;
    window.sessionStorage.setItem(ASSISTANT_CHAT_HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore storage write failures
  }
}

interface AssistantChatPendingState {
  readonly loading: boolean;
  readonly prompt: string;
  readonly startedAt: number;
  readonly response?: string;
  readonly interimResponse?: string;
  readonly progressLogs?: ReadonlyArray<string>;
  readonly detached?: boolean;
  readonly detachedReason?: string;
  readonly error?: string;
  readonly completedAt?: number;
}

export interface AssistantRuntimeEventEntry {
  readonly timestamp?: string;
  readonly event?: string;
  readonly data?: unknown;
}

export function shouldKeepPendingOnChatDisconnect(errorMessage: string): boolean {
  return /连接中断|failed to fetch|network request failed|stream ended without response|timeout|timed out|http\s*5\d\d|\b50[234]\b|\b52[0-9]\b|gateway|bad gateway|upstream/i.test(errorMessage);
}

function matchesAgentInstruction(instruction: string, prompt: string): boolean {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) return true;
  if (instruction.trim() === normalizedPrompt) return true;
  return instruction.includes(`【用户请求】${normalizedPrompt}`);
}

function saveChatPendingState(pending: AssistantChatPendingState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ASSISTANT_CHAT_PENDING_KEY, JSON.stringify(pending));
  } catch { /* ignore */ }
}

function restoreChatPendingState(): AssistantChatPendingState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ASSISTANT_CHAT_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.prompt !== "string") return null;
    return parsed as AssistantChatPendingState;
  } catch { return null; }
}

function clearChatPendingState(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(ASSISTANT_CHAT_PENDING_KEY); } catch { /* ignore */ }
}

function appendStreamingProgressLine(
  lines: ReadonlyArray<string>,
  line: string,
): string[] {
  const normalized = line.trim();
  if (!normalized) {
    return [...lines];
  }
  const next = [...lines];
  const parse = (value: string): { base: string; count: number } => {
    const matched = value.match(/^(.*) \(x(\d+)\)$/u);
    return {
      base: (matched?.[1] ?? value).trim(),
      count: matched?.[2] ? Math.max(1, Number.parseInt(matched[2], 10)) : 1,
    };
  };

  const normalizedBase = parse(normalized).base;
  const duplicateIndex = next.findIndex((item) => parse(item).base === normalizedBase);
  if (duplicateIndex >= 0) {
    const current = parse(next[duplicateIndex] ?? normalizedBase);
    next[duplicateIndex] = `${current.base} (x${current.count + 1})`;
  } else {
    next.push(normalizedBase);
  }

  return next.slice(-12);
}

function buildAssistantThinkingLogs(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractAssistantProgressLineFromRuntimeLog(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const message = typeof (data as Record<string, unknown>).message === "string"
    ? ((data as Record<string, unknown>).message as string).trim()
    : "";
  if (!message) {
    return null;
  }
  return message;
}

async function fetchAssistantRuntimeProgressSince(startedAt: number): Promise<string[]> {
  try {
    const query = `/runtime/events?source=pipeline&limit=200`;
    const response = await fetchJson<{ entries?: AssistantRuntimeEventEntry[] }>(query);
    const entries = Array.isArray(response.entries) ? response.entries : [];
    const filtered = entries
      .filter((entry) => {
        if (typeof entry.timestamp !== "string") return false;
        const ts = Date.parse(entry.timestamp);
        return Number.isFinite(ts) && ts >= startedAt;
      })
      .filter((entry) => entry.event === "log")
      .map((entry) => extractAssistantProgressLineFromRuntimeLog(entry.data))
      .filter((line): line is string => Boolean(line));
    return filtered;
  } catch {
    return [];
  }
}

async function fetchAssistantAgentOutcomeSince(
  startedAt: number,
  prompt: string,
): Promise<{ ok: boolean; response?: string; error?: string } | null> {
  try {
    const query = `/runtime/events?source=agent&limit=200`;
    const response = await fetchJson<{ entries?: AssistantRuntimeEventEntry[] }>(query);
    return resolveAssistantAgentOutcomeFromRuntimeEvents(Array.isArray(response.entries) ? response.entries : [], startedAt, prompt);
  } catch {
    return null;
  }
}

export function resolveAssistantAgentOutcomeFromRuntimeEvents(
  entries: ReadonlyArray<AssistantRuntimeEventEntry>,
  startedAt: number,
  prompt: string,
): { ok: boolean; response?: string; error?: string } | null {
  const sorted = entries
    .map((entry) => {
      const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      return { entry, ts };
    })
    .filter(({ ts }) => Number.isFinite(ts) && ts >= startedAt)
    .sort((a, b) => b.ts - a.ts);

  for (const { entry } of sorted) {
    if (entry.event !== "agent:complete" && entry.event !== "agent:error") {
      continue;
    }
    const data = typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
      ? entry.data as Record<string, unknown>
      : null;
    if (!data) continue;
    const instruction = typeof data.instruction === "string" ? data.instruction : "";
    if (instruction && !matchesAgentInstruction(instruction, prompt)) {
      continue;
    }
    if (entry.event === "agent:complete") {
      const responseText = typeof data.response === "string" ? data.response.trim() : "";
      return responseText ? { ok: true, response: responseText } : null;
    }
    const errorText = typeof data.error === "string" ? data.error : "后台执行失败";
    return { ok: false, error: errorText };
  }
  return null;
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
    const status = payload.status === "succeeded" || payload.status === "failed" || payload.status === "waiting_approval"
      ? payload.status
      : "running";
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
  payload: { readonly stepId?: string; readonly action?: string; readonly error?: string; readonly status?: string; readonly nodeStatus?: string },
): string {
  if (event === "assistant:done") {
    return payload.status === "succeeded" ? "任务完成" : `任务失败${payload.error ? `：${payload.error}` : ""}`;
  }
  if (payload.action === "checkpoint") {
    if (event === "assistant:step:start") {
      return payload.nodeStatus === "waiting_approval"
        ? `审批节点 ${payload.stepId ?? ""} 等待批准`
        : `审批节点 ${payload.stepId ?? ""} 已触发`;
    }
    if (event === "assistant:step:success") {
      return `审批节点 ${payload.stepId ?? ""} 已批准`;
    }
    return `审批节点 ${payload.stepId ?? ""} 失败${payload.error ? `：${payload.error}` : ""}`;
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
  const inTaskExecutionContext = Boolean(state.taskExecution) || state.taskPlan?.status === "running";
  if (!inTaskExecutionContext) {
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
          ...(typeof payload?.nodeStatus === "string" ? { nodeStatus: payload.nodeStatus } : {}),
        },
      ),
      timestamp,
    };
  const terminal = message.event === "assistant:done";
  const taskStatus = message.event === "assistant:done"
    ? (payload?.status === "succeeded" ? "succeeded" : "failed")
    : payload?.nodeStatus === "waiting_approval"
      ? "waiting_approval"
      : "running";
  const nextTaskPlan = terminal
    ? (state.taskPlan
      ? transitionAssistantTaskPlan(state.taskPlan, taskStatus === "succeeded" ? "succeeded" : "failed", timestamp)
      : state.taskPlan)
    : state.taskPlan;
  return {
    ...state,
    loading: terminal || taskStatus === "waiting_approval" ? false : state.loading,
    taskPlan: nextTaskPlan,
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
  const timelineSource = snapshot.nodes
    ? Object.values(snapshot.nodes).map((node) => ({
        stepId: node.nodeId,
        action: node.action,
        status: node.status === "pending" ? "running" : node.status,
        startedAt: node.startedAt,
        finishedAt: node.finishedAt,
        error: node.error,
      }))
    : Object.values(snapshot.steps);
  const timeline = timelineSource
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
          message: formatAssistantTimelineMessage("assistant:step:start", { stepId: step.stepId, action: step.action, nodeStatus: step.status }),
          timestamp: startedAt,
        });
      }
      if (step.status !== "running" && step.status !== "waiting_approval" && step.finishedAt) {
        const event = step.status === "succeeded" ? "assistant:step:success" : "assistant:step:fail";
        const finishedAt = parseAssistantEventTimestamp(step.finishedAt);
        entries.push({
          id: `${snapshot.taskId}-${step.stepId}-${event}-${finishedAt}`,
          event,
          taskId: snapshot.taskId,
          stepId: step.stepId,
          ...(step.action ? { action: step.action } : {}),
          message: formatAssistantTimelineMessage(event, { stepId: step.stepId, action: step.action, error: step.error, nodeStatus: step.status }),
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
  const executionStatus = snapshot.nodes && Object.values(snapshot.nodes).some((node) => node.status === "waiting_approval")
    ? "waiting_approval"
    : snapshot.status;
  return {
    ...state,
    loading: done || executionStatus === "waiting_approval" ? false : state.loading,
    taskPlan: done ? (state.taskPlan ? transitionAssistantTaskPlan(state.taskPlan, snapshot.status, Date.now()) : state.taskPlan) : state.taskPlan,
    taskExecution: {
      taskId: snapshot.taskId,
      sessionId: snapshot.sessionId,
      status: executionStatus,
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
    streamingStatus: "",
    streamingProgress: [],
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
  responseText: string,
  now = Date.now(),
): AssistantComposerState {
  const content = responseText.trim() || "已完成，请继续下一步操作。";
  return {
    ...state,
    loading: false,
    streamingStatus: "",
    streamingProgress: [],
    taskPlan: state.taskPlan,
    taskExecution: state.taskExecution,
    qualityReport: state.qualityReport,
    worldConsistencyReport: state.worldConsistencyReport,
    suggestedNextActions: state.suggestedNextActions,
    operatorSession: state.operatorSession,
    messages: [...state.messages, {
      id: `msg-${state.nextMessageId}`,
      role: "assistant",
      content,
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
  targetBookIds: ReadonlyArray<string>,
): AssistantConfirmationDraft | null {
  if (targetBookIds.length === 0) return null;
  return {
    action: "template",
    prompt: template.prompt,
    targetBookIds: [...targetBookIds],
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

function isBookSelectionOnlyPrompt(
  prompt: string,
  matchedBook: Readonly<{ id: string; title: string }>,
): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;
  if (detectAssistantBookAction(normalized)) return false;
  if (CRUD_DELETE_ACTION_PATTERN.test(normalized) || CRUD_RESTORE_ACTION_PATTERN.test(normalized)) return false;
  if (WORLD_REPORT_ACTION_PATTERN.test(normalized) || CRUD_READ_ACTION_PATTERN.test(normalized)) return false;
  if (GENERATION_INTENT_PATTERN.test(normalized) || AUDIT_ACTION_PATTERN.test(normalized)) return false;

  const normalizeSelectionToken = (value: string): string => value
    .trim()
    .toLowerCase()
    .replace(/^[《「"'\s]+/u, "")
    .replace(/[》」"'\s]+$/u, "")
    .replace(/^(选择|选|就选|切换到|切到|切换|进入|打开|用|使用)\s*/iu, "")
    .replace(/\s*(这本书|这本小说|book)$/iu, "")
    .replace(/[《》「」\s:：]/gu, "");

  const barePrompt = normalizeSelectionToken(normalized);
  const bareTitle = normalizeSelectionToken(matchedBook.title);
  if (!barePrompt || !bareTitle) return false;
  if (barePrompt.length > 80) return false;
  return bareTitle.includes(barePrompt) || barePrompt.includes(bareTitle);
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

function inferAssistantReadRequestFromPrompt(prompt: string): {
  readonly dimension: AssistantCrudReadDimension;
  readonly chapter?: number;
  readonly keyword?: string;
} | null {
  const normalized = prompt.trim();
  if (!normalized) return null;
  if (detectAssistantBookAction(normalized)) return null;
  if (CRUD_DELETE_ACTION_PATTERN.test(normalized) || CRUD_RESTORE_ACTION_PATTERN.test(normalized)) return null;
  if (WORLD_REPORT_ACTION_PATTERN.test(normalized)) return null;
  if (WRITE_NEXT_ACTION_PATTERN.test(normalized)) return null;

  if (GENERATION_INTENT_PATTERN.test(normalized)) return null;

  // Skip complex prompts that contain modification/advice intent — route to agent chat instead
  if (/修改|调整|怎么办|如何|不符|偏离|问题|建议|帮我|你去/iu.test(normalized)) return null;

  // Skip long prompts (>40 chars) — they're likely complex requests for the agent
  if (normalized.length > 40) return null;

  const looksLikeNovelQ = NOVEL_QA_HINT_PATTERN.test(normalized);
  if (!looksLikeNovelQ) {
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
  const keyword = normalized.length > 80 ? normalized.slice(0, 80) : normalized;

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
  targetBookIds: ReadonlyArray<string>,
): AssistantConfirmationDraft | null {
  const action = detectAssistantBookAction(prompt);
  if (!action) return null;
  if (targetBookIds.length === 0) return null;
  return {
    action,
    prompt,
    targetBookIds: [...targetBookIds],
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

function buildAssistantAgentInstruction(
  prompt: string,
  selectedBookTitles: ReadonlyArray<string>,
): string {
  if (selectedBookTitles.length === 1) {
    const bookTitle = selectedBookTitles[0];
    return [
      `【当前锁定书籍】《${bookTitle}》`,
      "【执行要求】除非我明确要求切换书籍，否则不要再次询问“你想操作哪本书”。",
      `【用户请求】${prompt}`,
    ].join("\n");
  }
  return prompt;
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

function MessageList({
  messages,
  loading,
  streamingStatus,
  streamingProgress,
}: {
  readonly messages: ReadonlyArray<AssistantMessage>;
  readonly loading?: boolean;
  readonly streamingStatus?: string;
  readonly streamingProgress?: ReadonlyArray<string>;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const thinkingLogs = useMemo(
    () => buildAssistantThinkingLogs(streamingProgress ?? []),
    [streamingProgress],
  );
  const displayThinkingLogs = useMemo(() => {
    if (thinkingLogs.length > 0) {
      return thinkingLogs;
    }
    const fallback = (streamingStatus ?? "").trim();
    return fallback ? [fallback] : [];
  }, [thinkingLogs, streamingStatus]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading, streamingStatus, streamingProgress?.length]);
  return (
    <div className="space-y-3">
      {messages.map((message) => (
        <div
          key={message.id}
          className={cn(
            "max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed border",
            message.role === "user"
              ? "ml-auto bg-primary text-primary-foreground border-primary/30 whitespace-pre-wrap"
              : "bg-card text-card-foreground border-border prose prose-sm dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-2 max-w-none",
          )}
        >
          {message.role === "user" ? (
            message.content
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          )}
        </div>
      ))}
      {loading && (
        <div className="max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed border bg-card text-muted-foreground border-border space-y-1" data-testid="assistant-thinking-indicator">
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            <span>AI 助手正在思考…</span>
          </div>
          {displayThinkingLogs.length > 0 && (
            <div className="text-xs text-muted-foreground/70 pl-[22px]" data-testid="assistant-thinking-progress">
              <div
                className="h-10 overflow-y-auto pr-1 leading-5"
                data-testid="assistant-thinking-log-viewport"
              >
                <ul className="space-y-0.5">
                  {displayThinkingLogs.map((line, index) => (
                    <li key={`thinking-log-${index}`}>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
      <div ref={messagesEndRef} />
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
  const [state, setState] = useState<AssistantComposerState>(() => {
    const initial = createAssistantInitialState(restoreChatHistory());
    const pending = restoreChatPendingState();
    if (pending?.loading && Date.now() - pending.startedAt < ASSISTANT_CHAT_PENDING_TTL_MS) {
      const logs = Array.isArray(pending.progressLogs) ? pending.progressLogs.filter((line): line is string => typeof line === "string") : [];
      const lastStatus = logs.length > 0 ? logs[logs.length - 1] ?? "" : "";
      return {
        ...initial,
        loading: true,
        streamingProgress: logs,
        streamingStatus: lastStatus,
      };
    }
    return initial;
  });
  const { data: booksData } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { messages: sseMessages } = useSSE();
  const sseCursorRef = useRef(0);
  const evaluatedTaskIdRef = useRef<string | null>(null);
  const activeBooks = useMemo(
    () => (booksData?.books ?? []).filter((book) => book.status === BOOK_STATUS_ACTIVE),
    [booksData?.books],
  );
  const [chatBookContext, setChatBookContext] = useState<ChatBookContext | null>(null);
  const [scopeBlockHint, setScopeBlockHint] = useState("");
  const [crudReadResult, setCrudReadResult] = useState<AssistantCrudReadResponse | null>(null);
  const [crudDeletePreview, setCrudDeletePreview] = useState<AssistantCrudDeletePreviewResponse["preview"] | null>(null);
  const [crudDeleteResult, setCrudDeleteResult] = useState<AssistantCrudDeleteExecuteResponse | null>(null);
  const [crudBusy, setCrudBusy] = useState(false);
  const consumedPromptKeyRef = useRef<string | null>(null);
  const taskRecoveryAppliedRef = useRef<string | null>(null);
  const chatInFlightRef = useRef(false);
  const chatAbortRef = useRef<AbortController | null>(null);

  const quickActions = useMemo(() => ASSISTANT_QUICK_ACTIONS, []);
  const promptTemplates = useMemo(() => ASSISTANT_PROMPT_TEMPLATES, []);
  const activeBookIds = useMemo(() => activeBooks.map((book) => book.id), [activeBooks]);
  const activeBookTitleById = useMemo(
    () => new Map(activeBooks.map((book) => [book.id, book.title] as const)),
    [activeBooks],
  );
  const contextBookTitles = useMemo(
    () => chatBookContext ? [chatBookContext.title] : [],
    [chatBookContext],
  );

  const invalidateAssistantBookViews = useCallback((bookId?: string | null) => {
    const paths = ["/api/books"];
    if (bookId && bookId.trim().length > 0) {
      paths.push(`/api/books/${bookId}`);
    }
    invalidateApiPaths(paths);
  }, []);
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
    const pending = restoreChatPendingState();
    if (!pending) return;
    if (pending.loading && Date.now() - pending.startedAt >= ASSISTANT_CHAT_PENDING_TTL_MS) {
      clearChatPendingState();
      setState((prev) => prev.loading ? completeAssistantResponse(prev, "请求超时，请重试。") : prev);
      return;
    }
    if (pending.loading) {
      const logs = Array.isArray(pending.progressLogs) ? pending.progressLogs.filter((line): line is string => typeof line === "string") : [];
      setState((prev) => ({
        ...prev,
        loading: true,
        streamingStatus: (logs.length > 0 ? logs[logs.length - 1] : "") || prev.streamingStatus,
        streamingProgress: logs.length > 0 ? logs : prev.streamingProgress,
      }));
      return;
    }
    if (!pending.loading) {
      setState((prev) => {
        const lastMsg = prev.messages[prev.messages.length - 1];
        if (lastMsg?.role === "assistant") return prev;
        clearChatPendingState();
        if (pending.response) {
          return completeAssistantResponse(prev, pending.response);
        }
        return completeAssistantResponse(prev, `聊天请求失败：${pending.error ?? "未知错误"}`);
      });
    }
  }, []);

  useEffect(() => {
    if (!state.loading || chatInFlightRef.current) return;
    const intervalId = window.setInterval(() => {
      const pending = restoreChatPendingState();
      if (!pending) return;
      if (pending.loading) {
        const logs = Array.isArray(pending.progressLogs) ? pending.progressLogs.filter((line): line is string => typeof line === "string") : [];
        setState((prev) => {
          if (!prev.loading) return prev;
          const last = logs.length > 0 ? logs[logs.length - 1] ?? prev.streamingStatus : prev.streamingStatus;
          return {
            ...prev,
            streamingStatus: last,
            streamingProgress: logs.length > 0 ? logs : prev.streamingProgress,
          };
        });
        return;
      }
      window.clearInterval(intervalId);
      clearChatPendingState();
      setState((prev) => {
        if (!prev.loading) return prev;
        if (pending.response) {
          return completeAssistantResponse(prev, pending.response);
        }
        return completeAssistantResponse(prev, `聊天请求失败：${pending.error ?? "未知错误"}`);
      });
    }, ASSISTANT_CHAT_PENDING_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [state.loading]);

  useEffect(() => {
    if (!state.loading) {
      return;
    }
    const intervalId = window.setInterval(() => {
      const pending = restoreChatPendingState();
      if (!pending?.loading) {
        return;
      }
      void (async () => {
        const [runtimeLines, detachedOutcome] = await Promise.all([
          fetchAssistantRuntimeProgressSince(pending.startedAt),
          pending.detached ? fetchAssistantAgentOutcomeSince(pending.startedAt, pending.prompt) : Promise.resolve(null),
        ]);

        const mergedLines = runtimeLines.reduce<string[]>((acc, line) => appendStreamingProgressLine(acc, line), []);
        const last = mergedLines[mergedLines.length - 1] ?? "";

        saveChatPendingState({
          ...pending,
          ...(mergedLines.length > 0 ? { progressLogs: mergedLines } : {}),
        });
        if (mergedLines.length > 0) {
          setState((prev) => {
            if (!prev.loading) return prev;
            return {
              ...prev,
              streamingStatus: last || prev.streamingStatus,
              streamingProgress: mergedLines,
            };
          });
        }

        if (!detachedOutcome) {
          return;
        }
        const finalizedLogs = mergedLines.length > 0 ? mergedLines : (Array.isArray(pending.progressLogs) ? pending.progressLogs : []);
        if (detachedOutcome.ok && detachedOutcome.response) {
          saveChatPendingState({
            loading: false,
            prompt: pending.prompt,
            startedAt: pending.startedAt,
            response: detachedOutcome.response,
            completedAt: Date.now(),
            progressLogs: finalizedLogs,
          });
          const hintedBook = (chatBookContext?.id ?? (activeBooks.length === 1 ? activeBooks[0]?.id : undefined)) ?? undefined;
          invalidateAssistantBookViews(hintedBook);
          setState((prev) => completeAssistantResponse(prev, detachedOutcome.response!));
          return;
        }

        const errorMsg = detachedOutcome.error ?? "后台执行失败";
        saveChatPendingState({
          loading: false,
          prompt: pending.prompt,
          startedAt: pending.startedAt,
          error: errorMsg,
          completedAt: Date.now(),
          progressLogs: finalizedLogs,
        });
        setScopeBlockHint(`聊天请求失败：${errorMsg}`);
        setState((prev) => completeAssistantResponse(prev, `聊天请求失败：${errorMsg}`));
      })();
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [state.loading, activeBooks, chatBookContext, invalidateAssistantBookViews]);

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
    setState((prev) => {
      let next = prev;
      for (const message of pending) {
        next = applyAssistantTaskEventFromSSE(next, message);
        if (message.event === "log" && next.loading) {
          const line = extractAssistantProgressLineFromRuntimeLog(message.data);
          if (line) {
            const updatedProgress = appendStreamingProgressLine(next.streamingProgress, line);
            next = {
              ...next,
              streamingStatus: line,
              streamingProgress: updatedProgress,
            };
            const chatPending = restoreChatPendingState();
            if (chatPending?.loading) {
              saveChatPendingState({
                ...chatPending,
                progressLogs: updatedProgress,
              });
            }
          }
        }
      }
      return next;
    });
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
    saveChatHistory(state.messages);
  }, [state.messages]);

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
    // L0 templates: skip confirmation, route directly through chat
    if (template.riskLevel === "L0") {
      sendPrompt(template.prompt, { forceChat: true });
      return;
    }
    // L1 templates need a target book — use context or auto-select if only 1 active book
    const targetBookIds = chatBookContext ? [chatBookContext.id] : (activeBookIds.length === 1 ? [activeBookIds[0]] : []);
    if (targetBookIds.length === 0) {
      setScopeBlockHint("");
      setState((prev) => submitAssistantInput(prev, template.prompt));
      setState((prev) => completeAssistantResponse(prev, `请先告诉我你要操作哪本书。当前活跃书籍：${activeBooks.map((b) => `《${b.title}》`).join("、")}。`));
      return;
    }
    const draft = buildAssistantTemplateConfirmationDraft(template, targetBookIds);
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

  const sendPrompt = (rawPrompt: string, options?: { forceChat?: boolean }) => {
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
    if (state.loading || chatInFlightRef.current || state.taskPlan?.status === "awaiting-confirm" || state.taskPlan?.status === "running") {
      return;
    }

    // --- Smart book context resolution ---
    const bookResolution = resolveBookFromPrompt(normalizedPrompt, activeBooks);
    let resolvedContext = chatBookContext;

    if (bookResolution) {
      if ("match" in bookResolution) {
        // Exact or fuzzy match — update context
        resolvedContext = bookResolution.match;
        setChatBookContext(resolvedContext);
      } else if ("candidates" in bookResolution) {
        // Ambiguous — ask user to clarify
        setState((prev) => submitAssistantInput(prev, normalizedPrompt));
        const bookList = bookResolution.candidates.map((b, i) => `${i + 1}. 《${b.title}》`).join("\n");
        setState((prev) => completeAssistantResponse(prev, `你提到的书名匹配到了多本书，请告诉我你指的是哪一本：\n\n${bookList}\n\n你可以直接说书名或序号。`));
        return;
      }
    }

    // Auto-select if only 1 active book and no context yet
    if (!resolvedContext && activeBooks.length === 1) {
      resolvedContext = { id: activeBooks[0].id, title: activeBooks[0].title };
      setChatBookContext(resolvedContext);
    }

    const contextTitles = resolvedContext ? [resolvedContext.title] : activeBooks.map((b) => b.title);

    if (resolvedContext && isBookSelectionOnlyPrompt(normalizedPrompt, resolvedContext)) {
      setScopeBlockHint("");
      setState((prev) => submitAssistantInput(prev, normalizedPrompt));
      setState((prev) => completeAssistantResponse(prev, `已切换到《${resolvedContext.title}》。后续我会默认按这本书执行。`));
      return;
    }

    // Helper: require a single book for book-specific operations
    const requireSingleBook = (): string | null => {
      if (resolvedContext) return resolvedContext.id;
      if (activeBooks.length === 0) {
        setState((prev) => submitAssistantInput(prev, normalizedPrompt));
        setState((prev) => completeAssistantResponse(prev, "当前没有活跃书籍。请先创建一本书。"));
        return null;
      }
      // Multiple books, no context
      setState((prev) => submitAssistantInput(prev, normalizedPrompt));
      const bookList = activeBooks.map((b) => `- 《${b.title}》`).join("\n");
      setState((prev) => completeAssistantResponse(prev, `你想操作哪本书？当前活跃书籍：\n\n${bookList}\n\n请直接说书名，我会记住你的选择。`));
      return null;
    };

    // forceChat bypasses all local routing and sends directly to agent chat
    if (options?.forceChat) {
      setScopeBlockHint("");
      setState((prev) => submitAssistantInput(prev, normalizedPrompt));
      chatInFlightRef.current = true;
      saveChatPendingState({ loading: true, prompt: normalizedPrompt, startedAt: Date.now(), progressLogs: [] });
      const abortController = new AbortController();
      chatAbortRef.current = abortController;
      const agentPrompt = buildAssistantAgentInstruction(normalizedPrompt, contextTitles);
      void streamAssistantChat(agentPrompt, contextTitles, {
        abortSignal: abortController.signal,
        onProgress: (status) => {
          setState((prev) => {
            const logs = appendStreamingProgressLine(prev.streamingProgress, status);
            return {
              ...prev,
              streamingStatus: status,
              streamingProgress: logs,
            };
          });
          const pending = restoreChatPendingState();
          const merged = appendStreamingProgressLine(
            Array.isArray(pending?.progressLogs) ? pending.progressLogs : [],
            status,
          );
          saveChatPendingState({
            loading: true,
            prompt: normalizedPrompt,
            startedAt: pending?.startedAt ?? Date.now(),
            progressLogs: merged,
            ...(pending?.interimResponse ? { interimResponse: pending.interimResponse } : {}),
          });
        },
        onMessage: (content) => {
          const pending = restoreChatPendingState();
          saveChatPendingState({
            loading: true,
            prompt: normalizedPrompt,
            startedAt: pending?.startedAt ?? Date.now(),
            ...(Array.isArray(pending?.progressLogs) ? { progressLogs: pending.progressLogs } : {}),
            interimResponse: content,
          });
        },
        onDone: (result) => {
          chatInFlightRef.current = false;
          chatAbortRef.current = null;
          const pending = restoreChatPendingState();
          const startedAt = pending?.startedAt ?? Date.now();
          const progressLogs = Array.isArray(pending?.progressLogs) ? pending.progressLogs : [];
          if (result.ok && result.response) {
            const reply = result.response.trim() || "没有收到回复，请重试。";
            saveChatPendingState({ loading: false, prompt: normalizedPrompt, startedAt, response: reply, completedAt: Date.now(), progressLogs });
            invalidateAssistantBookViews(resolvedContext?.id ?? (activeBooks.length === 1 ? activeBooks[0]?.id : null));
            setState((prev) => completeAssistantResponse(prev, reply));
          } else {
            const errorMsg = result.error ?? "未知错误";
            if (shouldKeepPendingOnChatDisconnect(errorMsg)) {
              const recoveredLogs = appendStreamingProgressLine(progressLogs, "连接波动，正在继续同步后台进度…");
              saveChatPendingState({
                loading: true,
                prompt: normalizedPrompt,
                startedAt,
                progressLogs: recoveredLogs,
                detached: true,
                detachedReason: errorMsg,
                ...(typeof pending?.interimResponse === "string" && pending.interimResponse.trim().length > 0
                  ? { interimResponse: pending.interimResponse }
                  : {}),
              });
              setState((prev) => {
                if (!prev.loading) return prev;
                return {
                  ...prev,
                  streamingStatus: "连接波动，正在继续同步后台进度…",
                  streamingProgress: recoveredLogs,
                };
              });
              return;
            }
            saveChatPendingState({ loading: false, prompt: normalizedPrompt, startedAt, error: errorMsg, completedAt: Date.now(), progressLogs });
            setScopeBlockHint(`聊天请求失败：${errorMsg}`);
            setState((prev) => completeAssistantResponse(prev, `聊天请求失败：${errorMsg}`));
          }
        },
      });
      return;
    }

    const readRequest = parseAssistantCrudReadRequest(normalizedPrompt) ?? inferAssistantReadRequestFromPrompt(normalizedPrompt);
    if (readRequest) {
      const targetBookId = requireSingleBook();
      if (!targetBookId) return;
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
          const reply = response.summary || "未查到相关信息。";
          setState((prev) => completeAssistantResponse(prev, reply));
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
      const targetBookId = requireSingleBook();
      if (!targetBookId) return;
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
      const targetBookId = requireSingleBook();
      if (!targetBookId) return;
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

    if (detectAssistantBookAction(normalizedPrompt)) {
      let actionBookId: string | null = resolvedContext?.id ?? null;
      if (!actionBookId) {
        actionBookId = requireSingleBook();
        if (!actionBookId) return;
      }
      const draft = buildAssistantConfirmationDraft(normalizedPrompt, [actionBookId]);
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
    chatInFlightRef.current = true;
    saveChatPendingState({ loading: true, prompt: normalizedPrompt, startedAt: Date.now(), progressLogs: [] });

    const abortController = new AbortController();
    chatAbortRef.current = abortController;

    const agentPrompt = buildAssistantAgentInstruction(normalizedPrompt, contextTitles);

    void streamAssistantChat(agentPrompt, contextTitles, {
      abortSignal: abortController.signal,
      onProgress: (status) => {
        setState((prev) => {
          const logs = appendStreamingProgressLine(prev.streamingProgress, status);
          return {
            ...prev,
            streamingStatus: status,
            streamingProgress: logs,
          };
        });
        const pending = restoreChatPendingState();
        const merged = appendStreamingProgressLine(
          Array.isArray(pending?.progressLogs) ? pending.progressLogs : [],
          status,
        );
        saveChatPendingState({
          loading: true,
          prompt: normalizedPrompt,
          startedAt: pending?.startedAt ?? Date.now(),
          progressLogs: merged,
          ...(pending?.interimResponse ? { interimResponse: pending.interimResponse } : {}),
        });
      },
      onMessage: (content) => {
        const pending = restoreChatPendingState();
        saveChatPendingState({
          loading: true,
          prompt: normalizedPrompt,
          startedAt: pending?.startedAt ?? Date.now(),
          ...(Array.isArray(pending?.progressLogs) ? { progressLogs: pending.progressLogs } : {}),
          interimResponse: content,
        });
      },
      onDone: (result) => {
        chatInFlightRef.current = false;
        chatAbortRef.current = null;
        const pending = restoreChatPendingState();
        const startedAt = pending?.startedAt ?? Date.now();
        const progressLogs = Array.isArray(pending?.progressLogs) ? pending.progressLogs : [];
        if (result.ok && result.response) {
          const reply = result.response.trim() || "没有收到回复，请重试。";
          saveChatPendingState({ loading: false, prompt: normalizedPrompt, startedAt, response: reply, completedAt: Date.now(), progressLogs });
          invalidateAssistantBookViews(resolvedContext?.id ?? (activeBooks.length === 1 ? activeBooks[0]?.id : null));
          setState((prev) => completeAssistantResponse(prev, reply));
        } else {
          const errorMsg = result.error ?? "未知错误";
          if (shouldKeepPendingOnChatDisconnect(errorMsg)) {
            const recoveredLogs = appendStreamingProgressLine(progressLogs, "连接波动，正在继续同步后台进度…");
            saveChatPendingState({
              loading: true,
              prompt: normalizedPrompt,
              startedAt,
              progressLogs: recoveredLogs,
              detached: true,
              detachedReason: errorMsg,
              ...(typeof pending?.interimResponse === "string" && pending.interimResponse.trim().length > 0
                ? { interimResponse: pending.interimResponse }
                : {}),
            });
            setState((prev) => {
              if (!prev.loading) return prev;
              return {
                ...prev,
                streamingStatus: "连接波动，正在继续同步后台进度…",
                streamingProgress: recoveredLogs,
              };
            });
            return;
          }
          saveChatPendingState({ loading: false, prompt: normalizedPrompt, startedAt, error: errorMsg, completedAt: Date.now(), progressLogs });
          setScopeBlockHint(`聊天失败：${errorMsg}`);
          setState((prev) => completeAssistantResponse(prev, `聊天请求失败：${errorMsg}`));
        }
      },
    });
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
        readonly graph?: Record<string, unknown>;
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("assistant.scopeLabel")}</span>
            {chatBookContext ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary" data-testid="assistant-scope-summary">
                《{chatBookContext.title}》
                <button
                  onClick={() => setChatBookContext(null)}
                  className="ml-1 text-muted-foreground hover:text-destructive transition-colors"
                  title="清除书籍上下文"
                >
                  ✕
                </button>
              </span>
            ) : (
              <span className="text-muted-foreground/60" data-testid="assistant-scope-summary">
                {activeBooks.length > 0
                  ? `${activeBooks.length} 本活跃书籍 — 聊天时会自动识别`
                  : t("assistant.scopeNoBooks")}
              </span>
            )}
          </div>
          {scopeBlockHint && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-testid="assistant-scope-blocked">
              {scopeBlockHint}
            </div>
          )}
        </div>
      </section>

        <section className="flex-1 min-h-[360px] overflow-y-auto rounded-xl border border-border/70 bg-background/70 p-4" data-testid="assistant-message-list">
          {showLoading ? <LoadingConversation /> : state.messages.length === 0 ? <EmptyConversation /> : <MessageList messages={state.messages} loading={state.loading} streamingStatus={state.streamingStatus} streamingProgress={state.streamingProgress} />}
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
