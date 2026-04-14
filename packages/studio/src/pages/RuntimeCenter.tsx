import { useApi, postApi } from "../hooks/use-api";
import { useEffect, useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import type { SSEMessage } from "../hooks/use-sse";
import { shouldRefetchDaemonStatus } from "../hooks/use-book-activity";

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
  const { data: daemonData, refetch: refetchDaemon } = useApi<{ running: boolean }>("/daemon");
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
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
    if (paused) return;
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [sse.messages, paused]);

  const isRunning = daemonData?.running ?? false;

  const hasFilter = Boolean(filter.level || filter.source || filter.bookId);
  const visible = filterEvents(sse.messages, filter);

  const handleStart = async () => {
    setLoading(true);
    try {
      await postApi("/daemon/start");
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
      <div className={`border ${c.cardStatic} rounded-lg p-5 flex items-center justify-between gap-4`}>
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full ${isRunning ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"}`}
          />
          <div>
            <div className="text-sm font-semibold text-foreground/80 uppercase tracking-wider">
              {t("rc.daemonCard")}
            </div>
            <div className={`text-xs mt-0.5 ${isRunning ? "text-emerald-500" : "text-muted-foreground"}`}>
              {isRunning ? t("daemon.running") : t("daemon.stopped")}
            </div>
          </div>
        </div>

        {isRunning ? (
          <button
            onClick={handleStop}
            disabled={loading}
            className={`px-4 py-2 text-sm rounded-md ${c.btnDanger} disabled:opacity-50`}
          >
            {loading ? t("daemon.stopping") : t("daemon.stop")}
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={loading}
            className={`px-4 py-2 text-sm rounded-md ${c.btnPrimary} disabled:opacity-50`}
          >
            {loading ? t("daemon.starting") : t("daemon.start")}
          </button>
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
              onClick={() => setPaused((p) => !p)}
              className={`px-3 py-1.5 text-xs rounded-md ${paused ? c.btnPrimary : c.btnSecondary}`}
            >
              {paused ? t("rc.resumeScroll") : t("rc.pauseScroll")}
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
