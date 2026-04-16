export interface AssistantWorldConsistencyMarketReport {
  readonly bookId: string;
  readonly generatedAt: string;
  readonly consistency: {
    readonly blockingIssues: ReadonlyArray<{
      readonly issueId: string;
      readonly title: string;
      readonly description: string;
      readonly recommendation: string;
      readonly evidence: {
        readonly source: string;
        readonly line: number;
        readonly excerpt: string;
      };
    }>;
  };
  readonly market: {
    readonly summary: string;
    readonly signals: ReadonlyArray<{
      readonly signalId: string;
      readonly source: string;
      readonly timestamp: string;
      readonly trend: string;
      readonly recommendation: string;
      readonly confidence: number;
    }>;
  };
  readonly repairTasks: ReadonlyArray<{
    readonly stepId: string;
    readonly action: "revise";
    readonly mode: "spot-fix";
    readonly chapter: number;
    readonly objective: string;
  }>;
}

export function WorldConsistencyMarketCard({
  report,
  onRunRepairTask,
}: {
  readonly report: AssistantWorldConsistencyMarketReport;
  readonly onRunRepairTask: (stepId: string) => void;
}) {
  return (
    <section className="mt-3 rounded-xl border border-border/70 bg-card p-4 space-y-3" data-testid="assistant-world-market-card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">全书一致性报告 + 市场策略建议</div>
        <div className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {new Date(report.generatedAt).toLocaleString("zh-CN", { hour12: false })}
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium text-destructive">阻断问题</div>
        {report.consistency.blockingIssues.length === 0
          ? <div className="text-xs text-muted-foreground">未发现阻断问题。</div>
          : (
            <ul className="space-y-2 text-xs">
              {report.consistency.blockingIssues.map((issue) => (
                <li key={issue.issueId} className="rounded-md border border-destructive/30 px-2 py-2">
                  <div className="font-medium text-destructive/90">{issue.title}</div>
                  <div className="mt-1 text-muted-foreground">{issue.description}</div>
                  <div className="mt-1 text-foreground/80">{issue.recommendation}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {issue.evidence.source}:line:{issue.evidence.line}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium">市场信号</div>
        <div className="text-xs text-muted-foreground whitespace-pre-wrap">{report.market.summary}</div>
        <ul className="space-y-2 text-xs text-muted-foreground">
          {report.market.signals.map((signal) => (
            <li key={signal.signalId} className="rounded-md border border-border/50 px-2 py-2">
              <div className="font-medium text-foreground/90">{signal.trend}</div>
              <div className="mt-1">{signal.recommendation}</div>
              <div className="mt-1 font-mono text-[11px]">{signal.source} · {signal.timestamp}</div>
            </li>
          ))}
        </ul>
      </div>
      {report.repairTasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {report.repairTasks.map((task) => (
            <button
              key={task.stepId}
              onClick={() => onRunRepairTask(task.stepId)}
              className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:text-primary"
              data-testid="assistant-world-market-task-action"
              aria-label={`执行一致性修复任务 ${task.stepId}`}
            >
              修复任务：{task.stepId}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
