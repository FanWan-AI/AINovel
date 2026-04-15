import { useMemo, useState } from "react";
import { BotMessageSquare, Loader2, Send, Sparkles } from "lucide-react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
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
}

export interface AssistantQuickAction {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

const MOCK_ASSISTANT_RESPONSE_DELAY_MS = 450;

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

export function AssistantView({ nav, theme: _theme, t: _t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const [state, setState] = useState<AssistantComposerState>(() => createAssistantInitialState());

  const quickActions = useMemo(() => ASSISTANT_QUICK_ACTIONS, []);

  const sendPrompt = (rawPrompt: string) => {
    const normalizedPrompt = rawPrompt.trim();
    if (!normalizedPrompt || state.loading) {
      return;
    }

    setState((prev) => submitAssistantInput(prev, normalizedPrompt));

    setTimeout(() => {
      setState((prev) => completeAssistantResponse(prev, normalizedPrompt));
    }, MOCK_ASSISTANT_RESPONSE_DELAY_MS);
  };

  const showLoading = state.loading && state.messages.length === 0;

  return (
    <div className="h-full min-h-[640px] flex flex-col gap-4">
      <section className="shrink-0 rounded-xl border border-border/70 bg-card/50 px-4 py-3" data-testid="assistant-context-bar">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles size={16} className="text-primary" />
            <span className="font-medium">AI 助手</span>
            <span className="text-muted-foreground">· 主工作区</span>
          </div>
          <button onClick={nav.toDashboard} className="text-xs text-muted-foreground hover:text-primary transition-colors">
            返回首页
          </button>
        </div>
      </section>

      <section className="flex-1 min-h-[360px] overflow-y-auto rounded-xl border border-border/70 bg-background/70 p-4" data-testid="assistant-message-list">
        {showLoading ? <LoadingConversation /> : state.messages.length === 0 ? <EmptyConversation /> : <MessageList messages={state.messages} />}
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
            placeholder="输入你的问题或需求…"
            className="flex-1 h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            data-testid="assistant-input"
          />
          <button
            onClick={() => sendPrompt(state.input)}
            disabled={state.loading}
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
