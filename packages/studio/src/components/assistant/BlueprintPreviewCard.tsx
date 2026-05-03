/**
 * BlueprintPreviewCard — displays a ChapterBlueprint in the assistant conversation.
 * Shows opening hook, scene beats with conflict/turn/payoff, and ending hook.
 */

export interface BlueprintScene {
  readonly beat: string;
  readonly conflict: string;
  readonly informationGap?: string;
  readonly turn: string;
  readonly payoff: string;
  readonly cost: string;
}

export type BlueprintStatus = "draft" | "confirmed" | "edited";

const STATUS_LABEL: Record<BlueprintStatus, string> = {
  draft: "草稿",
  confirmed: "已确认",
  edited: "已编辑",
};

const STATUS_CLASS: Record<BlueprintStatus, string> = {
  draft: "bg-muted/60 text-muted-foreground",
  confirmed: "bg-green-500/10 text-green-600",
  edited: "bg-yellow-500/10 text-yellow-600",
};

export interface BlueprintPreviewPayload {
  readonly openingHook: string;
  readonly scenes: ReadonlyArray<BlueprintScene>;
  readonly payoffRequired: string;
  readonly endingHook: string;
  readonly contractSatisfaction: ReadonlyArray<string>;
  /** Stable artifact ID this blueprint was saved under. */
  readonly artifactId?: string;
  /** Lifecycle status of this blueprint draft. */
  readonly status?: BlueprintStatus;
  /** Incremented each time the blueprint is edited or confirmed. */
  readonly version?: number;
}

export function BlueprintPreviewCard({
  blueprint,
  onConfirm,
  onEdit,
}: {
  readonly blueprint: BlueprintPreviewPayload;
  /** Called when user clicks "确认蓝图". */
  readonly onConfirm?: () => void;
  /** Called when user clicks "编辑蓝图". */
  readonly onEdit?: () => void;
}) {
  const status = blueprint.status ?? "draft";
  const version = blueprint.version ?? 1;

  return (
    <section className="mt-3 rounded-lg border border-border/70 bg-card/40 p-4" data-testid="blueprint-preview-card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">🎭 章节蓝图预览</h3>
        <div className="flex items-center gap-1.5">
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full ${STATUS_CLASS[status]}`}
            data-testid="blueprint-status-badge"
          >
            {STATUS_LABEL[status]}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="blueprint-version">
            v{version}
          </span>
        </div>
      </div>

      <div className="mb-3 rounded-md bg-primary/5 p-2.5 border border-primary/10">
        <div className="text-xs font-medium text-primary mb-1">🎣 开场钩子</div>
        <div className="text-sm text-foreground">{blueprint.openingHook}</div>
      </div>

      <div className="space-y-2.5 mb-3">
        {blueprint.scenes.map((scene, i) => (
          <div key={i} className="rounded-md border border-border/50 p-2.5" data-testid={`blueprint-scene-${i}`}>
            <div className="text-xs font-medium text-muted-foreground mb-1.5">场景 {i + 1}</div>
            <div className="text-sm font-medium text-foreground mb-1">{scene.beat}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div>
                <span className="text-red-400">冲突:</span>
                <span className="ml-1 text-muted-foreground">{scene.conflict}</span>
              </div>
              <div>
                <span className="text-yellow-400">转折:</span>
                <span className="ml-1 text-muted-foreground">{scene.turn}</span>
              </div>
              <div>
                <span className="text-green-400">爽点:</span>
                <span className="ml-1 text-muted-foreground">{scene.payoff}</span>
              </div>
              <div>
                <span className="text-orange-400">代价:</span>
                <span className="ml-1 text-muted-foreground">{scene.cost}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-md bg-cyan-500/5 p-2.5 border border-cyan-500/10">
        <div className="text-xs font-medium text-cyan-400 mb-1">🪝 章尾钩子</div>
        <div className="text-sm text-foreground">{blueprint.endingHook}</div>
      </div>

      {blueprint.contractSatisfaction.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <div className="text-xs font-medium text-muted-foreground mb-1">契约满足计划</div>
          <ul className="space-y-0.5">
            {blueprint.contractSatisfaction.map((item, i) => (
              <li key={i} className="text-xs text-muted-foreground">• {item}</li>
            ))}
          </ul>
        </div>
      )}

      {(onConfirm || onEdit) && (
        <div className="mt-3 pt-3 border-t border-border/50 flex gap-2 justify-end">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="text-xs px-3 py-1.5 rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              data-testid="blueprint-edit-button"
            >
              ✏️ 编辑蓝图
            </button>
          )}
          {onConfirm && status !== "confirmed" && (
            <button
              type="button"
              onClick={onConfirm}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              data-testid="blueprint-confirm-button"
            >
              ✅ 确认蓝图
            </button>
          )}
        </div>
      )}
    </section>
  );
}
