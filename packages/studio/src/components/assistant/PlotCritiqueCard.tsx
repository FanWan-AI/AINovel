/**
 * PlotCritiqueCard — displays plot critique results in the assistant conversation.
 */

export interface NextChapterOpportunity {
  readonly title: string;
  readonly why: string;
  readonly mustInclude: ReadonlyArray<string>;
  readonly risk: string;
  readonly payoff: string;
}

export interface PlotCritiqueCardPayload {
  readonly bookId: string;
  readonly chapterRange: { from: number; to: number };
  readonly strengths: ReadonlyArray<string>;
  readonly weaknesses: ReadonlyArray<string>;
  readonly stalePatterns: ReadonlyArray<string>;
  readonly nextChapterOpportunities: ReadonlyArray<NextChapterOpportunity>;
}

export function PlotCritiqueCard({ critique }: { readonly critique: PlotCritiqueCardPayload }) {
  return (
    <section className="mt-3 rounded-lg border border-border/70 bg-card/40 p-4" data-testid="plot-critique-card">
      <h3 className="text-sm font-semibold text-foreground mb-3">
        📊 剧情诊断 — 章节 {critique.chapterRange.from}~{critique.chapterRange.to}
      </h3>

      {critique.strengths.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-green-500 mb-1">✅ 优势</div>
          <ul className="space-y-0.5">
            {critique.strengths.map((s, i) => (
              <li key={i} className="text-sm text-foreground">• {s}</li>
            ))}
          </ul>
        </div>
      )}

      {critique.weaknesses.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-red-500 mb-1">❌ 问题</div>
          <ul className="space-y-0.5">
            {critique.weaknesses.map((w, i) => (
              <li key={i} className="text-sm text-foreground">• {w}</li>
            ))}
          </ul>
        </div>
      )}

      {critique.stalePatterns.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-yellow-500 mb-1">🔄 模式疲劳</div>
          <div className="flex flex-wrap gap-1">
            {critique.stalePatterns.map((p, i) => (
              <span key={i} className="rounded-full bg-yellow-500/10 border border-yellow-500/30 px-2 py-0.5 text-xs text-yellow-400">
                {p}
              </span>
            ))}
          </div>
        </div>
      )}

      {critique.nextChapterOpportunities.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border/50">
          <div className="text-xs font-medium text-primary mb-2">🎯 下一章机会</div>
          <div className="space-y-2">
            {critique.nextChapterOpportunities.map((opp, i) => (
              <div key={i} className="rounded-md border border-border/50 p-2">
                <div className="text-sm font-medium text-foreground">{opp.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{opp.why}</div>
                {opp.mustInclude.length > 0 && (
                  <div className="mt-1 text-xs text-green-400/80">
                    必须包含: {opp.mustInclude.join("、")}
                  </div>
                )}
                <div className="mt-1 flex gap-3 text-xs">
                  <span className="text-yellow-400/80">风险: {opp.risk}</span>
                  <span className="text-cyan-400/80">爽点: {opp.payoff}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
