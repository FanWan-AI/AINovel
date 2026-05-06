import { useEffect, useRef, useState } from "react";
import { X, Zap, Lightbulb, AlertCircle } from "lucide-react";
import type { TFunction } from "../../hooks/use-i18n";
import { fetchNextPlan, ApiError } from "../../hooks/use-api";
import type { NextPlanResult } from "../../hooks/use-api";

export interface WriteNextFormState {
  readonly chapterGoal: string;
  readonly mustInclude: string;
  readonly avoidElements: string;
  readonly pacing: string;
  readonly wordCount: string;
}

export const INITIAL_WRITE_NEXT_FORM: WriteNextFormState = {
  chapterGoal: "",
  mustInclude: "",
  avoidElements: "",
  pacing: "",
  wordCount: "",
};

export interface WriteNextPayload {
  readonly mode?: "ai-plan" | "manual-plan" | "quick";
  readonly chapterCount?: number;
  readonly chapterGoal?: string;
  readonly mustInclude?: string[];
  readonly mustAvoid?: string[];
  readonly pace?: "slow" | "balanced" | "fast";
  readonly wordCount?: number;
}

function splitLinesToArray(value: string): string[] {
  return value
    .split(/\r?\n|,|，|;/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizePace(value: string): "slow" | "balanced" | "fast" | undefined {
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;
  if (["slow", "慢", "慢节奏", "舒缓", "缓慢"].includes(raw)) return "slow";
  if (["fast", "快", "快节奏", "紧张"].includes(raw)) return "fast";
  if (["balanced", "中", "中等", "均衡", "平衡"].includes(raw)) return "balanced";
  return undefined;
}

/** Assembles a lean API payload from raw form state; omits blank fields. */
export function buildWriteNextPayload(form: WriteNextFormState): WriteNextPayload {
  const payload: {
    chapterGoal?: string;
    mustInclude?: string[];
    mustAvoid?: string[];
    pace?: "slow" | "balanced" | "fast";
    wordCount?: number;
  } = {};
  if (form.chapterGoal.trim()) payload.chapterGoal = form.chapterGoal.trim();
  const mustInclude = splitLinesToArray(form.mustInclude);
  if (mustInclude.length > 0) payload.mustInclude = mustInclude;
  const mustAvoid = splitLinesToArray(form.avoidElements);
  if (mustAvoid.length > 0) payload.mustAvoid = mustAvoid;
  const pace = normalizePace(form.pacing);
  if (pace) payload.pace = pace;
  const wc = parseInt(form.wordCount, 10);
  if (!isNaN(wc) && wc > 0) payload.wordCount = wc;
  return payload as WriteNextPayload;
}

export type PlanningTab = "ai" | "manual";

/** Converts an AI-generated NextPlanResult into a WriteNextPayload for the write-next API. */
export function buildPlanPayloadFromNextPlan(plan: NextPlanResult): WriteNextPayload {
  const payload: {
    chapterGoal?: string;
    mustInclude?: string[];
  } = {};
  if (plan.goal.trim()) payload.chapterGoal = plan.goal.trim();
  const conflicts = plan.conflicts.filter((c) => c.trim());
  if (conflicts.length > 0) payload.mustInclude = conflicts;
  return payload as WriteNextPayload;
}

/**
 * Converts an AI-generated NextPlanResult into an editable WriteNextFormState.
 * Used by "Adopt Suggestion" to pre-fill the manual planning form.
 *
 * Mapping:
 *   plan.goal      → chapterGoal
 *   plan.conflicts → mustInclude  (one item per line)
 *   avoidElements  → "" (left blank for user to fill)
 *   pacing         → "" (left blank for user to fill)
 *   wordCount      → preserved from the optional defaultWordCount
 */
export function applyPlanToFormState(
  plan: NextPlanResult,
  defaultWordCount?: number,
): WriteNextFormState {
  return {
    chapterGoal: plan.goal.trim(),
    mustInclude: plan.conflicts.filter((c) => c.trim()).join("\n"),
    avoidElements: "",
    pacing: "",
    wordCount: defaultWordCount ? String(defaultWordCount) : "",
  };
}

interface WriteNextDialogProps {
  readonly open: boolean;
  readonly defaultWordCount?: number;
  readonly initialForm?: Partial<WriteNextFormState>;
  readonly t: TFunction;
  readonly onSubmit: (payload: WriteNextPayload) => void;
  readonly onCancel: () => void;
  readonly bookId: string;
}

export function WriteNextDialog({
  open,
  defaultWordCount,
  initialForm,
  t,
  onSubmit,
  onCancel,
  bookId,
}: WriteNextDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<PlanningTab>("ai");
  const [aiPlan, setAiPlan] = useState<NextPlanResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [form, setForm] = useState<WriteNextFormState>({
    ...INITIAL_WRITE_NEXT_FORM,
    wordCount: defaultWordCount ? String(defaultWordCount) : "",
    ...initialForm,
  });

  // Reset form and AI state whenever the dialog opens
  useEffect(() => {
    if (open) {
      setActiveTab("ai");
      setAiPlan(null);
      setAiError(null);
      setAiLoading(false);
      setForm({
        ...INITIAL_WRITE_NEXT_FORM,
        wordCount: defaultWordCount ? String(defaultWordCount) : "",
        ...initialForm,
      });
    }
  }, [open, defaultWordCount, initialForm]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const set = (field: keyof WriteNextFormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ ...buildWriteNextPayload(form), mode: "manual-plan" });
  };

  const handleGeneratePlan = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const result = await fetchNextPlan(bookId);
      setAiPlan(result);
    } catch (e) {
      const msg = e instanceof ApiError
        ? `${e.message} (${e.status})`
        : (e instanceof Error ? e.message : t("writeNext.planError"));
      setAiError(msg);
    } finally {
      setAiLoading(false);
    }
  };

  const handleApplyPlan = () => {
    if (!aiPlan) return;
    setForm(applyPlanToFormState(aiPlan, defaultWordCount));
    setActiveTab("manual");
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm fade-in"
      onClick={(e) => { if (e.target === overlayRef.current) onCancel(); }}
    >
      <div className="bg-card border border-border rounded-2xl shadow-2xl shadow-primary/10 w-full max-w-lg mx-4 overflow-hidden chat-msg-assistant">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Zap size={20} className="text-primary" />
            </div>
            <h3 className="text-lg font-semibold">{t("book.planNextAndWrite")}</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 px-6 pt-2 pb-0">
          <button
            type="button"
            onClick={() => setActiveTab("ai")}
            className={`px-4 py-1.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${
              activeTab === "ai"
                ? "border-primary text-primary bg-primary/5"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("writeNext.tabAI")}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("manual")}
            className={`px-4 py-1.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${
              activeTab === "manual"
                ? "border-primary text-primary bg-primary/5"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("writeNext.tabManual")}
          </button>
        </div>
        <div className="border-t border-border/40 mx-6" />

        {/* AI Suggestions tab */}
        {activeTab === "ai" && (
          <div className="px-6 py-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{t("writeNext.planHint")}</p>
              <button
                type="button"
                onClick={handleGeneratePlan}
                disabled={aiLoading}
                className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50 shrink-0"
              >
                {aiLoading
                  ? <div className="w-3 h-3 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                  : <Lightbulb size={12} />}
                {t("writeNext.generatePlan")}
              </button>
            </div>
            {aiError && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/5 rounded-xl px-4 py-3 border border-destructive/20">
                <AlertCircle size={14} className="shrink-0" />
                {aiError}
              </div>
            )}
            {aiPlan && !aiError && (
              <div className="space-y-3 rounded-xl border border-border/40 bg-secondary/20 p-4">
                <div className="text-xs font-mono text-muted-foreground">Ch.{aiPlan.chapterNumber}</div>
                <div className="space-y-1">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.planGoal")}</div>
                  <p className="text-sm leading-relaxed">{aiPlan.goal}</p>
                </div>
                {aiPlan.conflicts.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.planConflicts")}</div>
                    <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
                      {aiPlan.conflicts.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {aiPlan && !aiError && (
              <p className="text-xs text-muted-foreground">{t("writeNext.applyPlanHint")}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2.5 text-sm font-medium rounded-xl bg-secondary text-foreground hover:bg-secondary/80 transition-all border border-border/50"
              >
                {t("writeNext.cancel")}
              </button>
              <button
                type="button"
                onClick={handleApplyPlan}
                disabled={!aiPlan || aiLoading}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
              >
                <Zap size={14} />
                {t("writeNext.applyPlan")}
              </button>
            </div>
          </div>
        )}

        {/* Manual Plan tab */}
        {activeTab === "manual" && (
          <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            {/* Chapter Goal */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {t("writeNext.chapterGoal")}
              </label>
              <textarea
                value={form.chapterGoal}
                onChange={set("chapterGoal")}
                placeholder={t("writeNext.chapterGoalPlaceholder")}
                rows={2}
                className="w-full px-3 py-2 text-sm bg-secondary/40 border border-border/60 rounded-xl outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 resize-none placeholder:text-muted-foreground/50 transition-all"
              />
            </div>

            {/* Must Include */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {t("writeNext.mustInclude")}
              </label>
              <textarea
                value={form.mustInclude}
                onChange={set("mustInclude")}
                placeholder={t("writeNext.mustIncludePlaceholder")}
                rows={2}
                className="w-full px-3 py-2 text-sm bg-secondary/40 border border-border/60 rounded-xl outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 resize-none placeholder:text-muted-foreground/50 transition-all"
              />
            </div>

            {/* Avoid Elements */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {t("writeNext.avoidElements")}
              </label>
              <textarea
                value={form.avoidElements}
                onChange={set("avoidElements")}
                placeholder={t("writeNext.avoidElementsPlaceholder")}
                rows={2}
                className="w-full px-3 py-2 text-sm bg-secondary/40 border border-border/60 rounded-xl outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 resize-none placeholder:text-muted-foreground/50 transition-all"
              />
            </div>

            {/* Pacing & Word Count row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  {t("writeNext.pacing")}
                </label>
                <input
                  type="text"
                  value={form.pacing}
                  onChange={set("pacing")}
                  placeholder={t("writeNext.pacingPlaceholder")}
                  className="w-full px-3 py-2 text-sm bg-secondary/40 border border-border/60 rounded-xl outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 placeholder:text-muted-foreground/50 transition-all"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  {t("writeNext.wordCount")}
                </label>
                <input
                  type="number"
                  min={100}
                  step={100}
                  value={form.wordCount}
                  onChange={set("wordCount")}
                  placeholder={t("writeNext.wordCountPlaceholder")}
                  className="w-full px-3 py-2 text-sm bg-secondary/40 border border-border/60 rounded-xl outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 placeholder:text-muted-foreground/50 transition-all"
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-6 pb-6">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2.5 text-sm font-medium rounded-xl bg-secondary text-foreground hover:bg-secondary/80 transition-all border border-border/50"
            >
              {t("writeNext.cancel")}
            </button>
            <button
              type="submit"
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20"
            >
              <Zap size={14} />
              {t("writeNext.submit")}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
