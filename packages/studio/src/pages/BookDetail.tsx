import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { normalizeStudioEventName, type SSEMessage } from "../hooks/use-sse";
import { useColors } from "../hooks/use-colors";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { useChapterRuns, type ChapterRunActionType } from "../hooks/use-chapter-runs";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { WriteNextDialog } from "../components/write-next/WriteNextDialog";
import type { WriteNextPayload } from "../components/write-next/WriteNextDialog";
import { ChapterActionDialog, type ChapterActionKind } from "../components/chapter-actions/ChapterActionDialog";
import { ChapterDiffDialog, type ChapterRunDiffPayload } from "../components/chapter-actions/ChapterDiffDialog";
import { ChapterTaskCenter } from "../components/chapter-actions/ChapterTaskCenter";
import {
  ChevronLeft,
  Zap,
  FileText,
  CheckCheck,
  BarChart2,
  Download,
  Search,
  Wand2,
  Eye,
  Database,
  Check,
  X,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  Sparkles,
  Trash2,
  Save
} from "lucide-react";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly chapterWordCount: number;
    readonly targetChapters?: number;
    readonly language?: string;
    readonly fanficMode?: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

interface BookCreateStatusData {
  readonly status: "creating" | "error" | "missing";
  readonly error?: string;
}

interface ChapterRunSummaryData {
  readonly runId: string;
  readonly chapter: number;
  readonly actionType: string;
  readonly status: string;
  readonly decision: string | null;
  readonly unchangedReason: string | null;
  readonly appliedBrief: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

type ReviseMode = "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";
type ExportFormat = "txt" | "md" | "epub";
type BookStatus = "active" | "paused" | "outlining" | "completed" | "dropped";
type ChapterLifecycleAction = "revise" | "rewrite" | "anti-detect" | "resync";
type ChapterLifecycleStage = "start" | "progress" | "success" | "fail" | "unchanged";

interface ChapterActionState {
  readonly kind: ChapterActionKind;
  readonly chapterNum: number;
  readonly mode?: ReviseMode;
}

export function supportsRunDiff(actionType: string): boolean {
  return actionType === "revise" || actionType === "rewrite" || actionType === "anti-detect";
}

export function resolveRunUnchangedReason(
  decision: string | null | undefined,
  unchangedReason: string | null | undefined,
  fallback: string,
): string | null {
  const trimmed = typeof unchangedReason === "string" ? unchangedReason.trim() : "";
  if (trimmed) return trimmed;
  if (decision === "unchanged") return fallback;
  return null;
}

export function parseChapterLifecycleEvent(event: string): { action: ChapterLifecycleAction; stage: ChapterLifecycleStage } | null {
  const normalizedEvent = normalizeStudioEventName(event);
  const [action, stage] = normalizedEvent.split(":");
  if (!action || !stage) return null;
  if (action !== "revise" && action !== "rewrite" && action !== "anti-detect" && action !== "resync") return null;
  if (stage !== "start" && stage !== "progress" && stage !== "success" && stage !== "fail" && stage !== "unchanged") return null;
  return { action, stage };
}

function resolveChapterLifecycleStage(
  stage: ChapterLifecycleStage | undefined,
  decision: string | undefined,
): ChapterLifecycleStage | undefined {
  if (stage === "success" && decision === "unchanged") {
    return "unchanged";
  }
  return stage;
}

interface Nav {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toAnalytics: (bookId: string) => void;
}

export function translateChapterStatus(status: string, t: TFunction): string {
  const map: Record<string, () => string> = {
    "ready-for-review": () => t("chapter.readyForReview"),
    "approved": () => t("chapter.approved"),
    "drafted": () => t("chapter.drafted"),
    "needs-revision": () => t("chapter.needsRevision"),
    "imported": () => t("chapter.imported"),
    "audit-failed": () => t("chapter.auditFailed"),
  };
  return map[status]?.() ?? status;
}

/** Returns the two top-level action IDs rendered in the header.
 *  Used in tests to verify dual-button rendering without touching the DOM. */
export function getTopActionIds(): ReadonlyArray<"planNextAndWrite" | "quickWrite"> {
  return ["planNextAndWrite", "quickWrite"];
}

export function resolveChapterTaskActionType(kind: ChapterActionKind, mode?: ReviseMode): ChapterRunActionType {
  if (kind === "rewrite") return "rewrite";
  if (kind === "resync") return "resync";
  if (mode === "polish" || mode === "rework" || mode === "rewrite" || mode === "anti-detect") return mode;
  return "spot-fix";
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  "ready-for-review": { color: "text-amber-500 bg-amber-500/10", icon: <Eye size={12} /> },
  approved: { color: "text-emerald-500 bg-emerald-500/10", icon: <Check size={12} /> },
  drafted: { color: "text-muted-foreground bg-muted/20", icon: <FileText size={12} /> },
  "needs-revision": { color: "text-destructive bg-destructive/10", icon: <RotateCcw size={12} /> },
  imported: { color: "text-blue-500 bg-blue-500/10", icon: <Download size={12} /> },
};

export function BookDetail({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const {
    data: createStatus,
    refetch: refetchCreateStatus,
  } = useApi<BookCreateStatusData>(`/books/${bookId}/create-status`);
  const {
    data: chapterRunSummaryData,
    loading: chapterRunSummaryLoading,
    refetch: refetchChapterRunSummary,
  } = useApi<{ runs: ReadonlyArray<ChapterRunSummaryData> }>(`/books/${bookId}/chapter-runs?limit=30`);
  const [writeRequestPending, setWriteRequestPending] = useState(false);
  const [draftRequestPending, setDraftRequestPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [writeNextDialogOpen, setWriteNextDialogOpen] = useState(false);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [revisingChapters, setRevisingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [chapterActionDialog, setChapterActionDialog] = useState<ChapterActionState | null>(null);
  const [chapterActionBrief, setChapterActionBrief] = useState("");
  const [chapterActionRunning, setChapterActionRunning] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsWordCount, setSettingsWordCount] = useState<number | null>(null);
  const [settingsTargetChapters, setSettingsTargetChapters] = useState<number | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<BookStatus | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [exportApprovedOnly, setExportApprovedOnly] = useState(false);
  const [chapterDiffOpen, setChapterDiffOpen] = useState(false);
  const [chapterDiffLoading, setChapterDiffLoading] = useState(false);
  const [chapterDiffError, setChapterDiffError] = useState<string | null>(null);
  const [chapterDiffPayload, setChapterDiffPayload] = useState<ChapterRunDiffPayload | null>(null);
  const {
    runs: chapterRuns,
    loading: chapterRunsLoading,
    errorKey: chapterRunsErrorKey,
    chapterOptions: chapterRunOptions,
    startRun,
    finishRun,
    applyLifecycleUpdate,
    retryLoad: retryChapterRunsLoad,
  } = useChapterRuns(bookId);
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;
  const diffEnabledRuns = useMemo(
    () => (chapterRunSummaryData?.runs ?? []).filter((run) => supportsRunDiff(run.actionType)),
    [chapterRunSummaryData?.runs],
  );

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;

    const data = recent.data as {
      bookId?: string;
      chapter?: number;
      chapterNumber?: number;
      decision?: string;
      error?: string;
      message?: string;
      fixedCount?: number;
      appliedBrief?: string | null;
    } | null;
    if (data?.bookId !== bookId) return;
    const normalizedEvent = normalizeStudioEventName(recent.event);

    if (normalizedEvent === "write:start") {
      setWriteRequestPending(false);
      return;
    }

    if (normalizedEvent === "draft:start") {
      setDraftRequestPending(false);
      return;
    }

    const chapterEvent = parseChapterLifecycleEvent(recent.event);
    const chapterNumber = data?.chapterNumber ?? data?.chapter;
    const stage = resolveChapterLifecycleStage(chapterEvent?.stage, data?.decision);
    if (chapterEvent && chapterNumber && (stage === "success" || stage === "unchanged" || stage === "fail")) {
      applyLifecycleUpdate({
        chapterNumber,
        action: chapterEvent.action,
        stage,
        reason: stage === "fail" || stage === "unchanged" ? (data?.error ?? data?.message) : undefined,
        briefSummary: typeof data?.appliedBrief === "string" ? data.appliedBrief : undefined,
        timestamp: recent.timestamp,
      });
      void refetchChapterRunSummary();
    }

    if (shouldRefetchBookView(recent, bookId)) {
      setWriteRequestPending(false);
      setDraftRequestPending(false);
      refetch();
    }
  }, [applyLifecycleUpdate, bookId, refetch, refetchChapterRunSummary, sse.messages]);

  useEffect(() => {
    const isNotFound = typeof error === "string" && /not found/i.test(error);
    if (!isNotFound || createStatus?.status !== "creating") {
      return;
    }

    const timer = window.setInterval(() => {
      void refetch();
      void refetchCreateStatus();
    }, 1500);

    return () => {
      window.clearInterval(timer);
    };
  }, [createStatus?.status, error, refetch, refetchCreateStatus]);

  const handleWriteNext = () => {
    setWriteNextDialogOpen(true);
  };

  const handleWriteNextWithPayload = async (payload: WriteNextPayload) => {
    setWriteNextDialogOpen(false);
    setWriteRequestPending(true);
    try {
      await postApi(`/books/${bookId}/write-next`, Object.keys(payload).length > 0 ? payload : undefined);
    } catch (e) {
      setWriteRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleQuickWrite = async () => {
    setWriteRequestPending(true);
    try {
      await postApi(`/books/${bookId}/write-next`);
    } catch (e) {
      setWriteRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDraft = async () => {
    setDraftRequestPending(true);
    try {
      await postApi(`/books/${bookId}/draft`);
    } catch (e) {
      setDraftRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDeleteBook = async () => {
    setConfirmDeleteOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/books/${bookId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `${res.status}`);
      }
      nav.toDashboard();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const handleRewrite = async (chapterNum: number, brief?: string) => {
    setRewritingChapters((prev) => [...prev, chapterNum]);
    try {
      const result = await fetchJson<{ status: string; chapter: number; appliedBrief?: string | null }>(`/books/${bookId}/rewrite/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      refetch();
      return result;
    } catch (e) {
      throw e;
    } finally {
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleRevise = async (chapterNum: number, mode: ReviseMode, brief?: string) => {
    setRevisingChapters((prev) => [...prev, chapterNum]);
    try {
      const result = await fetchJson<{ fixedIssues?: string[]; status?: string; appliedBrief?: string | null }>(`/books/${bookId}/revise/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, brief }),
      });
      refetch();
      return result;
    } catch (e) {
      throw e;
    } finally {
      setRevisingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSync = async (chapterNum: number, brief?: string) => {
    setSyncingChapters((prev) => [...prev, chapterNum]);
    try {
      const result = await fetchJson<{ ok?: boolean; appliedBrief?: string | null }>(`/books/${bookId}/resync/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      refetch();
      return result;
    } catch (e) {
      throw e;
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const openChapterActionDialog = (next: ChapterActionState) => {
    setChapterActionDialog(next);
    setChapterActionBrief("");
  };

  const executeChapterAction = async () => {
    if (!chapterActionDialog) return;
    setChapterActionRunning(true);
    const brief = chapterActionBrief.trim() || undefined;
    const runId = startRun({
      chapterNumber: chapterActionDialog.chapterNum,
      actionType: resolveChapterTaskActionType(chapterActionDialog.kind, chapterActionDialog.mode),
      briefSummary: brief,
    });
    try {
      if (chapterActionDialog.kind === "rewrite") {
        await handleRewrite(chapterActionDialog.chapterNum, brief);
      } else if (chapterActionDialog.kind === "resync") {
        const result = await handleSync(chapterActionDialog.chapterNum, brief);
        finishRun({
          runId,
          status: "success",
          briefSummary: typeof result?.appliedBrief === "string" ? result.appliedBrief : brief,
        });
      } else {
        await handleRevise(chapterActionDialog.chapterNum, chapterActionDialog.mode ?? "spot-fix", brief);
      }
      setChapterActionDialog(null);
      setChapterActionBrief("");
    } catch (e) {
      finishRun({
        runId,
        status: "failed",
        reason: e instanceof Error ? e.message : String(e),
        briefSummary: brief,
      });
    } finally {
      setChapterActionRunning(false);
      void refetchChapterRunSummary();
    }
  };

  const openChapterDiffDialog = async (runId: string) => {
    setChapterDiffOpen(true);
    setChapterDiffLoading(true);
    setChapterDiffError(null);
    try {
      const diff = await fetchJson<ChapterRunDiffPayload>(`/books/${bookId}/chapter-runs/${runId}/diff`);
      setChapterDiffPayload({
        ...diff,
        unchangedReason: resolveRunUnchangedReason(
          diff.decision,
          diff.unchangedReason,
          t("chapterDiff.unchangedReasonFallback"),
        ),
      });
    } catch (e) {
      setChapterDiffPayload(null);
      setChapterDiffError(e instanceof Error ? e.message : String(e));
    } finally {
      setChapterDiffLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!data) return;
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (settingsWordCount !== null) body.chapterWordCount = settingsWordCount;
      if (settingsTargetChapters !== null) body.targetChapters = settingsTargetChapters;
      if (settingsStatus !== null) body.status = settingsStatus;
      await fetchJson(`/books/${bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleApproveAll = async () => {
    if (!data) return;
    const reviewable = data.chapters.filter((ch) => ch.status === "ready-for-review");
    for (const ch of reviewable) {
      await postApi(`/books/${bookId}/chapters/${ch.number}/approve`);
    }
    refetch();
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
    </div>
  );

  if (error) {
    const isNotFound = /not found/i.test(error);
    if (isNotFound && createStatus?.status === "creating") {
      return (
        <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-8 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <div className="text-base font-semibold">{t("book.pipelineWriting")}</div>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("common.loading")}
          </p>
        </div>
      );
    }

    if (createStatus?.status === "error" && createStatus.error) {
      return (
        <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">
          Error: {createStatus.error}
        </div>
      );
    }

    return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  }
  if (!data) return null;

  const { book, chapters } = data;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;

  const currentWordCount = settingsWordCount ?? book.chapterWordCount;
  const currentTargetChapters = settingsTargetChapters ?? book.targetChapters ?? 0;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);

  const exportHref = `/api/books/${bookId}/export?format=${exportFormat}${exportApprovedOnly ? "&approvedOnly=true" : ""}`;

  return (
    <div className="space-y-8 fade-in">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button
          onClick={nav.toDashboard}
          className="hover:text-primary transition-colors flex items-center gap-1"
        >
          <ChevronLeft size={14} />
          {t("bread.books")}
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{book.title}</span>
      </nav>

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/40 pb-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-serif font-medium">{book.title}</h1>
            {book.language === "en" && (
              <span className="px-1.5 py-0.5 rounded border border-primary/20 text-primary text-[10px] font-bold">EN</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground font-medium">
            <span className="px-2 py-0.5 rounded bg-secondary/50 text-foreground/70 uppercase tracking-wider text-xs">{book.genre}</span>
            <div className="flex items-center gap-1.5">
              <FileText size={14} />
              <span>{chapters.length} {t("dash.chapters")}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Zap size={14} />
              <span>{totalWords.toLocaleString()} {t("book.words")}</span>
            </div>
            {book.fanficMode && (
              <span className="flex items-center gap-1 text-purple-500">
                <Sparkles size={12} />
                <span className="italic">fanfic:{book.fanficMode}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleWriteNext}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Wand2 size={16} />}
            {writing ? t("dash.writing") : t("book.planNextAndWrite")}
          </button>
          <button
            onClick={handleQuickWrite}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-secondary text-foreground rounded-xl hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50"
          >
            <Zap size={14} />
            {t("writeNext.quickWrite")}
          </button>
        </div>
      </div>

      {(writing || drafting || activity.lastError) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            activity.lastError
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-primary/20 bg-primary/[0.04] text-foreground"
          }`}
        >
          {activity.lastError ? (
            <span>
              {t("book.pipelineFailed")}: {activity.lastError}
            </span>
          ) : writing ? (
            <span>{t("book.pipelineWriting")}</span>
          ) : (
            <span>{t("book.pipelineDrafting")}</span>
          )}
        </div>
      )}

      {/* Tool Strip */}
      <div className="flex flex-wrap items-center gap-2 py-1">
          {reviewCount > 0 && (
            <button
              onClick={handleApproveAll}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-500/10 text-emerald-600 rounded-lg hover:bg-emerald-500/20 transition-all border border-emerald-500/20"
            >
              <CheckCheck size={14} />
              {t("book.approveAll")} ({reviewCount})
            </button>
          )}
          <button
            onClick={() => (nav as { toTruth?: (id: string) => void }).toTruth?.(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <Database size={14} />
            {t("book.truthFiles")}
          </button>
          <button
            onClick={() => nav.toAnalytics(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <BarChart2 size={14} />
            {t("book.analytics")}
          </button>
          <div className="flex items-center gap-2">
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              className="px-2 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg border border-border/50 outline-none"
            >
              <option value="txt">TXT</option>
              <option value="md">MD</option>
              <option value="epub">EPUB</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={exportApprovedOnly}
                onChange={(e) => setExportApprovedOnly(e.target.checked)}
                className="rounded border-border/50"
              />
              {t("book.approvedOnly")}
            </label>
            <button
              onClick={async () => {
                try {
                  const data = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ format: exportFormat, approvedOnly: exportApprovedOnly }),
                  });
                  alert(`${t("common.exportSuccess")}\n${data.path}\n(${data.chapters} ${t("dash.chapters")})`);
                } catch (e) {
                  alert(e instanceof Error ? e.message : "Export failed");
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
            >
              <Download size={14} />
              {t("book.export")}
            </button>
          </div>
      </div>

      {/* Book Settings */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">{t("book.settings")}</h2>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.wordsPerChapter")}</label>
            <input
              type="number"
              value={currentWordCount}
              onChange={(e) => setSettingsWordCount(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.targetChapters")}</label>
            <input
              type="number"
              value={currentTargetChapters}
              onChange={(e) => setSettingsTargetChapters(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.status")}</label>
            <select
              value={currentStatus}
              onChange={(e) => setSettingsStatus(e.target.value as BookStatus)}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50"
            >
              <option value="active">{t("book.statusActive")}</option>
              <option value="paused">{t("book.statusPaused")}</option>
              <option value="outlining">{t("book.statusOutlining")}</option>
              <option value="completed">{t("book.statusCompleted")}</option>
              <option value="dropped">{t("book.statusDropped")}</option>
            </select>
          </div>
          <button
            onClick={handleSaveSettings}
            disabled={savingSettings}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            {savingSettings ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
            {savingSettings ? t("book.saving") : t("book.save")}
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-destructive/10 text-destructive rounded-lg hover:bg-destructive hover:text-white transition-all border border-destructive/20 disabled:opacity-50"
          >
            {deleting ? <div className="w-4 h-4 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" /> : <Trash2 size={14} />}
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
        </div>
      </div>

      {/* Chapters Table */}
      <div className="paper-sheet rounded-2xl overflow-hidden border border-border/40 shadow-xl shadow-primary/5">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/30 border-b border-border/50">
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-16">#</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.manuscriptTitle")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-28">{t("book.words")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-36">{t("book.status")}</th>
                <th className="text-right px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.curate")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {chapters.map((ch, index) => {
                const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
                return (
                <tr key={ch.number} className={`group hover:bg-primary/[0.02] transition-colors fade-in ${staggerClass}`}>
                  <td className="px-6 py-4 text-muted-foreground/60 font-mono text-xs">{ch.number.toString().padStart(2, '0')}</td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => nav.toChapter(bookId, ch.number)}
                      className="font-serif text-lg font-medium hover:text-primary transition-colors text-left"
                    >
                      {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </button>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground font-medium tabular-nums text-xs">{(ch.wordCount ?? 0).toLocaleString()}</td>
                  <td className="px-6 py-4">
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight ${STATUS_CONFIG[ch.status]?.color ?? "bg-muted text-muted-foreground"}`}>
                      {STATUS_CONFIG[ch.status]?.icon}
                      {translateChapterStatus(ch.status, t)}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      {ch.status === "ready-for-review" && (
                        <>
                          <button
                            onClick={async () => { await postApi(`/books/${bookId}/chapters/${ch.number}/approve`); refetch(); }}
                            className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all shadow-sm"
                            title={t("book.approve")}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={async () => { await postApi(`/books/${bookId}/chapters/${ch.number}/reject`); refetch(); }}
                            className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all shadow-sm"
                            title={t("book.reject")}
                          >
                            <X size={14} />
                          </button>
                        </>
                      )}
                      <button
                        onClick={async () => {
                          const auditResult = await fetchJson<{ passed?: boolean; issues?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                          alert(auditResult.passed ? "Audit passed" : `Audit failed: ${auditResult.issues?.length ?? 0} issues`);
                          refetch();
                        }}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
                        title={t("book.audit")}
                      >
                        <ShieldCheck size={14} />
                      </button>
                      <button
                        onClick={() => openChapterActionDialog({ kind: "rewrite", chapterNum: ch.number })}
                        disabled={rewritingChapters.includes(ch.number)}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={t("book.rewrite")}
                      >
                        {rewritingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RotateCcw size={14} />}
                      </button>
                      <button
                        onClick={() => openChapterActionDialog({ kind: "resync", chapterNum: ch.number })}
                        disabled={syncingChapters.includes(ch.number) || ch.number !== latestPersistedChapter}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={data?.book.language === "en" ? "Sync truth/state from edited chapter" : "根据已编辑章节同步 truth/state"}
                      >
                        {syncingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RefreshCw size={14} />}
                      </button>
                      <select
                        disabled={revisingChapters.includes(ch.number)}
                        value=""
                        onChange={(e) => {
                          const mode = e.target.value as ReviseMode;
                          if (mode) {
                            openChapterActionDialog({ kind: "revise", chapterNum: ch.number, mode });
                            e.currentTarget.value = "";
                          }
                        }}
                        className="px-2 py-1.5 text-[11px] font-bold rounded-lg bg-secondary text-muted-foreground border border-border/50 outline-none hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-50 cursor-pointer"
                        title="Revise with AI"
                      >
                        <option value="" disabled>{revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}</option>
                        <option value="spot-fix">{t("book.spotFix")}</option>
                        <option value="polish">{t("book.polish")}</option>
                        <option value="rewrite">{t("book.rewrite")}</option>
                        <option value="rework">{t("book.rework")}</option>
                        <option value="anti-detect">{t("book.antiDetect")}</option>
                      </select>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {chapters.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-muted/20 flex items-center justify-center mb-4">
               <FileText size={20} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm italic font-serif text-muted-foreground">
              {t("book.noChapters")}
            </p>
          </div>
        )}
      </div>

      <ChapterTaskCenter
        runs={chapterRuns}
        chapterOptions={chapterRunOptions}
        loading={chapterRunsLoading}
        errorKey={chapterRunsErrorKey}
        onRetry={retryChapterRunsLoad}
        t={t}
      />

      <section className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">{t("chapterDiff.title")}</h2>
          <span className="text-xs text-muted-foreground">{t("chapterDiff.hint")}</span>
        </div>
        {chapterRunSummaryLoading && (
          <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-5 text-sm text-muted-foreground">
            {t("chapterDiff.loading")}
          </div>
        )}
        {!chapterRunSummaryLoading && diffEnabledRuns.length === 0 && (
          <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-5 text-sm text-muted-foreground">
            {t("chapterDiff.empty")}
          </div>
        )}
        {!chapterRunSummaryLoading && diffEnabledRuns.length > 0 && (
          <div className="space-y-2">
            {diffEnabledRuns.map((run) => (
              <div key={run.runId} className="rounded-xl border border-border/40 bg-card/50 px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-semibold">{t("chapter.label").replace("{n}", String(run.chapter))}</span>
                  <span className="text-muted-foreground"> · {run.actionType}</span>
                </div>
                <button
                  onClick={() => { openChapterDiffDialog(run.runId); }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border/50 bg-secondary/30 hover:bg-secondary/60"
                >
                  {t("chapterDiff.viewButton")}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.deleteBook")}
        message={t("book.confirmDelete")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDeleteBook}
        onCancel={() => setConfirmDeleteOpen(false)}
      />

      <WriteNextDialog
        open={writeNextDialogOpen}
        defaultWordCount={data?.book.chapterWordCount}
        bookId={bookId}
        t={t}
        onSubmit={handleWriteNextWithPayload}
        onCancel={() => setWriteNextDialogOpen(false)}
      />

      <ChapterActionDialog
        open={chapterActionDialog !== null}
        kind={chapterActionDialog?.kind ?? "revise"}
        chapterNumber={chapterActionDialog?.chapterNum ?? 0}
        modeLabel={
          chapterActionDialog?.mode
            ? chapterActionDialog.mode === "spot-fix"
              ? t("book.spotFix")
              : chapterActionDialog.mode === "polish"
                ? t("book.polish")
                : chapterActionDialog.mode === "rewrite"
                  ? t("book.rewrite")
                  : chapterActionDialog.mode === "rework"
                    ? t("book.rework")
                    : t("book.antiDetect")
            : undefined
        }
        brief={chapterActionBrief}
        running={chapterActionRunning}
        t={t}
        onBriefChange={setChapterActionBrief}
        onSubmit={executeChapterAction}
        onCancel={() => {
          if (chapterActionRunning) return;
          setChapterActionDialog(null);
          setChapterActionBrief("");
        }}
      />

      <ChapterDiffDialog
        open={chapterDiffOpen}
        loading={chapterDiffLoading}
        error={chapterDiffError}
        payload={chapterDiffPayload}
        t={t}
        onClose={() => {
          if (chapterDiffLoading) return;
          setChapterDiffOpen(false);
          setChapterDiffError(null);
          setChapterDiffPayload(null);
        }}
      />
    </div>
  );
}
