import { useState } from "react";
import { Lightbulb, Zap, AlertCircle } from "lucide-react";
import { fetchNextPlan, ApiError } from "../../hooks/use-api";
import type { NextPlanResult } from "../../hooks/use-api";
import type { TFunction } from "../../hooks/use-i18n";

export type { NextPlanResult };

// ---------------------------------------------------------------------------
// Pure helpers (exported for testability)
// ---------------------------------------------------------------------------

export type NextPlanErrorKind = "forbidden" | "rateLimit" | "serverError" | "unknown";

export function classifyNextPlanError(status: number | null): NextPlanErrorKind {
  if (status === 403) return "forbidden";
  if (status === 429) return "rateLimit";
  if (status === 500) return "serverError";
  return "unknown";
}

export function buildApplyBrief(plan: NextPlanResult): string {
  const parts: string[] = [];
  if (plan.goal) parts.push(plan.goal);
  if (plan.conflicts && plan.conflicts.length > 0) {
    parts.push(plan.conflicts.join("\n"));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NextPlanPanelProps {
  readonly bookId: string;
  readonly onApply: (plan: NextPlanResult) => void;
  readonly t: TFunction;
}

export function NextPlanPanel({ bookId, onApply, t }: NextPlanPanelProps) {
  const [plan, setPlan] = useState<NextPlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchNextPlan(bookId);
      setPlan(result);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null;
      const kind = classifyNextPlanError(status);
      if (e instanceof Error && kind === "unknown") {
        setError(e.message);
      } else {
        const kindMessages: Record<string, string> = {
          forbidden: "Access denied — check your API key or permissions.",
          rateLimit: "Rate limit reached. Please wait a moment and try again.",
          serverError: "Server error. Please try again later.",
        };
        setError(kindMessages[kind] ?? (e instanceof Error ? e.message : "Failed to fetch plan"));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
          <Lightbulb size={14} />
          {t("book.nextPlan")}
        </h2>
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50"
        >
          {loading
            ? <div className="w-3 h-3 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
            : <Lightbulb size={12} />}
          {t("book.generateNextPlan")}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/5 rounded-xl px-4 py-3 border border-destructive/20">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      )}

      {plan && !error && (
        <div className="space-y-4">
          <div className="text-xs font-mono text-muted-foreground">
            Ch.{plan.chapterNumber}
          </div>

          <div className="space-y-1">
            <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              {t("book.planGoal")}
            </div>
            <p className="text-sm leading-relaxed">{plan.goal}</p>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              {t("book.planConflicts")}
            </div>
            {plan.conflicts.length > 0 ? (
              <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
                {plan.conflicts.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">{t("book.planConflictsFallback")}</p>
            )}
          </div>

          <button
            onClick={() => onApply(plan)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20"
          >
            <Zap size={14} />
            {t("book.applyNextPlan")}
          </button>
        </div>
      )}

      {!plan && !error && !loading && (
        <p className="text-sm text-muted-foreground italic">{t("book.nextPlanHint")}</p>
      )}
    </div>
  );
}
