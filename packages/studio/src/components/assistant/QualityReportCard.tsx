export type QualityDimensionKey = "continuity" | "readability" | "styleConsistency" | "aiTraceRisk";

export interface QualityReportEvidence {
  readonly source: string;
  readonly excerpt: string;
  readonly reason: string;
}

export interface QualityReportPayload {
  readonly overallScore: number;
  readonly dimensions: Partial<Record<QualityDimensionKey, number>>;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<QualityReportEvidence>;
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
};

const QUALITY_DIMENSION_ORDER: ReadonlyArray<QualityDimensionKey> = [
  "continuity",
  "readability",
  "styleConsistency",
  "aiTraceRisk",
];

export function normalizeQualityScore(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

export function mapQualityDimensionRows(dimensions: Partial<Record<QualityDimensionKey, number>>): ReadonlyArray<QualityDimensionRow> {
  return QUALITY_DIMENSION_ORDER.map((key) => ({
    key,
    label: QUALITY_DIMENSION_LABELS[key],
    score: normalizeQualityScore(dimensions[key]),
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

export function QualityReportCard({
  report,
  suggestedNextActions,
  onRunNextAction,
}: {
  report: QualityReportPayload;
  suggestedNextActions: ReadonlyArray<string>;
  onRunNextAction: (action: string) => void;
}) {
  const dimensionRows = mapQualityDimensionRows(report.dimensions);
  const evidenceRows = resolveQualityEvidence(report.evidence);
  return (
    <section className="mt-3 rounded-xl border border-border/70 bg-card p-4 space-y-3" data-testid="assistant-quality-report-card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">质量评估报告</div>
        <div className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          总分 · {normalizeQualityScore(report.overallScore)}
        </div>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        {dimensionRows.map((dimension) => (
          <div key={dimension.key} className="rounded-md border border-border/50 px-2 py-1" data-testid="assistant-quality-dimension-row">
            {dimension.label}：{dimension.score}
          </div>
        ))}
      </div>
      {report.blockingIssues.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-destructive">阻断问题</div>
          <ul className="space-y-1 text-xs text-destructive/90">
            {report.blockingIssues.map((issue, index) => (
              <li key={`${issue}-${index}`} data-testid="assistant-quality-blocking-issue">• {issue}</li>
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
            >
              下一步：{action}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
