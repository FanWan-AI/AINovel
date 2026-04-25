import { useState, useEffect, useMemo } from "react";
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
import { StyleManager } from "./pages/StyleManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { StoryGraphView } from "./pages/StoryGraphView";
import { AssistantView } from "./pages/AssistantView";
import { ObservabilityDashboard } from "./pages/ObservabilityDashboard";
import {
  SettingsView,
  type SettingsTab,
  DEFAULT_SETTINGS_TAB,
  normalizeSettingsTab,
} from "./pages/SettingsView";
import { LanguageSelector } from "./pages/LanguageSelector";
import { useSSE } from "./hooks/use-sse";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { postApi, useApi } from "./hooks/use-api";
import { useCreateFlow } from "./hooks/use-create-flow";
import { Sun, Moon, Activity } from "lucide-react";
import type { SSEMessage } from "./hooks/use-sse";

export type Route =
  | { page: "dashboard" }
  | { page: "collaboration" }
  | { page: "assistant"; prompt?: string; promptKey?: string }
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
  | { page: "observability" }
  | { page: "settings"; tab?: SettingsTab }
  | { page: "genres" }
  | { page: "style" }
  | { page: "import" }
  | { page: "radar" }
  | { page: "doctor" };

export type LegacyRuntimePage = "daemon" | "logs";
export type LegacySettingsPage = "config" | "genres";

export function routeToRuntimeCenterFromLegacy(page: LegacyRuntimePage): Route {
  switch (page) {
    case "daemon":
    case "logs":
      return { page: "runtime-center" };
  }
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

export function parseSettingsTabFromQuery(search: string): SettingsTab | undefined {
  const rawTab = new URLSearchParams(search).get("tab");
  if (rawTab === null) {
    return undefined;
  }
  return normalizeSettingsTab(rawTab);
}

export function resolveInitialRouteFromSearch(search: string): Route {
  const tab = parseSettingsTabFromQuery(search);
  if (tab) {
    return { page: "settings", tab };
  }
  return { page: "assistant" };
}

export function routeToAssistant(prompt?: string, now = Date.now()): Route {
  const normalizedPrompt = prompt?.trim() ?? "";
  if (!normalizedPrompt) {
    return { page: "assistant" };
  }
  return { page: "assistant", prompt: normalizedPrompt, promptKey: String(now) };
}

function replaceSearchParams(params: URLSearchParams) {
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
}

export function deriveActiveBookId(route: Route): string | undefined {
  return route.page === "book" || route.page === "chapter" || route.page === "truth" || route.page === "analytics"
    ? route.bookId
    : undefined;
}

export function mapRouteToActivePage(route: Route, activeBookId?: string): string {
  if (activeBookId) {
    return `book:${activeBookId}`;
  }

  if (route.page === "settings" && route.tab === "provider") {
    return "config";
  }

  if (route.page === "settings" && route.tab === "genre") {
    return "genres";
  }

  if (route.page === "observability") {
    return "runtime-center";
  }

  return route.page;
}

interface HeaderQuickAction {
  key: "assistant" | "settings";
  active: boolean;
  onClick: () => void;
}

export function buildHeaderQuickActions({
  currentRoute,
  nav,
}: {
  currentRoute: Route;
  nav: { toAssistant: () => void; toSettings: () => void };
}): ReadonlyArray<HeaderQuickAction> {
  return [
    {
      key: "assistant",
      active: currentRoute.page === "assistant",
      onClick: nav.toAssistant,
    },
    {
      key: "settings",
      active: currentRoute.page === "settings",
      onClick: nav.toSettings,
    },
  ];
}

export function App() {
  const [rawRoute, setRoute] = useState<Route>(() => resolveInitialRouteFromSearch(window.location.search));
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const { data: project, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const createFlow = useCreateFlow();

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
    toCollab: () => setRoute({ page: "collaboration" }),
    toAssistant: () => setRoute(routeToAssistant()),
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
    toObservability: () => setRoute({ page: "observability" }),
    toSettings: () => setRoute({ page: "settings", tab: DEFAULT_SETTINGS_TAB }),
    toGenres: () => setRoute(routeToSettingsFromLegacy("genres")),
    toStyle: () => setRoute({ page: "style" }),
    toImport: () => setRoute({ page: "import" }),
    toRadar: () => setRoute({ page: "radar" }),
    toDoctor: () => setRoute({ page: "doctor" }),
  }), [setRoute]);

  const currentRoute = resolveLegacyRoute(rawRoute);
  const activeBookId = deriveActiveBookId(currentRoute);
  const activePage = mapRouteToActivePage(currentRoute, activeBookId);
  const contentContainerClass =
    currentRoute.page === "truth" || currentRoute.page === "observability"
      ? "max-w-[1480px] mx-auto px-4 py-8 md:px-6 lg:px-8 lg:py-10 fade-in"
      : currentRoute.page === "assistant" || currentRoute.page === "dashboard" || currentRoute.page === "collaboration"
        ? "max-w-[1560px] mx-auto px-0 py-0 fade-in h-full"
        : currentRoute.page === "chapter"
          ? "max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16"
        : "max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in";
  const showCompactShell = currentRoute.page === "assistant" || currentRoute.page === "dashboard" || currentRoute.page === "collaboration";

  useEffect(() => {
    if (currentRoute.page === "settings") {
      const nextTab = normalizeSettingsTab(currentRoute.tab);
      const params = new URLSearchParams(window.location.search);
      const currentTab = params.get("tab");
      if (currentTab === nextTab) {
        return;
      }
      params.set("tab", nextTab);
      replaceSearchParams(params);
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (!params.has("tab")) {
      return;
    }

    params.delete("tab");
    replaceSearchParams(params);
  }, [currentRoute]);

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
      <div className="relative flex-1 flex flex-col min-w-0 bg-background/30 backdrop-blur-sm">
        {/* Header Strip */}
        <header
          className={`shrink-0 flex items-center justify-between border-b border-border/40 ${
            showCompactShell ? "h-20 px-8 py-5" : "h-14 px-8"
          }`}
        >
          <div className="flex items-center gap-2">
            {!showCompactShell && (
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                NovaScribe Studio
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className={`flex items-center justify-center rounded-lg bg-secondary text-muted-foreground transition-all shadow-sm hover:bg-primary/10 hover:text-primary ${
                showCompactShell ? "h-10 w-10" : "h-8 w-8"
              }`}
              title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {isDark ? <Sun size={showCompactShell ? 17 : 16} /> : <Moon size={showCompactShell ? 17 : 16} />}
            </button>
            <button
              onClick={nav.toRuntimeCenter}
              className={`flex items-center justify-center rounded-lg transition-all shadow-sm ${
                showCompactShell ? "h-10 w-10" : "h-8 w-8"
              } ${
                currentRoute.page === "runtime-center"
                  ? "bg-primary text-primary-foreground shadow-primary/20"
                  : "bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10"
              }`}
              title="Open Runtime Center"
            >
              <Activity size={showCompactShell ? 17 : 16} />
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="min-h-0 flex-1 overflow-y-auto scroll-smooth">
          <div className={contentContainerClass}>
            {currentRoute.page === "dashboard" && <Dashboard nav={nav} sse={sse} theme={theme} t={t} />}
            {currentRoute.page === "collaboration" && <StoryGraphView nav={nav} />}
            {currentRoute.page === "assistant" && (
              <AssistantView
                nav={nav}
                theme={theme}
                t={t}
                initialPrompt={currentRoute.prompt}
                initialPromptKey={currentRoute.promptKey}
                sse={sse}
              />
            )}
            {currentRoute.page === "book" && <BookDetail bookId={currentRoute.bookId} nav={nav} theme={theme} t={t} sse={sse} />}
            {currentRoute.page === "book-create" && <BookCreate nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "book-create-entry" && <BookCreateEntry nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "book-create-simple" && <BookCreateSimple nav={nav} theme={theme} t={t} flow={createFlow} />}
            {currentRoute.page === "book-create-review" && <BookCreateReview nav={nav} theme={theme} t={t} flow={createFlow} />}
            {currentRoute.page === "book-create-pro" && <BookCreatePro nav={nav} theme={theme} t={t} flow={createFlow} />}
            {currentRoute.page === "chapter" && <ChapterReader bookId={currentRoute.bookId} chapterNumber={currentRoute.chapterNumber} nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "analytics" && <Analytics bookId={currentRoute.bookId} nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "settings" && (
              <SettingsView
                nav={nav}
                theme={theme}
                t={t}
                tab={currentRoute.tab}
                onTabChange={(nextTab) => setRoute({ page: "settings", tab: nextTab })}
              />
            )}
            {currentRoute.page === "truth" && <TruthFiles bookId={currentRoute.bookId} nav={nav} theme={theme} t={t} />}
            {currentRoute.page === "runtime-center" && <RuntimeEventFeedOnly nav={nav} sse={sse} />}
            {currentRoute.page === "observability" && <ObservabilityDashboard nav={nav} />}
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
        onSubmitPrompt={(prompt) => {
          setRoute(routeToAssistant(prompt));
          setChatOpen(false);
        }}
        t={t}
      />
    </div>
  );
}

function RuntimeEventFeedOnly({
  nav,
  sse,
}: {
  nav: { toDashboard: () => void };
  sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}) {
  const visibleMessages = sse.messages
    .filter((msg) => msg.event !== "ping")
    .slice(-120);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className="hover:text-foreground">
          首页
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">运行中心</span>
      </div>

      <h1 className="font-serif text-3xl">运行中心</h1>

      <section className="rounded-2xl border border-border/70 bg-card/50 shadow-[0_24px_64px_-36px_rgba(0,0,0,0.18)] backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <div className="text-sm font-medium uppercase tracking-wide text-muted-foreground">实时事件流</div>
          <div className={`text-xs ${sse.connected ? "text-emerald-500" : "text-amber-500"}`}>
            {sse.connected ? "实时连接正常" : "实时连接重连中"}
          </div>
        </div>
        <div className="max-h-[68vh] overflow-y-auto p-5">
          {visibleMessages.length > 0 ? (
            <div className="space-y-2 font-mono text-xs">
              {visibleMessages.map((msg, index) => {
                const data = msg.data as Record<string, unknown> | null;
                const text = typeof data?.message === "string"
                  ? data.message
                  : typeof data?.bookId === "string"
                    ? data.bookId
                    : JSON.stringify(data);
                return (
                  <div key={`${msg.timestamp}-${msg.event}-${index}`} className="flex gap-3 leading-relaxed">
                    <span className="w-20 shrink-0 text-muted-foreground/60 tabular-nums">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="w-28 shrink-0 text-primary/70">{msg.event}</span>
                    <span className="break-all text-foreground/80">{text}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-muted-foreground">暂时还没有实时事件。</div>
          )}
        </div>
      </section>
    </div>
  );
}
