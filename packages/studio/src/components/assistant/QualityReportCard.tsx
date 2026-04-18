import { useEffect, useMemo, useState } from "react";

export type QualityReportScopeType = "chapter" | "book";
export type QualityDimensionKey =
  | "continuity"
  | "readability"
  | "styleConsistency"
  | "aiTraceRisk"
  | "mainline"
  | "character"
  | "foreshadowing"
  | "repetition"
  | "style"
  | "pacing";

export interface QualityReportEvidence {
  readonly source: string;
  readonly excerpt: string;
  readonly reason: string;
}

export interface QualityReportPayload {
  readonly scopeType: QualityReportScopeType;
  readonly overallScore: number;
  readonly dimensions: Partial<Record<QualityDimensionKey, number>>;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<QualityReportEvidence>;
  readonly cached?: boolean;
}

export interface QualityReportBundle {
  readonly chapter?: QualityReportPayload;
  readonly book?: QualityReportPayload;
}

export interface QualityDimensionRow {
  readonly key: QualityDimensionKey;
  readonly label: string;
  readonly score: number;
}

const QUALITY_DIMENSION_LABELS: Record<QualityDimensionKey, string> = {
  continuity: "连续性",
  readability: "可读性",
  styleConsistency: "风格一致性",
  aiTraceRisk: "AI 痕迹风险",
  mainline: "主线",
  character: "角色",
  foreshadowing: "伏笔",
  repetition: "重复度",
  style: "风格",
  pacing: "节奏",
};

const QUALITY_DIMENSION_ORDER: Record<QualityReportScopeType, ReadonlyArray<QualityDimensionKey>> = {
  chapter: [
    "continuity",
    "readability",
    "styleConsistency",
    "aiTraceRisk",
  ],
  book: [
    "mainline",
    "character",
    "foreshadowing",
    "repetition",
    "style",
    "pacing",
  ],
};

export function normalizeQualityScore(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

export function mapQualityDimensionRows(report: QualityReportPayload): ReadonlyArray<QualityDimensionRow> {
  return QUALITY_DIMENSION_ORDER[report.scopeType].map((key) => ({
    key,
    label: QUALITY_DIMENSION_LABELS[key],
    score: normalizeQualityScore(report.dimensions[key]),
  }));
}

export function resolveQualityEvidence(
  evidence: ReadonlyArray<QualityReportEvidence>,
): ReadonlyArray<QualityReportEvidence> {
  if (evidence.length > 0) return evidence;
  return [{
    source: "fallback:unknown",
    excerpt: "暂无可展示证据。",
    reason: "后端未返回证据，使用回退证据占位。",
  }];
}

export function resolveQualityReportTabs(report: QualityReportBundle): ReadonlyArray<{
  readonly scopeType: QualityReportScopeType;
  readonly label: string;
  readonly report: QualityReportPayload;
}> {
  return [
    ...(report.chapter ? [{ scopeType: "chapter" as const, label: "章节视图", report: report.chapter }] : []),
    ...(report.book ? [{ scopeType: "book" as const, label: "全书视图", report: report.book }] : []),
  ];
}

export function QualityReportCard({
  report,
  suggestedNextActions,
  onRunNextAction,
}: {
  report: QualityReportBundle;
  suggestedNextActions: ReadonlyArray<string>;
  onRunNextAction: (action: string) => void;
}) {
  const tabs = useMemo(() => resolveQualityReportTabs(report), [report]);
  const [activeScope, setActiveScope] = useState<QualityReportScopeType>(tabs[0]?.scopeType ?? "chapter");

  useEffect(() => {
    if (!tabs.some((tab) => tab.scopeType === activeScope)) {
      setActiveScope(tabs[0]?.scopeType ?? "chapter");
    }
  }, [activeScope, tabs]);

  const activeTab = tabs.find((tab) => tab.scopeType === activeScope) ?? tabs[0];
  if (!activeTab) {
    return null;
  }
  const activeReport = activeTab.report;

  const dimensionRows = mapQualityDimensionRows(activeReport);
  const evidenceRows = resolveQualityEvidence(activeReport.evidence);
  return (
    <section className="mt-3 rounded-xl border border-border/70 bg-card p-4 space-y-3" data-testid="assistant-quality-report-card">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1">
          <div className="text-sm font-medium">质量评估报告</div>
          {tabs.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              {tabs.map((tab) => (
                <button
                  key={tab.scopeType}
                  type="button"
                  onClick={() => setActiveScope(tab.scopeType)}
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                  data-testid="assistant-quality-scope-toggle"
                  aria-pressed={tab.scopeType === activeScope}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            总分 · {normalizeQualityScore(activeReport.overallScore)}
          </div>
          {activeReport.cached && (
            <div className="text-[11px] text-muted-foreground" data-testid="assistant-quality-cache-badge">
              已复用 book memory 缓存
            </div>
          )}
        </div>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        {dimensionRows.map((dimension) => (
          <div
            key={dimension.key}
            className="rounded-md border border-border/50 px-2 py-1"
            data-testid="assistant-quality-dimension-row"
            aria-label={`${dimension.label} ${dimension.score}`}
          >
            {dimension.label}：{dimension.score}
          </div>
        ))}
      </div>
      {activeReport.blockingIssues.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-destructive">阻断问题</div>
          <ul className="list-disc pl-4 space-y-1 text-xs text-destructive/90">
            {activeReport.blockingIssues.map((issue, index) => (
              <li key={`${issue}-${index}`} data-testid="assistant-quality-blocking-issue">{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1">
        <div className="text-xs font-medium">证据</div>
        <ul className="space-y-2 text-xs text-muted-foreground">
          {evidenceRows.map((evidence, index) => (
            <li key={`${evidence.source}-${index}`} className="rounded-md border border-border/50 px-2 py-2" data-testid="assistant-quality-evidence">
              <div className="font-mono text-[11px] text-foreground/80">{evidence.source}</div>
              <div className="mt-1">{evidence.excerpt}</div>
              <div className="mt-1 text-foreground/80">{evidence.reason}</div>
            </li>
          ))}
        </ul>
      </div>
      {suggestedNextActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {suggestedNextActions.map((action) => (
            <button
              key={action}
              onClick={() => onRunNextAction(action)}
              className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:text-primary"
              data-testid="assistant-quality-next-action"
              aria-label={`执行下一步动作 ${action}`}
            >
              下一步：{action}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
