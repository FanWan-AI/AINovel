import { useMemo, useState } from "react";

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

export interface QualitySnapshot {
  readonly label: string;
  readonly score: number;
  readonly summaryParts: ReadonlyArray<string>;
  readonly actionItems: ReadonlyArray<string>;
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

function selectQualitySnapshotReport(report: QualityReportBundle): QualityReportPayload | null {
  return report.book ?? report.chapter ?? null;
}

function addUnique(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

export function buildQualitySnapshot(report: QualityReportPayload): QualitySnapshot {
  const score = normalizeQualityScore(report.overallScore);
  const summaryParts: string[] = [];
  const actionItems: string[] = [];
  const failedRunIssue = report.blockingIssues.find((issue) => /失败|failed|阻断/u.test(issue));
  const foreshadowing = normalizeQualityScore(report.dimensions.foreshadowing);
  const pacing = normalizeQualityScore(report.dimensions.pacing);
  const repetition = normalizeQualityScore(report.dimensions.repetition);
  const style = normalizeQualityScore(report.dimensions.style ?? report.dimensions.styleConsistency);
  const continuity = normalizeQualityScore(report.dimensions.continuity);

  if (foreshadowing > 0 && foreshadowing < 60) {
    addUnique(summaryParts, "伏笔积压");
    addUnique(actionItems, `伏笔积压：伏笔分 ${foreshadowing}，优先回收或关闭旧钩子。`);
  }
  if (failedRunIssue) {
    addUnique(summaryParts, "有失败运行");
    addUnique(actionItems, failedRunIssue);
  }
  if (pacing > 0 && pacing < 70) {
    addUnique(summaryParts, "节奏偏弱");
    addUnique(actionItems, `节奏偏弱：节奏分 ${pacing}，下一章需要明确推进或降调喘息。`);
  }
  if (repetition > 0 && repetition < 75) {
    addUnique(summaryParts, "重复风险");
    addUnique(actionItems, `重复风险：重复度 ${repetition}，换场景容器或动作模式。`);
  }
  if (style > 0 && style < 70) {
    addUnique(summaryParts, "风格需修");
    addUnique(actionItems, `风格需修：风格分 ${style}，优先处理疲劳词和句式重复。`);
  }
  if (continuity > 0 && continuity < 75) {
    addUnique(summaryParts, "连续性风险");
    addUnique(actionItems, `连续性风险：连续性 ${continuity}，检查时间线和人物动机。`);
  }

  for (const issue of report.blockingIssues) {
    if (actionItems.length >= 3) break;
    addUnique(actionItems, issue);
  }

  if (summaryParts.length === 0) {
    summaryParts.push(score >= 80 ? "状态稳定" : score >= 70 ? "轻微风险" : "需要关注");
  }
  if (actionItems.length === 0) {
    actionItems.push(score >= 80 ? "暂未发现需要立刻处理的问题。" : "总分偏低，建议先查看分数最低的维度。");
  }

  return {
    label: report.scopeType === "book" ? "全书健康" : "章节健康",
    score,
    summaryParts: summaryParts.slice(0, 3),
    actionItems: actionItems.slice(0, 3),
  };
}

export function QualityReportCard({
  report,
  suggestedNextActions: _suggestedNextActions,
  onRunNextAction: _onRunNextAction,
}: {
  report: QualityReportBundle;
  suggestedNextActions: ReadonlyArray<string>;
  onRunNextAction: (action: string) => void;
}) {
  const snapshotReport = useMemo(() => selectQualitySnapshotReport(report), [report]);
  const [expanded, setExpanded] = useState(false);
  if (!snapshotReport) {
    return null;
  }

  const snapshot = buildQualitySnapshot(snapshotReport);
  const dimensionRows = mapQualityDimensionRows(snapshotReport);
  const sourceRows = snapshotReport.evidence.slice(0, 3);
  const detailLabel = snapshotReport.scopeType === "book" ? "查看全书健康" : "查看健康详情";
  return (
    <section className="mt-3 rounded-xl border border-border/70 bg-card/70 px-3 py-2.5" data-testid="assistant-quality-report-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{snapshot.label}：{snapshot.score}</span>
          {snapshot.summaryParts.map((part) => (
            <span key={part} className="rounded-full border border-border/60 px-2 py-0.5">
              {part}
            </span>
          ))}
          {snapshotReport.cached && (
            <span className="text-[11px] text-muted-foreground/80" data-testid="assistant-quality-cache-badge">
              已复用 book memory 缓存
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
        >
          {expanded ? "收起" : detailLabel}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
          <div className="space-y-1">
            <div className="text-xs font-medium">优先处理</div>
            <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
              {snapshot.actionItems.map((issue, index) => (
                <li key={`${issue}-${index}`} className="rounded-md border border-border/50 px-2 py-1.5" data-testid="assistant-quality-blocking-issue">
                  {issue}
                </li>
              ))}
            </ul>
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
          {sourceRows.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium">依据来源</div>
              <ul className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-3">
                {sourceRows.map((evidence, index) => (
                  <li key={`${evidence.source}-${index}`} className="rounded-md border border-border/50 px-2 py-1.5" data-testid="assistant-quality-evidence">
                    <div className="truncate font-mono text-muted-foreground/80">{evidence.source}</div>
                    <div className="mt-0.5 line-clamp-2 italic">{evidence.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
