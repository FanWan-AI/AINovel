import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { StringKey, TFunction } from "../../hooks/use-i18n";
import type { ChapterRunActionType, ChapterRunRecord, ChapterRunStatus } from "../../hooks/use-chapter-runs";

interface ChapterTaskCenterProps {
  readonly runs: ReadonlyArray<ChapterRunRecord>;
  readonly chapterOptions: ReadonlyArray<number>;
  readonly loading: boolean;
  readonly errorKey: StringKey | null;
  readonly onRetry: () => void;
  readonly onDeleteRun?: (runId: string) => void;
  readonly collapsed?: boolean;
  readonly onToggleCollapsed?: () => void;
  readonly t: TFunction;
}

type FilterActionType = "all" | ChapterRunActionType;
type FilterStatus = "all" | ChapterRunStatus;
type FilterChapter = "all" | number;

export function formatRunDuration(durationMs: number | undefined, t: TFunction): string {
  if (typeof durationMs !== "number") return t("chapterTaskCenter.durationPending");
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 100) / 10;
  return `${seconds}s`;
}

function actionTypeLabel(actionType: ChapterRunActionType, t: TFunction): string {
  if (actionType === "spot-fix") return t("book.spotFix");
  if (actionType === "polish") return t("book.polish");
  if (actionType === "rework") return t("book.rework");
  if (actionType === "rewrite") return t("book.rewrite");
  if (actionType === "anti-detect") return t("book.antiDetect");
  return t("chapterTaskCenter.actionResync");
}

function statusLabel(status: ChapterRunStatus, t: TFunction): string {
  if (status === "running") return t("chapterTaskCenter.statusRunning");
  if (status === "success") return t("chapterTaskCenter.statusSuccess");
  if (status === "failed") return t("chapterTaskCenter.statusFailed");
  return t("chapterTaskCenter.statusUnchanged");
}

function statusClass(status: ChapterRunStatus): string {
  if (status === "running") return "bg-primary/10 text-primary border-primary/20";
  if (status === "success") return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
  if (status === "failed") return "bg-destructive/10 text-destructive border-destructive/20";
  return "bg-amber-500/10 text-amber-600 border-amber-500/20";
}

export function filterTaskRuns(
  runs: ReadonlyArray<ChapterRunRecord>,
  chapterFilter: FilterChapter,
  statusFilter: FilterStatus,
  actionFilter: FilterActionType,
): ReadonlyArray<ChapterRunRecord> {
  return runs.filter((run) => {
    if (chapterFilter !== "all" && run.chapterNumber !== chapterFilter) return false;
    if (statusFilter !== "all" && run.status !== statusFilter) return false;
    if (actionFilter !== "all" && run.actionType !== actionFilter) return false;
    return true;
  });
}

export function ChapterTaskCenter({
  runs,
  chapterOptions,
  loading,
  errorKey,
  onRetry,
  onDeleteRun,
  collapsed = true,
  onToggleCollapsed,
  t,
}: ChapterTaskCenterProps) {
  const [chapterFilter, setChapterFilter] = useState<FilterChapter>("all");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const [actionFilter, setActionFilter] = useState<FilterActionType>("all");

  const filteredRuns = useMemo(
    () => filterTaskRuns(runs, chapterFilter, statusFilter, actionFilter),
    [actionFilter, chapterFilter, runs, statusFilter],
  );

  return (
    <section className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">{t("chapterTaskCenter.title")}</h2>
          <div className="text-xs text-muted-foreground">{t("chapterTaskCenter.hint")}</div>
        </div>
        <button
          onClick={onToggleCollapsed}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg border border-border/50 bg-secondary/30 hover:bg-secondary/60 transition-colors"
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          {collapsed ? t("chapterTaskCenter.expand") : t("chapterTaskCenter.collapse")}
        </button>
      </div>

      {collapsed && (
        <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
          {t("chapterTaskCenter.collapsedSummary").replace("{count}", String(filteredRuns.length))}
        </div>
      )}

      {!collapsed && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <select
              value={String(chapterFilter)}
              onChange={(event) => {
                const next = event.target.value;
                setChapterFilter(next === "all" ? "all" : Number(next));
              }}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-border/50 bg-secondary/30"
            >
              <option value="all">{t("chapterTaskCenter.filterAllChapters")}</option>
              {chapterOptions.map((chapter) => (
                <option key={chapter} value={chapter}>{t("chapter.label").replace("{n}", String(chapter))}</option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as FilterStatus)}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-border/50 bg-secondary/30"
            >
              <option value="all">{t("chapterTaskCenter.filterAllStatuses")}</option>
              <option value="running">{t("chapterTaskCenter.statusRunning")}</option>
              <option value="success">{t("chapterTaskCenter.statusSuccess")}</option>
              <option value="failed">{t("chapterTaskCenter.statusFailed")}</option>
              <option value="unchanged">{t("chapterTaskCenter.statusUnchanged")}</option>
            </select>

            <select
              value={actionFilter}
              onChange={(event) => setActionFilter(event.target.value as FilterActionType)}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-border/50 bg-secondary/30"
            >
              <option value="all">{t("chapterTaskCenter.filterAllActions")}</option>
              <option value="spot-fix">{t("book.spotFix")}</option>
              <option value="polish">{t("book.polish")}</option>
              <option value="rework">{t("book.rework")}</option>
              <option value="rewrite">{t("book.rewrite")}</option>
              <option value="anti-detect">{t("book.antiDetect")}</option>
              <option value="resync">{t("chapterTaskCenter.actionResync")}</option>
            </select>
          </div>

          {loading && (
            <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-6 text-sm text-muted-foreground">
              {t("chapterTaskCenter.loading")}
            </div>
          )}

          {!loading && errorKey && (
            <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4 text-sm text-destructive space-y-2">
              <div>{t(errorKey)}</div>
              <button
                onClick={onRetry}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-destructive/30 hover:bg-destructive/10"
              >
                {t("chapterTaskCenter.retry")}
              </button>
            </div>
          )}

          {!loading && !errorKey && filteredRuns.length === 0 && (
            <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-6 text-sm text-muted-foreground">
              {runs.length === 0 ? t("chapterTaskCenter.empty") : t("chapterTaskCenter.emptyFiltered")}
            </div>
          )}

          {!loading && !errorKey && filteredRuns.length > 0 && (
            <div className="space-y-3">
              {filteredRuns.map((run) => (
                <article key={run.id} className="rounded-xl border border-border/40 bg-card/50 p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 justify-between">
                    <div className="text-sm font-semibold">
                      {t("chapter.label").replace("{n}", String(run.chapterNumber))}
                      <span className="text-muted-foreground font-normal"> · {actionTypeLabel(run.actionType, t)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusClass(run.status)}`}>
                        {statusLabel(run.status, t)}
                      </span>
                      {onDeleteRun && (
                        <button
                          onClick={() => {
                            if (!window.confirm(t("chapterTaskCenter.confirmDeleteEntry"))) return;
                            onDeleteRun(run.id);
                          }}
                          className="p-1.5 rounded-lg border border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive hover:text-white transition-colors"
                          title={t("chapterTaskCenter.deleteEntry")}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-muted-foreground">
                    <div><span className="font-semibold">{t("chapterTaskCenter.fieldDuration")}</span> {formatRunDuration(run.durationMs, t)}</div>
                    <div className="md:col-span-2"><span className="font-semibold">{t("chapterTaskCenter.fieldSummary")}</span> {run.briefSummary ?? t("chapterTaskCenter.noSummary")}</div>
                    {(run.status === "failed" || run.status === "unchanged") && (
                      <div className="md:col-span-3"><span className="font-semibold">{t("chapterTaskCenter.fieldReason")}</span> {run.reason ?? t("chapterTaskCenter.noReason")}</div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
