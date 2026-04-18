import type { AssistantCandidateSelection } from "../../pages/AssistantView";

export function CandidateComparisonCard({
  selection,
  disabled = false,
  onSelectCandidate,
}: {
  readonly selection: AssistantCandidateSelection;
  readonly disabled?: boolean;
  readonly onSelectCandidate: (nodeId: string, candidateId: string) => void;
}) {
  return (
    <section className="mt-3 rounded-xl border border-border/70 bg-card p-4 space-y-3" data-testid="assistant-candidate-comparison-card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">候选对比</div>
        <div className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {selection.mode === "manual" ? "人工投票" : "自动投票"}
        </div>
      </div>
      <div className="grid gap-2">
        {selection.candidates.map((candidate) => {
          const isWinner = selection.winnerCandidateId === candidate.candidateId;
          return (
            <div
              key={candidate.candidateId}
              className="rounded-lg border border-border/60 px-3 py-3 text-xs space-y-2"
              data-testid="assistant-candidate-row"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-foreground">{candidate.candidateId}</div>
                <div className="text-muted-foreground">
                  分数 {candidate.score}
                  {isWinner ? " · winner" : ""}
                </div>
              </div>
              <div className="text-muted-foreground">{candidate.excerpt}</div>
              <div className="text-muted-foreground">
                状态：{candidate.status}
                {candidate.decision ? ` · 决策：${candidate.decision}` : ""}
              </div>
              {candidate.evidence[0] && (
                <div className="rounded-md border border-border/50 px-2 py-2 text-muted-foreground">
                  <div className="font-mono text-[11px] text-foreground/80">{candidate.evidence[0].source}</div>
                  <div className="mt-1">{candidate.evidence[0].excerpt}</div>
                  <div className="mt-1 text-foreground/80">{candidate.evidence[0].reason}</div>
                </div>
              )}
              {selection.mode === "manual" && selection.status === "pending" && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelectCandidate(selection.nodeId, candidate.candidateId)}
                  className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:text-primary disabled:opacity-60"
                  data-testid={`assistant-candidate-select-${candidate.candidateId}`}
                >
                  选择此候选
                </button>
              )}
            </div>
          );
        })}
      </div>
      {selection.winnerCandidateId && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground" data-testid="assistant-candidate-winner">
          winner：{selection.winnerCandidateId}
          {selection.winnerScore !== undefined ? ` · 分数 ${selection.winnerScore}` : ""}
          {selection.winnerReason ? ` · ${selection.winnerReason}` : ""}
        </div>
      )}
    </section>
  );
}
