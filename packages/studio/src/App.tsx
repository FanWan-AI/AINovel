import { useState, useEffect, useMemo, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatBar";
import { Dashboard } from "./pages/Dashboard";
import { BookDetail } from "./pages/BookDetail";
import { BookCreate } from "./pages/BookCreate";
import { BookCreateEntry } from "./pages/BookCreateEntry";
import { BookCreateSimple } from "./pages/BookCreateSimple";
import { BookCreateReview } from "./pages/BookCreateReview";
import { BookCreatePro } from "./pages/BookCreatePro";
import { ChapterReader } from "./pages/ChapterReader";
import { Analytics } from "./pages/Analytics";
import { TruthFiles } from "./pages/TruthFiles";
import { RuntimeCenter } from "./pages/RuntimeCenter";
import { StyleManager } from "./pages/StyleManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { AssistantView } from "./pages/AssistantView";
import { SettingsView, type SettingsTab } from "./pages/SettingsView";
import { LanguageSelector } from "./pages/LanguageSelector";
import { useSSE } from "./hooks/use-sse";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { postApi, useApi } from "./hooks/use-api";
import { useCreateFlow } from "./hooks/use-create-flow";
import { Sun, Moon, Bell, MessageSquare } from "lucide-react";
import type { SSEMessage } from "./hooks/use-sse";

export type Route =
  | { page: "dashboard" }
  | { page: "assistant" }
  | { page: "book"; bookId: string }
  | { page: "book-create" }
  | { page: "book-create-entry" }
  | { page: "book-create-simple" }
  | { page: "book-create-review" }
  | { page: "book-create-pro" }
  | { page: "chapter"; bookId: string; chapterNumber: number }
  | { page: "analytics"; bookId: string }
  | { page: "config" }
  | { page: "truth"; bookId: string }
  | { page: "daemon" }
  | { page: "logs" }
  | { page: "runtime-center" }
  | { page: "settings"; tab?: SettingsTab }
  | { page: "genres" }
  | { page: "style" }
  | { page: "import" }
  | { page: "radar" }
  | { page: "doctor" };

export type LegacyRuntimePage = "daemon" | "logs";
export type LegacySettingsPage = "config" | "genres";

export function routeToRuntimeCenterFromLegacy(page: LegacyRuntimePage): Route {
  void page;
  return { page: "runtime-center" };
}

export function routeToSettingsFromLegacy(page: LegacySettingsPage): Route {
  return { page: "settings", tab: page === "config" ? "provider" : "genre" };
}

export function resolveLegacyRoute(route: Route): Route {
  if (route.page === "config" || route.page === "genres") {
    return routeToSettingsFromLegacy(route.page);
  }

  if (route.page === "daemon" || route.page === "logs") {
    return routeToRuntimeCenterFromLegacy(route.page);
  }

  return route;
}

export function deriveActiveBookId(route: Route): string | undefined {
  return route.page === "book" || route.page === "chapter" || route.page === "truth" || route.page === "analytics"
    ? route.bookId
    : undefined;
}

type AppNotificationLevel = "info" | "success" | "error";

interface AppNotification {
  readonly id: string;
  readonly timestamp: number;
  readonly level: AppNotificationLevel;
  readonly title: string;
  readonly detail: string;
}

function toNotification(msg: SSEMessage, index: number): AppNotification | null {
  const data = msg.data as Record<string, unknown> | null;
  const bookId = typeof data?.bookId === "string" ? data.bookId : "";
  const bookPrefix = bookId ? `【${bookId}】` : "";

  const byEvent: Record<string, { level: AppNotificationLevel; title: string }> = {
    "book:creating": { level: "info", title: "书籍创建中" },
    "book:created": { level: "success", title: "书籍创建完成" },
    "book:error": { level: "error", title: "书籍创建失败" },
    "write:start": { level: "info", title: "章节写作已启动" },
    "write:complete": { level: "success", title: "章节写作完成" },
    "write:error": { level: "error", title: "章节写作失败" },
    "draft:start": { level: "info", title: "草稿任务已启动" },
    "draft:complete": { level: "success", title: "草稿任务完成" },
    "draft:error": { level: "error", title: "草稿任务失败" },
    "daemon:started": { level: "success", title: "守护进程已启动" },
    "daemon:stopped": { level: "info", title: "守护进程已停止" },
    "daemon:error": { level: "error", title: "守护进程错误" },
    "daemon:chapter": { level: "info", title: "守护进程章节进度" },
  };

  const mapped = byEvent[msg.event];
  if (!mapped) {
    return null;
  }

  const fallbackDetail = typeof data?.message === "string" ? data.message : msg.event;
  const chapter = typeof data?.chapter === "number"
    ? `第 ${data.chapter} 章`
    : typeof data?.chapterNumber === "number"
      ? `第 ${data.chapterNumber} 章`
      : "";
  const errorText = typeof data?.error === "string" ? data.error : "";
  const status = typeof data?.status === "string" ? data.status : "";
  const detail = [bookPrefix, chapter, errorText || status || fallbackDetail].filter(Boolean).join(" ");

  return {
    id: `${msg.timestamp}-${msg.event}-${index}`,
    timestamp: msg.timestamp,
    level: mapped.level,
    title: mapped.title,
    detail,
  };
}

export function App() {
  const [route, setRoute] = useState<Route>({ page: "dashboard" });
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const { data: project, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationReadAt, setNotificationReadAt] = useState(Date.now());
  const createFlow = useCreateFlow();
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);

  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (project) {
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      setReady(true);
    }
  }, [project]);

  const nav = useMemo(() => ({
    toDashboard: () => setRoute({ page: "dashboard" }),
    toAssistant: () => setRoute({ page: "assistant" }),
    toBook: (bookId: string) => setRoute({ page: "book", bookId }),
    toBookCreate: () => setRoute({ page: "book-create-entry" }),
    toBookCreateEntry: () => setRoute({ page: "book-create-entry" }),
    toBookCreateSimple: () => setRoute({ page: "book-create-simple" }),
    toBookCreateReview: () => setRoute({ page: "book-create-review" }),
    toBookCreatePro: () => setRoute({ page: "book-create-pro" }),
    toChapter: (bookId: string, chapterNumber: number) =>
      setRoute({ page: "chapter", bookId, chapterNumber }),
    toAnalytics: (bookId: string) => setRoute({ page: "analytics", bookId }),
    toConfig: () => setRoute(routeToSettingsFromLegacy("config")),
    toTruth: (bookId: string) => setRoute({ page: "truth", bookId }),
    toDaemon: () => setRoute(routeToRuntimeCenterFromLegacy("daemon")),
    toLogs: () => setRoute(routeToRuntimeCenterFromLegacy("logs")),
    toRuntimeCenter: () => setRoute({ page: "runtime-center" }),
    toGenres: () => setRoute(routeToSettingsFromLegacy("genres")),
    toStyle: () => setRoute({ page: "style" }),
    toImport: () => setRoute({ page: "import" }),
    toRadar: () => setRoute({ page: "radar" }),
    toDoctor: () => setRoute({ page: "doctor" }),
  }), [setRoute]);

  const currentRoute = resolveLegacyRoute(route);
  const activeBookId = deriveActiveBookId(currentRoute);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : currentRoute.page === "settings" && currentRoute.tab === "provider"
        ? "config"
        : currentRoute.page === "settings" && currentRoute.tab === "genre"
          ? "genres"
          : currentRoute.page;
  const contentContainerClass =
    currentRoute.page === "truth"
      ? "max-w-[1400px] mx-auto px-4 py-8 md:px-6 lg:px-8 lg:py-10 fade-in"
      : "max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in";
  const notifications = useMemo(
    () => sse.messages
      .slice(-80)
      .map((msg, index) => toNotification(msg, index))
      .filter((item): item is AppNotification => item !== null)
      .reverse(),
    [sse.messages],
  );
  const unreadNotifications = notifications.filter((item) => item.timestamp > notificationReadAt).length;

  useEffect(() => {
    if (!notificationOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (notificationPanelRef.current && !notificationPanelRef.current.contains(target)) {
        setNotificationOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [notificationOpen]);

  useEffect(() => {
    if (notificationOpen) {
      setNotificationReadAt(Date.now());
    }
  }, [notificationOpen]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <LanguageSelector
        onSelect={async (lang) => {
          await postApi("/project/language", { language: lang });
          setShowLanguageSelector(false);
          refetchProject();
        }}
      />
    );
  }

  return (
    <div className="h-screen bg-background text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar */}
      <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} />

      {/* Center Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/30 backdrop-blur-sm">
        {/* Header Strip */}
        <header className="h-14 shrink-0 flex items-center justify-between px-8 border-b border-border/40">
          <div className="flex items-center gap-2">
             <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-bold">
               NovaScribe Studio
             </span>
          </div>

          <div className="flex items-center gap-3">

            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
              title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            <div className="relative" ref={notificationPanelRef}>
              <button
                onClick={() => setNotificationOpen((prev) => !prev)}
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all relative ${notificationOpen
                  ? "bg-primary/10 text-primary"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
                title="通知中心"
                aria-label="打开通知中心"
              >
                <Bell size={16} />
                {(unreadNotifications > 0 || !sse.connected) && (
                  <span className={`absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full border text-[10px] leading-4 text-center font-semibold ${sse.connected
                    ? "bg-primary text-primary-foreground border-background"
                    : "bg-destructive text-destructive-foreground border-background"
                  }`}>
                    {unreadNotifications > 0 ? Math.min(unreadNotifications, 99) : "!"}
                  </span>
                )}
              </button>

              {notificationOpen && (
                <div className="absolute right-0 top-10 w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card shadow-xl z-50">
                  <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold">通知中心</div>
                      <div className="text-xs text-muted-foreground">
                        {sse.connected ? "实时连接已建立" : "实时连接中断，正在重连"}
                      </div>
                    </div>
                    <button
                      className="text-xs px-2 py-1 rounded-md bg-secondary text-muted-foreground hover:text-foreground"
                      onClick={() => setNotificationReadAt(Date.now())}
                    >
                      全部标记已读
                    </button>
                  </div>
                  <div className="max-h-[360px] overflow-y-auto p-2">
                    {notifications.length > 0 ? notifications.map((item) => (
                      <div
                        key={item.id}
                        className={`rounded-lg px-3 py-2.5 mb-1 border ${item.level === "error"
                          ? "border-destructive/30 bg-destructive/5"
                          : item.level === "success"
                            ? "border-emerald-500/20 bg-emerald-500/5"
                            : "border-border/60 bg-background/40"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium">{item.title}</span>
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {new Date(item.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 break-all">{item.detail}</div>
                      </div>
                    )) : (
                      <div className="text-sm text-muted-foreground text-center py-8">暂无通知</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Chat Panel Toggle */}
            <button
              onClick={nav.toAssistant}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all shadow-sm ${
                currentRoute.page === "assistant"
                  ? "bg-primary text-primary-foreground shadow-primary/20"
                  : "bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10"
              }`}
              title="Toggle AI Assistant"
            >
              <MessageSquare size={16} />
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto scroll-smooth">
          <div className={contentContainerClass}>
            {currentRoute.page === "dashboard" && <Dashboard nav={nav} sse={sse} theme={theme} t={t} />}
            {currentRoute.page === "assistant" && <AssistantView nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "book" && <BookDetail bookId={currentRoute.bookId} nav={nav} theme={theme} t={t} sse={sse} />}
            {currentRoute.page === "book-create" && <BookCreate nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "book-create-entry" && <BookCreateEntry nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "book-create-simple" && <BookCreateSimple nav={nav} theme={theme} t={t} flow={createFlow} />}
            {currentRoute.page === "book-create-review" && <BookCreateReview nav={nav} theme={theme} t={t} flow={createFlow} />}
            {currentRoute.page === "book-create-pro" && <BookCreatePro nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "chapter" && <ChapterReader bookId={currentRoute.bookId} chapterNumber={currentRoute.chapterNumber} nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "analytics" && <Analytics bookId={currentRoute.bookId} nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "settings" && <SettingsView nav={nav} theme={theme} t={t} tab={currentRoute.tab} />}
            {currentRoute.page === "truth" && <TruthFiles bookId={currentRoute.bookId} nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "runtime-center" && <RuntimeCenter nav={nav} theme={theme} t={t} sse={sse} />}
            {currentRoute.page === "style" && <StyleManager nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "import" && <ImportManager nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "radar" && <RadarView nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "doctor" && <DoctorView nav={nav} theme={theme} t={t} />}
          </div>
        </main>
      </div>

      {/* Right Chat Panel */}
      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        t={t}
        sse={sse}
        activeBookId={activeBookId}
      />
    </div>
  );
}
