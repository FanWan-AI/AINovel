/**
 * ContractCard — displays a ChapterSteeringContract in the assistant conversation.
 * Shows goal, mustInclude, mustAvoid, sceneBeats, priority, and source artifacts.
 */

export interface ContractCardPayload {
  readonly goal?: string;
  readonly mustInclude: ReadonlyArray<string>;
  readonly mustAvoid: ReadonlyArray<string>;
  readonly sceneBeats: ReadonlyArray<string>;
  readonly payoffRequired?: string;
  readonly endingHook?: string;
  readonly priority: "soft" | "normal" | "hard";
  readonly sourceArtifactIds: ReadonlyArray<string>;
  readonly rawRequest: string;
}

const PRIORITY_STYLES: Record<string, string> = {
  soft: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  normal: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  hard: "bg-red-500/10 text-red-400 border-red-500/30",
};

const PRIORITY_LABELS: Record<string, string> = {
  soft: "软约束",
  normal: "普通",
  hard: "硬约束",
};

export function ContractCard({ contract }: { readonly contract: ContractCardPayload }) {
  return (
    <section className="mt-3 rounded-lg border border-border/70 bg-card/40 p-4" data-testid="contract-card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">📋 下一章契约</h3>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[contract.priority] ?? PRIORITY_STYLES.normal}`}>
          {PRIORITY_LABELS[contract.priority] ?? contract.priority}
        </span>
      </div>

      {contract.goal && (
        <div className="mb-3">
          <div className="text-xs font-medium text-muted-foreground mb-1">🎯 目标</div>
          <div className="text-sm text-foreground">{contract.goal}</div>
        </div>
      )}

      {contract.mustInclude.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-green-500 mb-1">✅ 必须包含 ({contract.mustInclude.length})</div>
          <ul className="space-y-1">
            {contract.mustInclude.map((item, i) => (
              <li key={i} className="text-sm text-foreground pl-3 border-l-2 border-green-500/30">{item}</li>
            ))}
          </ul>
        </div>
      )}

      {contract.mustAvoid.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-red-500 mb-1">🚫 必须避免 ({contract.mustAvoid.length})</div>
          <ul className="space-y-1">
            {contract.mustAvoid.map((item, i) => (
              <li key={i} className="text-sm text-foreground pl-3 border-l-2 border-red-500/30">{item}</li>
            ))}
          </ul>
        </div>
      )}

      {contract.sceneBeats.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-purple-500 mb-1">🎬 场景节拍 ({contract.sceneBeats.length})</div>
          <ol className="space-y-1">
            {contract.sceneBeats.map((beat, i) => (
              <li key={i} className="text-sm text-foreground pl-3 border-l-2 border-purple-500/30">
                <span className="text-muted-foreground mr-1">{i + 1}.</span>{beat}
              </li>
            ))}
          </ol>
        </div>
      )}

      {contract.payoffRequired && (
        <div className="mb-3">
          <div className="text-xs font-medium text-yellow-500 mb-1">⚡ 必须兑现</div>
          <div className="text-sm text-foreground">{contract.payoffRequired}</div>
        </div>
      )}

      {contract.endingHook && (
        <div className="mb-3">
          <div className="text-xs font-medium text-cyan-500 mb-1">🪝 章尾钩子</div>
          <div className="text-sm text-foreground">{contract.endingHook}</div>
        </div>
      )}

      {contract.sourceArtifactIds.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <div className="text-xs text-muted-foreground">
            引用来源: {contract.sourceArtifactIds.map((id) => (
              <code key={id} className="ml-1 px-1 py-0.5 rounded bg-muted text-xs">{id.slice(0, 12)}</code>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
