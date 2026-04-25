import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import { shouldRefetchBookCollections, shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import type { TFunction } from "../hooks/use-i18n";
import {
  ASSISTANT_ACTIVE_CONVERSATION_CHANGED_EVENT,
  ASSISTANT_CONVERSATIONS_UPDATED_EVENT,
  createAndActivateAssistantConversation,
  deleteAssistantConversation,
  dispatchAssistantCreateConversation,
  dispatchAssistantSelectConversation,
  getActiveAssistantConversationId,
  listAssistantConversationSummaries,
  renameAssistantConversation,
  type AssistantConversationSummary,
} from "../lib/assistant-conversations";
import {
  BookOpen,
  Network,
  Plus,
  Sparkles,
  Settings,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
}

interface Nav {
  toDashboard: () => void;
  toAssistant: () => void;
  toBook: (id: string) => void;
  toBookCreate: () => void;
  toConfig: () => void;
  toRuntimeCenter: () => void;
  toCollab: () => void;
}

export interface SystemSidebarItem {
  key: "assistant" | "runtime-center";
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
  badgeColor?: string;
}

export function buildSystemSidebarItems({
  nav,
  activePage,
  daemonRunning,
  t,
}: {
  nav: Pick<Nav, "toAssistant" | "toRuntimeCenter">;
  activePage: string;
  daemonRunning: boolean;
  t: TFunction;
}): ReadonlyArray<SystemSidebarItem> {
  return [
    {
      key: "assistant",
      label: t("nav.assistant"),
      active: activePage === "assistant",
      onClick: nav.toAssistant,
    },
    {
      key: "runtime-center",
      label: t("nav.runtimeCenter"),
      active: activePage === "runtime-center",
      onClick: nav.toRuntimeCenter,
      badge: daemonRunning ? t("nav.running") : undefined,
      badgeColor: daemonRunning ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground",
    },
  ];
}

export function Sidebar({
  nav,
  activePage,
  sse,
  t,
}: {
  nav: Nav;
  activePage: string;
  sse: { messages: ReadonlyArray<SSEMessage> };
  t: TFunction;
}) {
  const { refetch: refetchBooks } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { data: daemon, refetch: refetchDaemon } = useApi<{ running: boolean }>("/daemon");
  const [recentConversations, setRecentConversations] = useState<ReadonlyArray<AssistantConversationSummary>>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const refreshConversations = useMemo(
    () => () => {
      setRecentConversations(listAssistantConversationSummaries().slice(0, 8));
      setActiveConversationId(getActiveAssistantConversationId());
    },
    [],
  );

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) {
      refetchBooks();
    }
    if (shouldRefetchDaemonStatus(recent)) {
      refetchDaemon();
    }
  }, [refetchBooks, refetchDaemon, sse.messages]);

  useEffect(() => {
    refreshConversations();
    const handleUpdated = () => refreshConversations();
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key.includes("inkos.assistant")) {
        refreshConversations();
      }
    };
    window.addEventListener(ASSISTANT_CONVERSATIONS_UPDATED_EVENT, handleUpdated);
    window.addEventListener(ASSISTANT_ACTIVE_CONVERSATION_CHANGED_EVENT, handleUpdated);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(ASSISTANT_CONVERSATIONS_UPDATED_EVENT, handleUpdated);
      window.removeEventListener(ASSISTANT_ACTIVE_CONVERSATION_CHANGED_EVENT, handleUpdated);
      window.removeEventListener("storage", handleStorage);
    };
  }, [refreshConversations]);

  useEffect(() => {
    const handleWindowClick = () => setMenuConversationId(null);
    window.addEventListener("click", handleWindowClick);
    return () => window.removeEventListener("click", handleWindowClick);
  }, []);

  const beginRenameConversation = (conversation: AssistantConversationSummary) => {
    setMenuConversationId(null);
    setEditingConversationId(conversation.id);
    setRenameDraft(conversation.title);
  };

  const commitRenameConversation = (conversationId: string) => {
    renameAssistantConversation(conversationId, renameDraft);
    refreshConversations();
    setEditingConversationId(null);
    setRenameDraft("");
  };

  const cancelRenameConversation = () => {
    setEditingConversationId(null);
    setRenameDraft("");
  };

  return (
    <aside
      data-sidebar-shell="app"
      className="w-[248px] shrink-0 border-r border-border/60 bg-card/60 text-foreground flex flex-col h-full overflow-hidden backdrop-blur-xl"
    >
      <div className="px-4 pt-5 pb-4">
        <button
          onClick={() => {
            dispatchAssistantCreateConversation();
            nav.toAssistant();
          }}
          className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-all hover:bg-secondary/70"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Sparkles size={16} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-tight">NovelOS</div>
          </div>
        </button>
      </div>

      <div className="px-4 space-y-3">
        <button
          onClick={() => {
            dispatchAssistantCreateConversation();
            nav.toAssistant();
          }}
          className="flex h-11 w-full items-center gap-2 rounded-2xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground transition-transform hover:scale-[1.01]"
        >
          <Plus size={16} />
          新建聊天
        </button>
      </div>

      <div className="px-4 pt-5 space-y-1">
        <SidebarPrimaryItem
          label="作品"
          icon={<BookOpen size={16} />}
          active={activePage === "dashboard"}
          onClick={nav.toDashboard}
        />
        <SidebarPrimaryItem
          label="故事地图"
          icon={<Network size={16} />}
          active={activePage === "collaboration"}
          onClick={nav.toCollab}
        />
      </div>

      <div className="mt-6 flex-1 overflow-y-auto px-4 pb-4">
        <div className="mb-6">
          <div className="mb-3 px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            最近聊天
          </div>
          <div className="space-y-2">
            {recentConversations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
                还没有最近聊天
              </div>
            ) : (
              recentConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`group relative rounded-2xl border transition-colors ${
                    activePage === "assistant" && activeConversationId === conversation.id
                      ? "border-primary/40 bg-primary/10"
                      : "border-transparent bg-secondary/30 hover:border-border/70 hover:bg-secondary/60"
                  }`}
                >
                  {editingConversationId === conversation.id ? (
                    <div className="space-y-2 px-3 py-3" onClick={(event) => event.stopPropagation()}>
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitRenameConversation(conversation.id);
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRenameConversation();
                          }
                        }}
                        className="h-9 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none ring-0 transition focus:border-primary"
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
                          onClick={cancelRenameConversation}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
                          onClick={() => commitRenameConversation(conversation.id)}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        dispatchAssistantSelectConversation(conversation.id);
                        nav.toAssistant();
                      }}
                      className="w-full rounded-2xl px-3 py-3 pr-10 text-left"
                    >
                      <div className="truncate text-sm font-medium text-foreground">{conversation.title}</div>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuConversationId((current) => current === conversation.id ? null : conversation.id);
                    }}
                    className={`absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition ${
                      menuConversationId === conversation.id
                        ? "bg-background/80 text-foreground"
                        : "opacity-0 group-hover:opacity-100 hover:bg-background/80 hover:text-foreground"
                    }`}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                  {menuConversationId === conversation.id && (
                    <div
                      className="absolute right-2 top-10 z-20 w-36 rounded-xl border border-border bg-popover p-1 shadow-xl"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-secondary"
                        onClick={() => beginRenameConversation(conversation)}
                      >
                        <Pencil size={14} />
                        重命名
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-500 hover:bg-red-500/10"
                        onClick={() => {
                          const confirmed = window.confirm(`删除聊天“${conversation.title}”？`);
                          if (confirmed) {
                            const nextId = deleteAssistantConversation(conversation.id);
                            if (nextId) {
                              dispatchAssistantSelectConversation(nextId);
                              nav.toAssistant();
                            } else {
                              const created = createAndActivateAssistantConversation();
                              dispatchAssistantSelectConversation(created.id);
                              nav.toAssistant();
                            }
                            refreshConversations();
                          }
                          setMenuConversationId(null);
                        }}
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-border/60 px-4 py-4">
        <button
          onClick={nav.toConfig}
          className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
        >
          <Settings size={15} />
          设置
        </button>
      </div>
    </aside>
  );
}

function SidebarPrimaryItem({
  label,
  icon,
  active,
  onClick,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-11 w-full items-center gap-3 rounded-2xl px-4 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
