import { useEffect, useRef } from "react";
import { FileDiff, X } from "lucide-react";
import type { TFunction } from "../../hooks/use-i18n";

export interface ChapterRunBriefTraceItem {
  readonly text: string;
  readonly matched: boolean;
}

export interface ChapterRunDiffPayload {
  readonly runId: string;
  readonly chapter: number;
  readonly actionType: string;
  readonly decision: string | null;
  readonly unchangedReason: string | null;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
  readonly briefTrace: ReadonlyArray<ChapterRunBriefTraceItem>;
}

interface ChapterDiffDialogProps {
  readonly open: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly payload: ChapterRunDiffPayload | null;
  readonly t: TFunction;
  readonly onClose: () => void;
}

function actionLabel(actionType: string, t: TFunction): string {
  if (actionType === "rewrite") return t("book.rewrite");
  if (actionType === "anti-detect") return t("book.antiDetect");
  if (actionType === "resync") return t("chapterTaskCenter.actionResync");
  return t("book.spotFix");
}

export function ChapterDiffDialog({
  open,
  loading,
  error,
  payload,
  t,
  onClose,
}: ChapterDiffDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || loading) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [loading, onClose, open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === overlayRef.current && !loading) onClose();
      }}
    >
      <div className="w-full max-w-6xl mx-4 rounded-3xl border border-border/50 bg-card shadow-2xl shadow-primary/15 overflow-hidden">
        <div className="px-6 pt-6 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
              <FileDiff size={18} className="text-primary" />
            </div>
            <div>
              <h3 className="text-xl font-semibold">{t("chapterDiff.dialogTitle")}</h3>
              {payload && (
                <p className="text-xs text-muted-foreground">
                  {t("chapterAction.chapterPrefix")} {payload.chapter} · {actionLabel(payload.actionType, t)}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 pb-6 space-y-4">
          {loading && (
            <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-6 text-sm text-muted-foreground">
              {t("chapterDiff.loading")}
            </div>
          )}

          {!loading && error && (
            <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && payload && (
            <>
              {payload.decision === "unchanged" && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
                  <span className="font-semibold">{t("chapterDiff.unchangedReasonLabel")}</span>{" "}
                  {payload.unchangedReason ?? t("chapterDiff.unchangedReasonFallback")}
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("chapterDiff.briefTraceTitle")}</h4>
                {payload.briefTrace.length === 0 ? (
                  <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-3 text-sm text-muted-foreground">
                    {t("chapterDiff.briefTraceEmpty")}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {payload.briefTrace.map((item, index) => (
                      <li key={index} className="rounded-xl border border-border/40 bg-secondary/20 px-3 py-2 flex items-center justify-between gap-3">
                        <span className="text-sm">{item.text}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${item.matched ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                          {item.matched ? t("chapterDiff.traceMatched") : t("chapterDiff.traceMissed")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/40 bg-secondary/10 p-3 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("chapterDiff.beforeTitle")}</div>
                  <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{payload.beforeContent ?? t("chapterDiff.emptyContent")}</pre>
                </div>
                <div className="rounded-xl border border-border/40 bg-secondary/10 p-3 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("chapterDiff.afterTitle")}</div>
                  <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{payload.afterContent ?? t("chapterDiff.emptyContent")}</pre>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
