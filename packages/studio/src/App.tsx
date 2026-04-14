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
import { ConfigView } from "./pages/ConfigView";
import { TruthFiles } from "./pages/TruthFiles";
import { DaemonControl } from "./pages/DaemonControl";
import { LogViewer } from "./pages/LogViewer";
import { RuntimeCenter } from "./pages/RuntimeCenter";
import { GenreManager } from "./pages/GenreManager";
import { StyleManager } from "./pages/StyleManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { LanguageSelector } from "./pages/LanguageSelector";
import { useSSE } from "./hooks/use-sse";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { postApi, useApi } from "./hooks/use-api";
import { useCreateFlow } from "./hooks/use-create-flow";
import { Sun, Moon, Bell, MessageSquare } from "lucide-react";

export type Route =
  | { page: "dashboard" }
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
  | { page: "genres" }
  | { page: "style" }
  | { page: "import" }
  | { page: "radar" }
  | { page: "doctor" };

export type LegacyRuntimePage = "daemon" | "logs";

export function routeToRuntimeCenterFromLegacy(page: LegacyRuntimePage): Route {
  void page;
  return { page: "runtime-center" };
}

export function deriveActiveBookId(route: Route): string | undefined {
  return route.page === "book" || route.page === "chapter" || route.page === "truth" || route.page === "analytics"
    ? route.bookId
    : undefined;
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
    toBook: (bookId: string) => setRoute({ page: "book", bookId }),
    toBookCreate: () => setRoute({ page: "book-create-entry" }),
    toBookCreateEntry: () => setRoute({ page: "book-create-entry" }),
    toBookCreateSimple: () => setRoute({ page: "book-create-simple" }),
    toBookCreateReview: () => setRoute({ page: "book-create-review" }),
    toBookCreatePro: () => setRoute({ page: "book-create-pro" }),
    toChapter: (bookId: string, chapterNumber: number) =>
      setRoute({ page: "chapter", bookId, chapterNumber }),
    toAnalytics: (bookId: string) => setRoute({ page: "analytics", bookId }),
    toConfig: () => setRoute({ page: "config" }),
    toTruth: (bookId: string) => setRoute({ page: "truth", bookId }),
    toDaemon: () => setRoute(routeToRuntimeCenterFromLegacy("daemon")),
    toLogs: () => setRoute(routeToRuntimeCenterFromLegacy("logs")),
    toRuntimeCenter: () => setRoute({ page: "runtime-center" }),
    toGenres: () => setRoute({ page: "genres" }),
    toStyle: () => setRoute({ page: "style" }),
    toImport: () => setRoute({ page: "import" }),
    toRadar: () => setRoute({ page: "radar" }),
    toDoctor: () => setRoute({ page: "doctor" }),
  }), [setRoute]);

  const activeBookId = deriveActiveBookId(route);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : route.page;
  const contentContainerClass =
    route.page === "truth"
      ? "max-w-[1400px] mx-auto px-4 py-8 md:px-6 lg:px-8 lg:py-10 fade-in"
      : "max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in";

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

            <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-foreground transition-all relative">
              <Bell size={16} />
              <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full border-2 border-background" />
            </button>

            {/* Chat Panel Toggle */}
            <button
              onClick={() => setChatOpen((prev) => !prev)}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all shadow-sm ${
                chatOpen
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
            {route.page === "dashboard" && <Dashboard nav={nav} sse={sse} theme={theme} t={t} />}
            {route.page === "book" && <BookDetail bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />}
            {route.page === "book-create" && <BookCreate nav={nav} theme={theme} t={t} />}
            {route.page === "book-create-entry" && <BookCreateEntry nav={nav} theme={theme} t={t} />}
            {route.page === "book-create-simple" && <BookCreateSimple nav={nav} theme={theme} t={t} flow={createFlow} />}
            {route.page === "book-create-review" && <BookCreateReview nav={nav} theme={theme} t={t} flow={createFlow} />}
            {route.page === "book-create-pro" && <BookCreatePro nav={nav} theme={theme} t={t} />}
            {route.page === "chapter" && <ChapterReader bookId={route.bookId} chapterNumber={route.chapterNumber} nav={nav} theme={theme} t={t} />}
            {route.page === "analytics" && <Analytics bookId={route.bookId} nav={nav} theme={theme} t={t} />}
            {route.page === "config" && <ConfigView nav={nav} theme={theme} t={t} />}
            {route.page === "truth" && <TruthFiles bookId={route.bookId} nav={nav} theme={theme} t={t} />}
            {route.page === "daemon" && <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />}
            {route.page === "logs" && <LogViewer nav={nav} theme={theme} t={t} />}
            {route.page === "runtime-center" && <RuntimeCenter nav={nav} theme={theme} t={t} sse={sse} />}
            {route.page === "genres" && <GenreManager nav={nav} theme={theme} t={t} />}
            {route.page === "style" && <StyleManager nav={nav} theme={theme} t={t} />}
            {route.page === "import" && <ImportManager nav={nav} theme={theme} t={t} />}
            {route.page === "radar" && <RadarView nav={nav} theme={theme} t={t} />}
            {route.page === "doctor" && <DoctorView nav={nav} theme={theme} t={t} />}
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
