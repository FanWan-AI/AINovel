import { useEffect, useRef } from "react";
import { Sparkles, X } from "lucide-react";
import type { TFunction } from "../../hooks/use-i18n";

export type ChapterActionKind = "revise" | "rewrite" | "resync" | "rewrite-in-place";

interface ChapterActionDialogProps {
  readonly open: boolean;
  readonly kind: ChapterActionKind;
  readonly chapterNumber: number;
  readonly modeLabel?: string;
  readonly brief: string;
  readonly running: boolean;
  readonly t: TFunction;
  readonly onBriefChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

function actionTitle(kind: ChapterActionKind, t: TFunction): string {
  if (kind === "rewrite") return t("chapterAction.titleRewrite");
  if (kind === "rewrite-in-place") return t("chapterAction.titleRewriteInPlace");
  if (kind === "resync") return t("chapterAction.titleResync");
  return t("chapterAction.titleRevise");
}

function actionDescription(kind: ChapterActionKind, t: TFunction): string {
  if (kind === "rewrite") return t("chapterAction.descRewrite");
  if (kind === "rewrite-in-place") return t("chapterAction.descRewriteInPlace");
  if (kind === "resync") return t("chapterAction.descResync");
  return t("chapterAction.descRevise");
}

function actionSubmitLabel(kind: ChapterActionKind, t: TFunction): string {
  if (kind === "rewrite") return t("chapterAction.submitRewrite");
  if (kind === "rewrite-in-place") return t("chapterAction.submitRewriteInPlace");
  if (kind === "resync") return t("chapterAction.submitResync");
  return t("chapterAction.submitRevise");
}

function actionPlaceholder(kind: ChapterActionKind, t: TFunction): string {
  if (kind === "rewrite") return t("chapterAction.placeholderRewrite");
  if (kind === "rewrite-in-place") return t("chapterAction.placeholderRewriteInPlace");
  if (kind === "resync") return t("chapterAction.placeholderResync");
  return t("chapterAction.placeholderRevise");
}

export function ChapterActionDialog({
  open,
  kind,
  chapterNumber,
  modeLabel,
  brief,
  running,
  t,
  onBriefChange,
  onSubmit,
  onCancel,
}: ChapterActionDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, running, onCancel]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === overlayRef.current && !running) onCancel();
      }}
    >
      <div className="w-full max-w-xl mx-4 rounded-3xl border border-border/50 bg-card shadow-2xl shadow-primary/15 overflow-hidden">
        <div className="px-6 pt-6 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${kind === "rewrite" ? "bg-destructive/10" : "bg-primary/10"}`}>
              <Sparkles size={18} className={kind === "rewrite" ? "text-destructive" : "text-primary"} />
            </div>
            <div>
              <h3 className="text-xl font-semibold">{actionTitle(kind, t)}</h3>
              <p className="text-xs text-muted-foreground">
                {t("chapterAction.chapterPrefix")} {chapterNumber}
                {modeLabel ? ` · ${modeLabel}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={running}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 pb-2">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {actionDescription(kind, t)}
          </p>
        </div>

        {kind === "rewrite" && (
          <div className="mx-6 mb-3 px-4 py-3 rounded-xl border border-destructive/30 bg-destructive/5">
            <p className="text-xs font-semibold text-destructive">{t("chapterAction.confirmRegenTitle")}</p>
            <p className="text-xs text-destructive/80 mt-1">{t("chapterAction.confirmRegenDesc")}</p>
          </div>
        )}

        <div className="px-6 pb-6 space-y-2">
          <label className="text-sm font-medium text-foreground">{t("chapterAction.briefLabel")}</label>
          <textarea
            rows={4}
            value={brief}
            onChange={(event) => onBriefChange(event.target.value)}
            placeholder={actionPlaceholder(kind, t)}
            className="w-full px-3 py-2 text-sm bg-secondary/40 border border-border/60 rounded-xl outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 resize-y placeholder:text-muted-foreground/55 transition-all"
          />
          <p className="text-xs text-muted-foreground">{t("chapterAction.briefHint")}</p>
        </div>

        <div className="px-6 pb-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={running}
            className="px-4 py-2.5 text-sm font-medium rounded-xl bg-secondary text-foreground hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={onSubmit}
            disabled={running}
            className={`flex items-center gap-2 px-5 py-2.5 text-sm font-bold rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg disabled:opacity-50 ${
              kind === "rewrite"
                ? "bg-destructive text-white shadow-destructive/20"
                : "bg-primary text-primary-foreground shadow-primary/20"
            }`}
          >
            {running ? <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" /> : <Sparkles size={14} />}
            {running ? t("common.loading") : actionSubmitLabel(kind, t)}
          </button>
        </div>
      </div>
    </div>
  );
}

