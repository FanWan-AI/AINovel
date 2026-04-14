import { useApi, postApi } from "../hooks/use-api";
import { useEffect, useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import type { SSEMessage } from "../hooks/use-sse";
import { shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import type { DaemonSessionState, DaemonSessionSummary } from "../shared/contracts";

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

export interface RuntimeControlState {
  readonly showStart: boolean;
  readonly showPause: boolean;
  readonly showResume: boolean;
  readonly stopDisabled: boolean;
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
  if (msg.event === "log" && typeof data?.level === "string") {
    return data.level.toLowerCase();
  }
  if (msg.event.endsWith(":error")) return "error";
  if (msg.event.endsWith(":fail")) return "error";
  if (msg.event.endsWith(":complete")) return "info";
  if (msg.event.endsWith(":success")) return "info";
  if (msg.event.endsWith(":start")) return "info";
  return "debug";
}

/**
 * Derive a source label (the event prefix before the first colon).
 */
export function deriveEventSource(msg: SSEMessage): string {
  const colon = msg.event.indexOf(":");
  return colon === -1 ? msg.event : msg.event.slice(0, colon);
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
    if (filter.level && deriveEventLevel(msg) !== filter.level) return false;
    if (filter.source && deriveEventSource(msg) !== filter.source) return false;
    if (filter.bookId) {
      const data = msg.data as Record<string, unknown> | null;
      if (typeof data?.bookId !== "string" || data.bookId !== filter.bookId) return false;
    }
    return true;
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
): RuntimeSessionViewModel {
  const chapterEvents = messages
    .filter((msg) => msg.event === "daemon:chapter")
    .map((msg) => msg.data as Record<string, unknown>);
  const latestChapter = chapterEvents.at(-1);
  const currentBook = typeof latestChapter?.bookId === "string" ? latestChapter.bookId : "—";
  const currentChapter = typeof latestChapter?.chapter === "number" ? String(latestChapter.chapter) : "—";
  const completedCount = chapterEvents.filter(
    (data) => typeof data.status === "string" && COMPLETED_STATUSES.includes(data.status),
  ).length;
  const failedCount = messages.filter((msg) => deriveEventLevel(msg) === "error").length;
  const latestErrorMessage = [...messages].reverse().find((msg) => deriveEventLevel(msg) === "error");
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
// Component
// ---------------------------------------------------------------------------

const LEVEL_COLORS: Record<string, string> = {
  error: "text-destructive",
  warn: "text-amber-500",
  info: "text-primary/70",
  debug: "text-muted-foreground/50",
};

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

  // Auto-scroll unless paused
  useEffect(() => {
    if (streamPaused) return;
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [sse.messages, streamPaused]);

  const sessionState = daemonSession?.state ?? "idle";
  const isRunning = daemonSession?.running ?? false;
  const controls = deriveRuntimeControlState(sessionState, loading);
  const sessionView = deriveRuntimeSessionViewModel(daemonSession ?? null, sse.messages);

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
                <select
                  value={advancedForm.scopeType}
                  onChange={(e) => setAdvancedForm((f) => ({ ...f, scopeType: e.target.value as RuntimeAdvancedForm["scopeType"] }))}
                  className={`text-xs px-2 py-2 rounded-md border border-border bg-background text-foreground ${c.input ?? ""}`}
                >
                  <option value="all-active">{t("rc.scopeAllActive")}</option>
                  <option value="book-list">{t("rc.scopeBookList")}</option>
                </select>
                {advancedForm.scopeType === "book-list" && (
                  <input
                    type="text"
                    value={advancedForm.bookIdsText}
                    onChange={(e) => setAdvancedForm((f) => ({ ...f, bookIdsText: e.target.value }))}
                    placeholder={t("rc.scopeBookIdsPlaceholder")}
                    className="text-xs px-2 py-2 rounded-md border border-border bg-background text-foreground"
                  />
                )}
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
            <div className="space-y-1.5 font-mono text-xs">
              {visible.map((msg, i) => {
                const data = msg.data as Record<string, unknown> | null;
                const level = deriveEventLevel(msg);
                const levelColor = LEVEL_COLORS[level] ?? "text-muted-foreground";
                const text = String(
                  data?.message ?? data?.bookId ?? JSON.stringify(data),
                );
                const ts = new Date(msg.timestamp).toLocaleTimeString();
                return (
                  <div key={i} className="flex gap-2 leading-relaxed">
                    <span className="text-muted-foreground/50 shrink-0 tabular-nums w-20">{ts}</span>
                    <span className={`shrink-0 w-12 uppercase ${levelColor}`}>{level}</span>
                    <span className="text-primary/50 shrink-0">{msg.event}</span>
                    <span className="text-foreground/80 break-all">{text}</span>
                  </div>
                );
              })}
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
