/**
 * EditorReportCard — displays developmental editor quality scores.
 * P5 addition: P5RevisionCard shows the targeted blueprint revision result.
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

// ── P5 types (subset of core BlueprintEditorReport) ────────────────────

export interface P5RewriteInstruction {
  readonly element: string;
  readonly issue: string;
  readonly required: string;
  readonly instruction: string;
}

export interface P5RewritePlan {
  readonly instructions: ReadonlyArray<P5RewriteInstruction>;
  readonly fixCount: number;
  readonly summary: string;
}

export interface P5EditorReport {
  readonly targetedRewritePlan: P5RewritePlan;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly shouldRewrite: boolean;
}

export interface P5RevisedFulfillment {
  readonly score: number;
  readonly shouldRewrite: boolean;
  readonly blockingIssues: ReadonlyArray<string>;
}

export interface P5AutoRevisionPayload {
  readonly editorReport?: P5EditorReport;
  readonly appliedFixes?: ReadonlyArray<string>;
  readonly revisedBlueprintFulfillment?: P5RevisedFulfillment;
  /** runId of the created candidate chapter-run (absent only when status is "failed"). */
  readonly runId?: string;
  /**
   * "candidate_pending_approval" — candidate created, waiting for user approval.
   * "still-failing" — candidate created but re-audit still shows blueprint/contract issues.
   * "failed" — LLM error; no candidate was created.
   */
  readonly status: "candidate_pending_approval" | "still-failing" | "failed";
  /** Error message when status is "failed". */
  readonly error?: string;
  /** Result of re-running contract verification on the revised text. */
  readonly contractVerificationAfter?: {
    readonly satisfactionRate: number;
    readonly shouldRewrite: boolean;
    readonly missingRequirements: ReadonlyArray<string>;
  };
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

// ── P5RevisionCard ──────────────────────────────────────────────────────

const ELEMENT_LABELS: Record<string, string> = {
  openingHook: "开篇钩子",
  payoffRequired: "爽点兑现",
  endingHook: "结尾钩子",
};

function elementLabel(element: string): string {
  if (ELEMENT_LABELS[element]) return ELEMENT_LABELS[element]!;
  const sceneMatch = element.match(/^scene-(\d+)$/);
  if (sceneMatch) return `场景 ${sceneMatch[1]}`;
  return element;
}

/**
 * P5RevisionCard — shows the result of the P5 auto-revision loop.
 * Displayed when write-next:verification includes a p5AutoRevision payload.
 */
export function P5RevisionCard({ revision }: { readonly revision: P5AutoRevisionPayload }) {
  const { editorReport, appliedFixes, revisedBlueprintFulfillment, status, runId, error } = revision;
  const plan = editorReport?.targetedRewritePlan;
  const isPending = status === "candidate_pending_approval";
  const isStillFailing = status === "still-failing";
  const isFailed = status === "failed";

  const borderClass = isFailed
    ? "border-red-500/30 bg-red-500/5"
    : isPending
      ? "border-blue-500/30 bg-blue-500/5"
      : "border-yellow-500/30 bg-yellow-500/5";

  const titleText = isFailed
    ? "❌ 蓝图定点修订失败"
    : isPending
      ? "🔖 蓝图定点修订候选（待批准）"
      : "⚠️ 蓝图定点修订候选（仍需复核）";

  return (
    <section
      className={`mt-3 rounded-lg border p-4 ${borderClass}`}
      data-testid="p5-revision-card"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">{titleText}</h3>
        {revisedBlueprintFulfillment && (
          <span className={`text-sm font-bold ${revisedBlueprintFulfillment.score >= 70 ? "text-green-400" : "text-yellow-400"}`}>
            score: {revisedBlueprintFulfillment.score}
          </span>
        )}
      </div>

      {/* Error message for failed status */}
      {isFailed && error && (
        <div className="mb-3 rounded-md bg-red-500/5 border border-red-500/10 p-2">
          <div className="text-xs font-medium text-red-400 mb-1">错误详情</div>
          <p className="text-xs text-foreground">{error}</p>
        </div>
      )}

      {/* Pending-approval notice with runId */}
      {!isFailed && runId && (
        <div className="mb-3 rounded-md bg-card/60 border border-border/50 p-2 text-xs text-muted-foreground">
          {isPending
            ? "已生成蓝图定点修订候选，请前往章节任务中心查看 diff 并批准。"
            : "修订候选仍存在蓝图问题，你仍可前往章节任务中心查看并决定是否批准。"}
          <span className="ml-1 font-mono text-[10px] opacity-60">run:{runId.slice(0, 8)}</span>
        </div>
      )}

      {/* What was fixed */}
      {plan && plan.fixCount > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-muted-foreground mb-1">🎯 修复目标（{plan.fixCount} 处）</div>
          <div className="flex flex-wrap gap-1">
            {plan.instructions.map((inst) => (
              <span
                key={inst.element}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted/60 text-foreground"
              >
                {elementLabel(inst.element)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Applied fixes */}
      {appliedFixes && appliedFixes.length > 0 && (
        <div className="mb-3 rounded-md bg-card/60 border border-border/50 p-2">
          <div className="text-xs font-medium text-foreground mb-1">🔧 已应用修复</div>
          <ul className="space-y-0.5">
            {appliedFixes.map((fix, i) => (
              <li key={i} className="text-xs text-muted-foreground">• {fix}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Still-failing blocking issues */}
      {isStillFailing && revisedBlueprintFulfillment && revisedBlueprintFulfillment.blockingIssues.length > 0 && (
        <div className="rounded-md bg-yellow-500/5 border border-yellow-500/10 p-2">
          <div className="text-xs font-medium text-yellow-400 mb-1">⚠️ 修订后仍存在的问题</div>
          <ul className="space-y-0.5">
            {revisedBlueprintFulfillment.blockingIssues.map((issue, i) => (
              <li key={i} className="text-xs text-foreground">• {issue}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
