/**
 * EditorReportCard — displays developmental editor quality scores.
 */

export interface EditorDimensionPayload {
  readonly conflict: number;
  readonly agency: number;
  readonly payoff: number;
  readonly relationshipMovement: number;
  readonly hook: number;
  readonly proseFreshness: number;
  readonly contractSatisfaction: number;
}

export interface EditorReportPayload {
  readonly overallScore: number;
  readonly dimensions: EditorDimensionPayload;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly rewriteAdvice: ReadonlyArray<string>;
}

const DIMENSION_LABELS: Record<string, string> = {
  conflict: "冲突强度",
  agency: "主角主动性",
  payoff: "爽点兑现",
  relationshipMovement: "关系推进",
  hook: "读者钩子",
  proseFreshness: "文笔鲜活度",
  contractSatisfaction: "契约满足率",
};

function ScoreBar({ label, score }: { readonly label: string; readonly score: number }) {
  const pct = Math.round(score * 10);
  const color = score >= 7 ? "bg-green-500" : score >= 4 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-6 text-right font-medium text-foreground">{score}</span>
    </div>
  );
}

export function EditorReportCard({ report }: { readonly report: EditorReportPayload }) {
  return (
    <section className="mt-3 rounded-lg border border-border/70 bg-card/40 p-4" data-testid="editor-report-card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">📝 章节质量评估</h3>
        <span className={`text-lg font-bold ${report.overallScore >= 7 ? "text-green-400" : report.overallScore >= 4 ? "text-yellow-400" : "text-red-400"}`}>
          {report.overallScore}
        </span>
      </div>

      <div className="space-y-1.5 mb-3">
        {Object.entries(DIMENSION_LABELS).map(([key, label]) => (
          <ScoreBar key={key} label={label} score={report.dimensions[key as keyof EditorDimensionPayload]} />
        ))}
      </div>

      {report.blockingIssues.length > 0 && (
        <div className="mb-3 rounded-md bg-red-500/5 border border-red-500/10 p-2">
          <div className="text-xs font-medium text-red-400 mb-1">🚨 阻断性问题</div>
          <ul className="space-y-0.5">
            {report.blockingIssues.map((issue, i) => (
              <li key={i} className="text-xs text-foreground">• {issue}</li>
            ))}
          </ul>
        </div>
      )}

      {report.rewriteAdvice.length > 0 && (
        <div className="rounded-md bg-yellow-500/5 border border-yellow-500/10 p-2">
          <div className="text-xs font-medium text-yellow-400 mb-1">💡 改进建议</div>
          <ul className="space-y-0.5">
            {report.rewriteAdvice.map((advice, i) => (
              <li key={i} className="text-xs text-foreground">• {advice}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
