import type { TFunction } from "../../hooks/use-i18n";

export interface PlanBudgetPreviewInput {
  readonly perBookChapterCap: string;
  readonly globalChapterCap: string;
  readonly concurrency: string;
  readonly targetBookCount: number;
}

export interface PlanBudgetPreview {
  readonly perBookCap: number | null;
  readonly globalCap: number | null;
  readonly concurrency: number | null;
  readonly targetBookCount: number;
  readonly estimatedTotalChapters: number | null;
  readonly estimatedRounds: number | null;
}

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function derivePlanBudgetPreview(input: PlanBudgetPreviewInput): PlanBudgetPreview {
  const perBookCap = parsePositiveInt(input.perBookChapterCap);
  const globalCap = parsePositiveInt(input.globalChapterCap);
  const concurrency = parsePositiveInt(input.concurrency);
  const targetBookCount = Math.max(0, input.targetBookCount);

  if (perBookCap === null || globalCap === null || concurrency === null || targetBookCount === 0) {
    return {
      perBookCap,
      globalCap,
      concurrency,
      targetBookCount,
      estimatedTotalChapters: null,
      estimatedRounds: null,
    };
  }

  const estimatedTotalChapters = Math.min(globalCap, perBookCap * targetBookCount);
  const estimatedRounds = Math.ceil(estimatedTotalChapters / concurrency);
  return {
    perBookCap,
    globalCap,
    concurrency,
    targetBookCount,
    estimatedTotalChapters,
    estimatedRounds,
  };
}

export function PlanBudgetCard({
  t,
  perBookChapterCap,
  globalChapterCap,
  concurrency,
  targetBookCount,
}: {
  readonly t: TFunction;
  readonly perBookChapterCap: string;
  readonly globalChapterCap: string;
  readonly concurrency: string;
  readonly targetBookCount: number;
}) {
  const preview = derivePlanBudgetPreview({ perBookChapterCap, globalChapterCap, concurrency, targetBookCount });

  return (
    <div className="rounded-md border border-border/70 p-3 space-y-2 sm:col-span-2 lg:col-span-3">
      <div className="text-xs font-medium text-muted-foreground">{t("rc.budgetTitle")}</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
        <div>
          <div className="text-muted-foreground">{t("rc.perBookCap")}</div>
          <div className="font-medium">{preview.perBookCap ?? "—"}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t("rc.globalCap")}</div>
          <div className="font-medium">{preview.globalCap ?? "—"}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t("rc.budgetTargetBooks")}</div>
          <div className="font-medium">{targetBookCount}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t("rc.maxConcurrency")}</div>
          <div className="font-medium">{preview.concurrency ?? "—"}</div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {preview.estimatedTotalChapters === null || preview.estimatedRounds === null
          ? t("rc.budgetEstimatePending")
          : `${t("rc.budgetEstimatedTotal")}: ${preview.estimatedTotalChapters} · ${t("rc.budgetEstimatedRounds")}: ${preview.estimatedRounds}`}
      </div>
    </div>
  );
}
