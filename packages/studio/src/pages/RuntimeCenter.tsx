import { useApi, postApi } from "../hooks/use-api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { normalizeStudioEventName, type SSEMessage } from "../hooks/use-sse";
import { shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import type { DaemonSessionState, DaemonSessionSummary } from "../shared/contracts";
import { BookScopePicker } from "../components/daemon/BookScopePicker";
import { PlanBudgetCard } from "../components/daemon/PlanBudgetCard";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Nav {
  toDashboard: () => void;
}

export interface EventFilter {
  level: string;
  source: string;
  bookId: string;
}

export type RuntimeSchedulerMode = "default" | "advanced";

export interface RuntimeAdvancedForm {
  readonly scopeType: "all-active" | "book-list";
  readonly bookIdsText: string;
  readonly perBookChapterCap: string;
  readonly globalChapterCap: string;
  readonly frequencyMinutes: string;
  readonly cooldownSeconds: string;
  readonly concurrency: string;
}

export interface RuntimeSessionViewModel {
  readonly state: DaemonSessionState;
  readonly currentBook: string;
  readonly currentChapter: string;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly recentError: string;
}

export interface RuntimeBookRunViewModel {
  readonly bookId: string;
  readonly title: string;
  readonly chapter: string;
  readonly completedCount: number;
  readonly status: string;
  readonly isCurrent: boolean;
}

export interface RuntimeControlState {
  readonly showStart: boolean;
  readonly showPause: boolean;
  readonly showResume: boolean;
  readonly stopDisabled: boolean;
}

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

const COMPLETED_STATUSES = ["done", "complete", "completed", "success"];

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Derive a level label from an SSE message.  The "log" event carries a `level`
 * field; for other events we infer info/warn/error from the event name suffix.
 */
export function deriveEventLevel(msg: SSEMessage): string {
  const data = msg.data as Record<string, unknown> | null;
  const normalizedEvent = normalizeStudioEventName(msg.event);
  if (msg.event === "log" && typeof data?.level === "string") {
    return data.level.toLowerCase();
  }
  if (normalizedEvent.endsWith(":error")) return "error";
  if (normalizedEvent.endsWith(":fail")) return "error";
  if (normalizedEvent.endsWith(":complete")) return "info";
  if (normalizedEvent.endsWith(":success")) return "info";
  if (normalizedEvent.endsWith(":done")) return "info";
  if (normalizedEvent.endsWith(":start")) return "info";
  if (normalizedEvent.endsWith(":progress")) return "info";
  if (normalizedEvent.endsWith(":unchanged")) return "info";
  return "debug";
}

/**
 * Derive a source label (the event prefix before the first colon).
 */
export function deriveEventSource(msg: SSEMessage): string {
  const colon = msg.event.indexOf(":");
  return colon === -1 ? msg.event : msg.event.slice(0, colon);
}

// ---------------------------------------------------------------------------
// Event display helpers
// ---------------------------------------------------------------------------

/** Extract the actual user request text from a NovelOS instruction string. */
function extractUserRequest(instruction: string): string {
  const match = instruction.match(/【用户请求】([\s\S]+?)(?:【|$)/u);
  if (match?.[1]) return match[1].trim();
  const stripped = instruction.replace(/【[^】]*】[^\n]*/gu, "").trim();
  return stripped || instruction.slice(0, 200);
}

/**
 * Human-readable Chinese label for each SSE event type.
 */
export function deriveEventLabel(event: string): string {
  const normalized = normalizeStudioEventName(event);
  const labels: Record<string, string> = {
    "agent:start": "用户指令",
    "agent:complete": "助手回复",
    "agent:error": "助手出错",
    "llm:call:start": "AI 开始",
    "llm:call:progress": "AI 生成中",
    "llm:call:done": "AI 完成",
    "plan:start": "章节规划",
    "plan:success": "规划完成",
    "plan:fail": "规划失败",
    "compose:start": "开始写稿",
    "compose:success": "写稿完成",
    "compose:fail": "写稿失败",
    "write-next:start": "任务启动",
    "write-next:success": "任务完成",
    "write-next:fail": "任务失败",
    "assistant:step:start": "步骤启动",
    "assistant:step:success": "步骤完成",
    "assistant:step:fail": "步骤失败",
    "assistant:done": "任务结束",
    "chapter:version:created": "版本快照",
    "log": "日志",
    "daemon:chapter": "章节状态",
    "daemon:started": "调度启动",
    "daemon:paused": "调度暂停",
    "daemon:resumed": "调度恢复",
    "daemon:stopped": "调度停止",
    "daemon:error": "调度错误",
  };
  return labels[normalized] ?? labels[event] ?? (normalized.split(":").pop() ?? normalized);
}

/**
 * Badge colour class for a given (normalised) event name.
 */
function deriveEventBadgeStyle(event: string): string {
  if (event === "agent:start") return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
  if (event === "agent:complete") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (event === "agent:error") return "bg-destructive/15 text-destructive";
  if (event.startsWith("llm:call:")) return "bg-violet-500/15 text-violet-600 dark:text-violet-400";
  if (event === "plan:start" || event === "plan:success") return "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400";
  if (event === "compose:start" || event === "compose:success") return "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400";
  if (event.startsWith("write-next:")) return "bg-teal-500/15 text-teal-600 dark:text-teal-400";
  if (event.startsWith("assistant:step:")) return "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400";
  if (event === "assistant:done") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (event === "chapter:version:created") return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  if (event.endsWith(":error") || event.endsWith(":fail")) return "bg-destructive/15 text-destructive";
  if (event.endsWith(":success") || event.endsWith(":done") || event.endsWith(":complete")) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  return "bg-muted/80 text-muted-foreground/60";
}

/** True when a log event carries an "阶段：" or "Stage:" stage announcement. */
function isStageLog(msg: SSEMessage): boolean {
  if (msg.event !== "log") return false;
  const data = msg.data as Record<string, unknown> | null;
  const message = typeof data?.message === "string" ? data.message : "";
  return message.startsWith("阶段：") || message.startsWith("Stage:");
}

/**
 * Returns the full markdown body to show in the expandable section,
 * or null when there is nothing rich to expand.
 */
export function getRichEventContent(msg: SSEMessage): string | null {
  const data = msg.data as Record<string, unknown> | null;
  const event = normalizeStudioEventName(msg.event);
  if (event === "agent:complete") {
    const response = typeof data?.response === "string" ? data.response.trim() : "";
    return response || null;
  }
  return null;
}

export function formatRuntimeEventMessage(msg: SSEMessage): string {
  const data = msg.data as Record<string, unknown> | null;
  const event = normalizeStudioEventName(msg.event);

  // ── LLM streaming events ─────────────────────────────────────────────────
  if (event.startsWith("llm:call:")) {
    const purpose = typeof data?.purpose === "string" && data.purpose.trim().length > 0
      ? data.purpose.trim()
      : "LLM 调用";
    const agentName = typeof data?.agentName === "string" ? data.agentName : "agent";
    const chineseChars = typeof data?.chineseChars === "number" ? data.chineseChars : 0;
    const elapsedMs = typeof data?.elapsedMs === "number" ? data.elapsedMs : 0;
    const seconds = Math.max(0, Math.round(elapsedMs / 1000));
    const preview = typeof data?.preview === "string" ? data.preview.trim().replace(/\s+/g, " ").slice(-180) : "";
    if (event === "llm:call:start") {
      return `${purpose} · ${agentName} 开始`;
    }
    if (event === "llm:call:done") {
      return `${purpose} · ${agentName} 完成，输出约 ${chineseChars} 个中文字${preview ? `。最近输出：${preview}` : ""}`;
    }
    return `${purpose} · ${agentName} 正在输出，已用 ${seconds}s，约 ${chineseChars} 个中文字${preview ? `。最近输出：${preview}` : ""}`;
  }
  if (event === "llm:progress") {
    const chineseChars = typeof data?.chineseChars === "number" ? data.chineseChars : 0;
    const elapsedMs = typeof data?.elapsedMs === "number" ? data.elapsedMs : 0;
    return `LLM 正在输出，已用 ${Math.round(elapsedMs / 1000)}s，约 ${chineseChars} 个中文字`;
  }

  // ── Version snapshot ──────────────────────────────────────────────────────
  if (event === "chapter:version:created") {
    const label = typeof data?.label === "string" ? data.label : "章节版本已记录";
    const applied = data?.applied === true;
    const reason = typeof data?.rejectedReason === "string" ? data.rejectedReason : "";
    return `${label}${applied ? "，已应用" : "，仅作候选"}${reason ? `。原因：${reason}` : ""}`;
  }

  // ── Agent conversation events ─────────────────────────────────────────────
  if (event === "agent:start") {
    const instruction = typeof data?.instruction === "string" ? data.instruction : "";
    const userRequest = extractUserRequest(instruction);
    return userRequest || "处理指令中…";
  }
  if (event === "agent:complete") {
    const instruction = typeof data?.instruction === "string" ? data.instruction : "";
    const userRequest = extractUserRequest(instruction);
    const preview = userRequest.slice(0, 60) + (userRequest.length > 60 ? "…" : "");
    return preview ? `「${preview}」` : "回复完成";
  }

  // ── Pipeline lifecycle events ─────────────────────────────────────────────
  if (event.startsWith("plan:")) {
    const ch = typeof data?.chapterNumber === "number" ? data.chapterNumber
      : typeof data?.chapter === "number" ? data.chapter : null;
    const stage = event === "plan:start" ? "开始规划" : event === "plan:success" ? "规划完成" : "规划失败";
    return `第 ${ch ?? "?"} 章 · ${stage}`;
  }
  if (event.startsWith("compose:")) {
    const ch = typeof data?.chapterNumber === "number" ? data.chapterNumber
      : typeof data?.chapter === "number" ? data.chapter : null;
    const wordCount = typeof data?.wordCount === "number" ? data.wordCount : null;
    const title = typeof data?.title === "string" && data.title ? `《${data.title}》` : "";
    const stage = event === "compose:start" ? "开始写稿" : event === "compose:success" ? "写稿完成" : "写稿失败";
    return `第 ${ch ?? "?"} 章${title} · ${stage}${wordCount ? `，约 ${wordCount} 字` : ""}`;
  }
  if (event.startsWith("write-next:")) {
    const ch = typeof data?.chapterNumber === "number" ? data.chapterNumber
      : typeof data?.chapter === "number" ? data.chapter : null;
    if (event === "write-next:start") return `第 ${ch ?? "?"} 章 · 写稿任务启动`;
    if (event === "write-next:success") {
      const wordCount = typeof data?.wordCount === "number" ? data.wordCount : null;
      const title = typeof data?.title === "string" && data.title ? `《${data.title}》` : "";
      return `第 ${ch ?? "?"} 章${title} · 写稿完成${wordCount ? `，约 ${wordCount} 字` : ""}`;
    }
    const error = typeof data?.error === "string" ? data.error : "";
    return `第 ${ch ?? "?"} 章 · 写稿失败${error ? `：${error.slice(0, 60)}` : ""}`;
  }

  // ── Assistant orchestration events ────────────────────────────────────────
  if (event.startsWith("assistant:step:")) {
    const action = typeof data?.action === "string" ? data.action : "";
    const ch = typeof data?.chapterNumber === "number" ? data.chapterNumber
      : typeof data?.chapter === "number" ? data.chapter : null;
    const actionLabels: Record<string, string> = {
      "write-next": "写稿", "compose": "写稿", "plan": "规划",
      "revise": "修订", "rewrite": "重写", "audit": "审计",
      "resync": "重同步", "anti-detect": "去AI痕",
    };
    const actionText = actionLabels[action] ?? action;
    const stage = event === "assistant:step:start" ? "启动"
      : event === "assistant:step:success" ? "完成" : "失败";
    return `${actionText} ${stage}${ch ? ` · 第 ${ch} 章` : ""}`;
  }
  if (event === "assistant:done") {
    const status = typeof data?.status === "string" ? data.status : "";
    return status === "succeeded" ? "全部步骤执行完成" : `任务结束：${status}`;
  }

  // ── Log events ────────────────────────────────────────────────────────────
  if (msg.event === "log") {
    const message = typeof data?.message === "string" ? data.message : "";
    return message || JSON.stringify(data);
  }

  return String(data?.message ?? data?.bookId ?? JSON.stringify(data));
}

/**
 * Filter a list of SSE messages according to level / source / bookId.
 * An empty string value means "no filter applied" for that field.
 */
export function filterEvents(
  messages: ReadonlyArray<SSEMessage>,
  filter: EventFilter,
): ReadonlyArray<SSEMessage> {
  return messages.filter((msg) => {
    if (isNoisyEvent(msg)) return false;
    if (filter.level && deriveEventLevel(msg) !== filter.level) return false;
    if (filter.source && deriveEventSource(msg) !== filter.source) return false;
    if (filter.bookId) {
      const data = msg.data as Record<string, unknown> | null;
      if (typeof data?.bookId !== "string" || data.bookId !== filter.bookId) return false;
    }
    return true;
  });
}

function extractChapterNumber(msg: SSEMessage): number | undefined {
  const data = msg.data as Record<string, unknown> | null;
  const chapterNumber = data?.chapterNumber;
  if (typeof chapterNumber === "number" && Number.isFinite(chapterNumber)) {
    return chapterNumber;
  }
  const chapter = data?.chapter;
  if (typeof chapter === "number" && Number.isFinite(chapter)) {
    return chapter;
  }
  const message = typeof data?.message === "string" ? data.message : "";
  if (message) {
    const match = message.match(/第\s*(\d+)\s*章/u);
    if (match) {
      return Number.parseInt(match[1] ?? "", 10);
    }
  }
  return undefined;
}

function isNoisyEvent(msg: SSEMessage): boolean {
  if (msg.event === "ping") return true;
  if (msg.event === "llm:progress") return true;
  if (msg.event !== "log") return false;
  const data = msg.data as Record<string, unknown> | null;
  const message = typeof data?.message === "string" ? data.message.trim().toLowerCase() : "";
  return message === "ping null" || message === "ping";
}

function getBookId(msg: SSEMessage): string | undefined {
  const data = msg.data as Record<string, unknown> | null;
  return typeof data?.bookId === "string" ? data.bookId : undefined;
}

export function deriveRuntimeBookRunViewModels(
  session: DaemonSessionSummary | null,
  messages: ReadonlyArray<SSEMessage>,
  bookTitleById: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<RuntimeBookRunViewModel> {
  const cleanMessages = messages.filter((msg) => !isNoisyEvent(msg));
  const bookIds = new Set<string>(session?.activeBookIds ?? []);

  for (const msg of cleanMessages) {
    const bookId = getBookId(msg);
    if (bookId) bookIds.add(bookId);
  }

  if (session?.currentBookId) {
    bookIds.add(session.currentBookId);
  }

  const list = [...bookIds].map((bookId) => {
    const byBook = cleanMessages.filter((msg) => getBookId(msg) === bookId);
    const chapterEvents = byBook
      .filter((msg) => msg.event === "daemon:chapter")
      .map((msg) => msg.data as Record<string, unknown>);
    const latestChapterEvent = chapterEvents.at(-1);
    const latestChapter = [...byBook].reverse().map(extractChapterNumber).find((v) => typeof v === "number");
    const completedCount = chapterEvents.filter(
      (data) => typeof data.status === "string" && COMPLETED_STATUSES.includes(data.status),
    ).length;
    const rawStatus = typeof latestChapterEvent?.status === "string"
      ? latestChapterEvent.status
      : (bookId === session?.currentBookId && session?.running ? "running" : "waiting");
    return {
      bookId,
      title: bookTitleById.get(bookId) ?? bookId,
      chapter: typeof latestChapter === "number" ? String(latestChapter) : "待调度",
      completedCount,
      status: rawStatus,
      isCurrent: bookId === session?.currentBookId,
    } satisfies RuntimeBookRunViewModel;
  });

  return list.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return a.title.localeCompare(b.title, "zh-CN");
  });
}

/**
 * Choose the empty-state hint key based on daemon state and filter activity.
 */
export function deriveEmptyHint(
  isRunning: boolean,
  hasFilter: boolean,
): "rc.emptyIdle" | "rc.emptyRunning" | "rc.emptyFiltered" {
  if (hasFilter) return "rc.emptyFiltered";
  return isRunning ? "rc.emptyRunning" : "rc.emptyIdle";
}

export function parseBookIds(bookIdsText: string): string[] {
  return Array.from(new Set(
    bookIdsText
      .split(/[,\n]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ));
}

function parsePositiveInt(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function validateAdvancedForm(form: RuntimeAdvancedForm): string[] {
  const errors: string[] = [];
  if (form.scopeType === "book-list" && parseBookIds(form.bookIdsText).length === 0) {
    errors.push("rc.error.bookIdsRequired");
  }
  if (parsePositiveInt(form.perBookChapterCap) === null) errors.push("rc.error.perBookRequired");
  if (parsePositiveInt(form.globalChapterCap) === null) errors.push("rc.error.globalRequired");
  if (parsePositiveInt(form.frequencyMinutes) === null) errors.push("rc.error.frequencyRequired");
  if (parsePositiveInt(form.cooldownSeconds) === null) errors.push("rc.error.cooldownRequired");
  if (parsePositiveInt(form.concurrency) === null) errors.push("rc.error.concurrencyRequired");
  return errors;
}

export function buildAdvancedPlanPayload(form: RuntimeAdvancedForm): {
  readonly plan: Record<string, unknown>;
} {
  const bookIds = parseBookIds(form.bookIdsText);
  return {
    plan: {
      mode: "custom-plan",
      bookScope: form.scopeType === "book-list"
        ? { type: "book-list", bookIds }
        : { type: "all-active" },
      perBookChapterCap: Number(form.perBookChapterCap),
      globalChapterCap: Number(form.globalChapterCap),
      schedule: {
        everyMinutes: Number(form.frequencyMinutes),
        cooldownSeconds: Number(form.cooldownSeconds),
      },
      maxConcurrentBooks: Number(form.concurrency),
    },
  };
}

export function deriveRuntimeSessionViewModel(
  session: DaemonSessionSummary | null,
  messages: ReadonlyArray<SSEMessage>,
  bookTitleById: ReadonlyMap<string, string> = new Map(),
): RuntimeSessionViewModel {
  const cleanMessages = messages.filter((msg) => !isNoisyEvent(msg));
  const chapterEvents = cleanMessages
    .filter((msg) => msg.event === "daemon:chapter")
    .map((msg) => msg.data as Record<string, unknown>);
  const latestChapter = chapterEvents.at(-1);
  const eventCurrentBookId = typeof latestChapter?.bookId === "string" ? latestChapter.bookId : undefined;
  const sessionCurrentBookId = typeof session?.currentBookId === "string" ? session.currentBookId : undefined;
  const fallbackBookId = session?.activeBookIds?.[0];
  const currentBookId = eventCurrentBookId ?? sessionCurrentBookId ?? fallbackBookId;
  const currentBookTitle = currentBookId ? bookTitleById.get(currentBookId) : undefined;
  const currentBook = currentBookId
    ? currentBookTitle ?? currentBookId
    : "—";
  const latestChapterFromMessages = [...cleanMessages]
    .reverse()
    .map(extractChapterNumber)
    .find((value) => typeof value === "number");
  const currentChapter = typeof latestChapter?.chapter === "number"
    ? String(latestChapter.chapter)
    : typeof latestChapterFromMessages === "number"
      ? String(latestChapterFromMessages)
    : typeof session?.currentChapter === "number"
      ? String(session.currentChapter)
      : session?.state === "running" && currentBookId
        ? "待调度"
        : "—";
  const completedFromEvents = chapterEvents.filter(
    (data) => typeof data.status === "string" && COMPLETED_STATUSES.includes(data.status),
  ).length;
  const completedCount = session?.completedCount ?? completedFromEvents;
  const failedFromEvents = cleanMessages.filter((msg) => deriveEventLevel(msg) === "error").length;
  const failedCount = session?.failedCount ?? failedFromEvents;
  const latestErrorMessage = [...cleanMessages].reverse().find((msg) => deriveEventLevel(msg) === "error");
  const latestData = latestErrorMessage?.data as Record<string, unknown> | undefined;
  const recentError = session?.lastError?.message
    ?? (typeof latestData?.error === "string" ? latestData.error : "");
  return {
    state: session?.state ?? "idle",
    currentBook,
    currentChapter,
    completedCount,
    failedCount,
    recentError: recentError || "—",
  };
}

export function deriveRuntimeControlState(
  daemonState: DaemonSessionState,
  loading: boolean,
): RuntimeControlState {
  const showStart = daemonState === "idle" || daemonState === "stopped" || daemonState === "error";
  const showPause = daemonState === "running";
  const showResume = daemonState === "paused";
  const stopDisabled = loading || daemonState === "idle" || daemonState === "stopped" || daemonState === "error";
  return { showStart, showPause, showResume, stopDisabled };
}

// ---------------------------------------------------------------------------
// Markdown renderer (no typography plugin required)
// ---------------------------------------------------------------------------

function MarkdownContent({ content }: { content: string }) {
  return (
    <div
      className="
        text-xs leading-relaxed text-foreground/85
        [&_h1]:text-sm [&_h1]:font-bold [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-foreground
        [&_h2]:text-xs [&_h2]:font-bold [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h2]:text-foreground/90
        [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-0.5 [&_h3]:text-foreground/85
        [&_p]:my-1 [&_p]:leading-relaxed
        [&_ul]:pl-4 [&_ul]:my-1 [&_ul>li]:list-disc [&_ul>li]:my-0.5
        [&_ol]:pl-4 [&_ol]:my-1 [&_ol>li]:list-decimal [&_ol>li]:my-0.5
        [&_table]:w-full [&_table]:border-collapse [&_table]:text-[11px] [&_table]:my-2
        [&_th]:text-left [&_th]:px-2 [&_th]:py-1 [&_th]:border [&_th]:border-border/50 [&_th]:bg-muted/40 [&_th]:font-semibold [&_th]:whitespace-nowrap
        [&_td]:px-2 [&_td]:py-1 [&_td]:border [&_td]:border-border/50 [&_td]:leading-snug [&_td]:align-top
        [&_tr:nth-child(even)_td]:bg-muted/20
        [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:my-1.5
        [&_hr]:border-border/30 [&_hr]:my-2
        [&_strong]:font-semibold [&_em]:italic
        [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[10px] [&_code]:font-mono
        [&_pre]:bg-muted/60 [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-x-auto [&_pre]:my-1.5 [&_pre]:text-[10px]
        [&_a]:text-primary [&_a]:underline
      "
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventRow – single event display with optional expandable markdown
// ---------------------------------------------------------------------------

function EventRow({ msg }: { msg: SSEMessage }) {
  const [expanded, setExpanded] = useState(false);
  const data = msg.data as Record<string, unknown> | null;
  const level = deriveEventLevel(msg);
  const event = normalizeStudioEventName(msg.event);
  const label = deriveEventLabel(msg.event);
  const text = formatRuntimeEventMessage(msg);
  const richContent = getRichEventContent(msg);
  const ts = new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
  const isAgentComplete = event === "agent:complete";
  const badgeStyle = deriveEventBadgeStyle(event);
  const isError = level === "error";

  // Stage announcements get a special highlighted row
  if (isStageLog(msg)) {
    return (
      <div className="flex items-center gap-2 py-1.5 px-2 my-1 rounded-sm bg-amber-500/8 border-l-2 border-amber-500/60">
        <span className="text-muted-foreground/40 shrink-0 tabular-nums text-[10px] w-16">{ts}</span>
        <span className="text-amber-600 dark:text-amber-400 text-[11px] font-medium">{text}</span>
      </div>
    );
  }

  // Agent complete response gets a card with expandable markdown
  if (isAgentComplete) {
    return (
      <div className="border border-border/50 bg-muted/5 rounded-md overflow-hidden my-2">
        <div className="flex gap-2 items-start p-2.5">
          <span className="text-muted-foreground/40 shrink-0 tabular-nums text-[10px] w-16 pt-0.5">{ts}</span>
          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide whitespace-nowrap ${badgeStyle}`}>
            {label}
          </span>
          <span className="flex-1 break-all text-xs text-foreground/90 font-medium">
            {text}
          </span>
          {richContent && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="shrink-0 text-[11px] text-primary/60 hover:text-primary transition-colors whitespace-nowrap ml-1"
            >
              {expanded ? "收起 ↑" : "查看回复 ↓"}
            </button>
          )}
        </div>
        {richContent && expanded && (
          <div className="border-t border-border/30 px-3 py-2.5 max-h-[600px] overflow-y-auto">
            <MarkdownContent content={richContent} />
          </div>
        )}
      </div>
    );
  }

  // Default compact row
  return (
    <div className="flex gap-2 items-start leading-relaxed py-0.5">
      <span className="text-muted-foreground/40 shrink-0 tabular-nums text-[10px] w-16 pt-0.5">{ts}</span>
      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide whitespace-nowrap ${badgeStyle}`}>
        {label}
      </span>
      <span className={`flex-1 break-all text-[11px] ${isError ? "text-destructive" : "text-foreground/75"}`}>
        {text}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RuntimeCenter({
  nav,
  theme,
  t,
  sse,
}: {
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data: daemonSession, refetch: refetchDaemon } = useApi<DaemonSessionSummary>("/daemon/session");
  const { data: booksData } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const [loading, setLoading] = useState(false);
  const [streamPaused, setStreamPaused] = useState(false);
  const [mode, setMode] = useState<RuntimeSchedulerMode>("default");
  const [formError, setFormError] = useState("");
  const [advancedForm, setAdvancedForm] = useState<RuntimeAdvancedForm>({
    scopeType: "all-active",
    bookIdsText: "",
    perBookChapterCap: "1",
    globalChapterCap: "10",
    frequencyMinutes: "1",
    cooldownSeconds: "1",
    concurrency: "1",
  });
  const [filter, setFilter] = useState<EventFilter>({ level: "", source: "", bookId: "" });
  const streamRef = useRef<HTMLDivElement | null>(null);

  // Auto-refetch daemon status on relevant SSE events
  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!shouldRefetchDaemonStatus(recent)) return;
    void refetchDaemon();
  }, [refetchDaemon, sse.messages]);

  // Poll daemon session while running to keep status cards fresh even if SSE is sparse.
  useEffect(() => {
    if (!daemonSession?.running) return;
    const timer = window.setInterval(() => {
      void refetchDaemon();
    }, 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [daemonSession?.running, refetchDaemon]);

  // Auto-scroll unless paused
  useEffect(() => {
    if (streamPaused) return;
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [sse.messages, streamPaused]);

  const sessionState = daemonSession?.state ?? "idle";
  const isRunning = daemonSession?.running ?? false;
  const controls = deriveRuntimeControlState(sessionState, loading);
  const bookTitleById = useMemo(
    () => new Map((booksData?.books ?? []).map((book) => [book.id, book.title] as const)),
    [booksData?.books],
  );
  const sessionView = deriveRuntimeSessionViewModel(daemonSession ?? null, sse.messages, bookTitleById);
  const bookRunViews = useMemo(
    () => deriveRuntimeBookRunViewModels(daemonSession ?? null, sse.messages, bookTitleById),
    [daemonSession, sse.messages, bookTitleById],
  );
  const activeBooks = useMemo(
    () => (booksData?.books ?? []).filter((book) => ["incubating", "outlining", "active", "paused"].includes(book.status)),
    [booksData?.books],
  );
  const selectedBookIds = useMemo(
    () => parseBookIds(advancedForm.bookIdsText),
    [advancedForm.bookIdsText],
  );
  const budgetTargetBookCount = advancedForm.scopeType === "all-active" ? activeBooks.length : selectedBookIds.length;

  const hasFilter = Boolean(filter.level || filter.source || filter.bookId);
  const visible = filterEvents(sse.messages, filter);

  const handleStart = async () => {
    setFormError("");
    if (mode === "advanced") {
      const errors = validateAdvancedForm(advancedForm);
      if (errors.length > 0) {
        setFormError(errors.map((key) => t(key as never)).join("；"));
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === "default") {
        await postApi("/daemon/start", { default: true });
      } else {
        const planned = await postApi<{ planId: string }>("/daemon/plan", buildAdvancedPlanPayload(advancedForm));
        await postApi("/daemon/start", { planId: planned.planId });
      }
      refetchDaemon();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePause = async () => {
    setLoading(true);
    try {
      await postApi("/daemon/pause");
      refetchDaemon();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResume = async () => {
    setLoading(true);
    try {
      await postApi("/daemon/resume");
      refetchDaemon();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await postApi("/daemon/stop");
      refetchDaemon();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const emptyHintKey = deriveEmptyHint(isRunning, hasFilter);

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>
          {t("bread.home")}
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("rc.title")}</span>
      </div>

      {/* Page title */}
      <h1 className="font-serif text-3xl">{t("rc.title")}</h1>

      {/* Daemon Status Card */}
      <div className={`border ${c.cardStatic} rounded-lg p-5 space-y-4`}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`w-2.5 h-2.5 rounded-full ${isRunning ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"}`}
            />
            <div>
              <div className="text-sm font-semibold text-foreground/80 uppercase tracking-wider">
                {t("rc.daemonCard")}
              </div>
              <div className={`text-xs mt-0.5 ${isRunning ? "text-emerald-500" : "text-muted-foreground"}`}>
                {t(`rc.sessionState.${sessionView.state}` as never)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {controls.showStart && (
              <button
                onClick={handleStart}
                disabled={loading}
                className={`px-4 py-2 text-sm rounded-md ${c.btnPrimary} disabled:opacity-50`}
              >
                {loading ? t("daemon.starting") : t("daemon.start")}
              </button>
            )}
            {controls.showPause && (
              <button
                onClick={handlePause}
                disabled={loading}
                className={`px-4 py-2 text-sm rounded-md ${c.btnSecondary} disabled:opacity-50`}
              >
                {loading ? t("rc.pausing") : t("rc.pauseDaemon")}
              </button>
            )}
            {controls.showResume && (
              <button
                onClick={handleResume}
                disabled={loading}
                className={`px-4 py-2 text-sm rounded-md ${c.btnPrimary} disabled:opacity-50`}
              >
                {loading ? t("rc.resuming") : t("rc.resumeDaemon")}
              </button>
            )}
            <button
              onClick={handleStop}
              disabled={controls.stopDisabled}
              className={`px-4 py-2 text-sm rounded-md ${c.btnDanger} disabled:opacity-50`}
            >
              {loading ? t("daemon.stopping") : t("daemon.stop")}
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
          <div className="rounded-md border border-border/70 p-3">
            <div className="text-muted-foreground mb-1">{t("rc.summaryCurrentBook")}</div>
            <div className="font-medium">{sessionView.currentBook}</div>
          </div>
          <div className="rounded-md border border-border/70 p-3">
            <div className="text-muted-foreground mb-1">{t("rc.summaryCurrentChapter")}</div>
            <div className="font-medium">{sessionView.currentChapter}</div>
          </div>
          <div className="rounded-md border border-border/70 p-3">
            <div className="text-muted-foreground mb-1">{t("rc.summaryCompleted")}</div>
            <div className="font-medium">{sessionView.completedCount}</div>
          </div>
          <div className="rounded-md border border-border/70 p-3">
            <div className="text-muted-foreground mb-1">{t("rc.summaryFailed")}</div>
            <div className="font-medium">{sessionView.failedCount}</div>
          </div>
          <div className="rounded-md border border-border/70 p-3 sm:col-span-2">
            <div className="text-muted-foreground mb-1">{t("rc.summaryRecentError")}</div>
            <div className="font-medium break-all">{sessionView.recentError}</div>
          </div>
        </div>

        {bookRunViews.length > 0 && (
          <div className="rounded-md border border-border/70 p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              {t("rc.multiBookRuns")}
            </div>
            <div className="space-y-2">
              {bookRunViews.map((item) => {
                const statusText = item.status === "running"
                  ? t("rc.bookStatus.running")
                  : item.status === "success" || item.status === "done" || item.status === "completed"
                    ? t("rc.bookStatus.completed")
                    : item.status === "error" || item.status === "failed" || item.status === "fail"
                      ? t("rc.bookStatus.failed")
                      : t("rc.bookStatus.waiting");
                return (
                  <div
                    key={item.bookId}
                    className={`rounded-md border p-3 ${item.isCurrent ? "border-primary/40 bg-primary/5" : "border-border/70"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium break-all">{item.title}</div>
                      {item.isCurrent && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/15 text-primary">
                          {t("rc.currentBookBadge")}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                      <div>
                        <div className="text-muted-foreground">{t("rc.summaryCurrentChapter")}</div>
                        <div className="font-medium">{item.chapter}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">{t("rc.summaryCompleted")}</div>
                        <div className="font-medium">{item.completedCount}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">{t("book.status")}</div>
                        <div className="font-medium">{statusText}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isRunning && (
          <div className="space-y-3 border border-border/70 rounded-md p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              {t("rc.modeLabel")}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={mode === "default"}
                  onChange={() => setMode("default")}
                />
                <span>{t("rc.modeDefault")}</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={mode === "advanced"}
                  onChange={() => setMode("advanced")}
                />
                <span>{t("rc.modeAdvanced")}</span>
              </label>
            </div>
            {mode === "default" ? (
              <div className="text-xs text-muted-foreground">{t("rc.modeDefaultHint")}</div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <BookScopePicker
                  t={t}
                  scopeType={advancedForm.scopeType}
                  books={activeBooks}
                  selectedBookIds={selectedBookIds}
                  onScopeTypeChange={(scopeType) => setAdvancedForm((f) => ({ ...f, scopeType }))}
                  onSelectedBookIdsChange={(bookIds) =>
                    setAdvancedForm((f) => ({ ...f, bookIdsText: bookIds.join(",") }))}
                />
                <input
                  type="number"
                  min={1}
                  value={advancedForm.perBookChapterCap}
                  onChange={(e) => setAdvancedForm((f) => ({ ...f, perBookChapterCap: e.target.value }))}
                  placeholder={t("rc.perBookCap")}
                  className="text-xs px-2 py-2 rounded-md border border-border bg-background text-foreground"
                />
                <input
                  type="number"
                  min={1}
                  value={advancedForm.globalChapterCap}
                  onChange={(e) => setAdvancedForm((f) => ({ ...f, globalChapterCap: e.target.value }))}
                  placeholder={t("rc.globalCap")}
                  className="text-xs px-2 py-2 rounded-md border border-border bg-background text-foreground"
                />
                <input
                  type="number"
                  min={1}
                  value={advancedForm.frequencyMinutes}
                  onChange={(e) => setAdvancedForm((f) => ({ ...f, frequencyMinutes: e.target.value }))}
                  placeholder={t("rc.frequencyMinutes")}
                  className="text-xs px-2 py-2 rounded-md border border-border bg-background text-foreground"
                />
                <input
                  type="number"
                  min={1}
                  value={advancedForm.cooldownSeconds}
                  onChange={(e) => setAdvancedForm((f) => ({ ...f, cooldownSeconds: e.target.value }))}
                  placeholder={t("rc.cooldownSeconds")}
                  className="text-xs px-2 py-2 rounded-md border border-border bg-background text-foreground"
                />
                <input
                  type="number"
                  min={1}
                  value={advancedForm.concurrency}
                  onChange={(e) => setAdvancedForm((f) => ({ ...f, concurrency: e.target.value }))}
                  placeholder={t("rc.maxConcurrency")}
                  className="text-xs px-2 py-2 rounded-md border border-border bg-background text-foreground"
                />
                <PlanBudgetCard
                  t={t}
                  perBookChapterCap={advancedForm.perBookChapterCap}
                  globalChapterCap={advancedForm.globalChapterCap}
                  concurrency={advancedForm.concurrency}
                  targetBookCount={budgetTargetBookCount}
                />
              </div>
            )}
            {formError && <div className="text-xs text-destructive">{formError}</div>}
          </div>
        )}
      </div>

      {/* Event Stream */}
      <div className={`border ${c.cardStatic} rounded-lg`}>
        {/* Stream header */}
        <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
          <span className="text-sm uppercase tracking-wide text-muted-foreground font-medium">
            {t("rc.eventStream")}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStreamPaused((p) => !p)}
              className={`px-3 py-1.5 text-xs rounded-md ${streamPaused ? c.btnPrimary : c.btnSecondary}`}
            >
              {streamPaused ? t("rc.resumeScroll") : t("rc.pauseScroll")}
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="px-5 py-3 border-b border-border flex flex-wrap items-center gap-3">
          {/* Level filter */}
          <select
            value={filter.level}
            onChange={(e) => setFilter((f) => ({ ...f, level: e.target.value }))}
            className={`text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground ${c.input ?? ""}`}
            aria-label={t("rc.filterLevel")}
          >
            <option value="">{t("rc.filterLevel")}: {t("rc.filterAll")}</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
          </select>

          {/* Source filter */}
          <input
            type="text"
            value={filter.source}
            onChange={(e) => setFilter((f) => ({ ...f, source: e.target.value }))}
            placeholder={`${t("rc.filterSource")}…`}
            className="text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground w-28"
          />

          {/* Book ID filter */}
          <input
            type="text"
            value={filter.bookId}
            onChange={(e) => setFilter((f) => ({ ...f, bookId: e.target.value }))}
            placeholder={`${t("rc.filterBook")}…`}
            className="text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground w-32"
          />

          {/* Clear button */}
          {hasFilter && (
            <button
              onClick={() => setFilter({ level: "", source: "", bookId: "" })}
              className={`text-xs px-3 py-1.5 rounded-md ${c.btnSecondary}`}
            >
              {t("rc.clear")}
            </button>
          )}
        </div>

        {/* Stream body */}
        <div ref={streamRef} className="p-4 max-h-[520px] overflow-y-auto">
          {visible.length > 0 ? (
            <div className="space-y-0.5 font-mono text-xs">
              {visible.map((msg, i) => (
                <EventRow key={i} msg={msg} />
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground text-sm italic py-12 text-center">
              {t(emptyHintKey)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
