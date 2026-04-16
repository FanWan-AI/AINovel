import { useMemo, useState } from "react";
import { BotMessageSquare, Loader2, Send, Sparkles } from "lucide-react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useApi } from "../hooks/use-api";
import { TaskPlanCard } from "../components/assistant/TaskPlanCard";
import { cn } from "../lib/utils";

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

const MOCK_ASSISTANT_RESPONSE_DELAY_MS = 450;
const BOOK_STATUS_ACTIVE = "active";
const WRITE_NEXT_ACTION_PATTERN = /写下一章|write[-\s]?next/u;
const AUDIT_ACTION_PATTERN = /审计|audit/iu;
const AUDIT_CHAPTER_ZH_PATTERN = /第\s*(\d+)\s*章/u;
const AUDIT_CHAPTER_EN_PATTERN = /chapter\s*(\d+)/iu;
const ACTION_LABEL_KEY_BY_TYPE: Record<AssistantBookActionType, "assistant.actionWriteNext" | "assistant.actionAudit"> = {
  "write-next": "assistant.actionWriteNext",
  audit: "assistant.actionAudit",
};
const VALID_ASSISTANT_TASK_PLAN_TRANSITIONS: Record<AssistantTaskPlanStatus, ReadonlyArray<AssistantTaskPlanStatus>> = {
  draft: ["awaiting-confirm", "cancelled"],
  "awaiting-confirm": ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
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
  };
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
  activeBooks: ReadonlyArray<BookSummary>,
  t: TFunction,
): string[] {
  const titleById = new Map(activeBooks.map((book) => [book.id, book.title] as const));
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
  };
}

export function completeAssistantTaskPlanExecution(
  state: AssistantComposerState,
  status: "succeeded" | "failed",
  now = Date.now(),
): AssistantComposerState {
  if (!state.taskPlan || state.taskPlan.status !== "running") {
    return {
      ...state,
      loading: false,
    };
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
  const selectedBookTitles = useMemo(
    () => resolveAssistantBookTitlesByIds(selectedScopeBookIds, activeBooks, t),
    [selectedScopeBookIds, activeBooks, t],
  );
  const taskPlanTargetBookTitles = useMemo(
    () => (state.taskPlan ? resolveAssistantBookTitlesByIds(state.taskPlan.targetBookIds, activeBooks, t) : []),
    [state.taskPlan, activeBooks, t],
  );

  const sendPrompt = (rawPrompt: string) => {
    const normalizedPrompt = rawPrompt.trim();
    if (!normalizedPrompt || state.loading || state.taskPlan?.status === "awaiting-confirm" || state.taskPlan?.status === "running") {
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

  const handleConfirmAction = () => {
    if (!state.taskPlan || state.taskPlan.status !== "awaiting-confirm") {
      return;
    }
    setState((prev) => confirmAssistantPendingAction(prev));
    setTimeout(() => {
      setState((prev) => completeAssistantTaskPlanExecution(prev, "succeeded"));
    }, MOCK_ASSISTANT_RESPONSE_DELAY_MS);
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
