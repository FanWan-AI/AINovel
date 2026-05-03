/**
 * BlueprintFulfillmentCard — displays the P4 chapter blueprint fulfillment
 * audit result so users can see whether the generated chapter actually
 * executed the confirmed ChapterBlueprint.
 */

export type SceneFulfillmentStatus = "satisfied" | "weak" | "missing";
export type HookFulfillmentStatus = "satisfied" | "weak" | "missing";

export interface SceneFulfillmentResult {
  readonly index: number;
  readonly beat: string;
  readonly conflict: string;
  readonly turn: string;
  readonly payoff: string;
  readonly cost: string;
  readonly status: SceneFulfillmentStatus;
  readonly evidence?: string;
  readonly missingFields: ReadonlyArray<string>;
}

export interface OpeningHookFulfillmentResult {
  readonly expected: string;
  readonly found?: string;
  readonly position: number;
  readonly withinFirst300Words: boolean;
  readonly status: HookFulfillmentStatus;
  readonly evidence?: string;
}

export interface EndingHookFulfillmentResult {
  readonly status: HookFulfillmentStatus;
  readonly evidence?: string;
  readonly nearChapterEnd: boolean;
}

export interface HookFulfillmentResult {
  readonly status: HookFulfillmentStatus;
  readonly evidence?: string;
}

export interface BlueprintFulfillmentReport {
  readonly score: number;
  readonly openingHook: OpeningHookFulfillmentResult;
  readonly scenes: ReadonlyArray<SceneFulfillmentResult>;
  readonly payoffRequired: HookFulfillmentResult;
  readonly endingHook: EndingHookFulfillmentResult;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly shouldRewrite: boolean;
}

const SCENE_STATUS_ICONS: Record<SceneFulfillmentStatus, string> = {
  satisfied: "✅",
  weak: "⚠️",
  missing: "❌",
};

const SCENE_STATUS_STYLES: Record<SceneFulfillmentStatus, string> = {
  satisfied: "border-green-500/30 bg-green-500/5",
  weak: "border-yellow-500/30 bg-yellow-500/5",
  missing: "border-red-500/30 bg-red-500/5",
};

const HOOK_STATUS_ICONS: Record<HookFulfillmentStatus, string> = {
  satisfied: "✅",
  weak: "⚠️",
  missing: "❌",
};

function SceneRow({ scene }: { readonly scene: SceneFulfillmentResult }) {
  return (
    <div
      className={`rounded-md border p-2 ${SCENE_STATUS_STYLES[scene.status]}`}
      data-testid={`blueprint-scene-${scene.index}`}
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5 text-sm">{SCENE_STATUS_ICONS[scene.status]}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-foreground truncate">{scene.beat}</div>
          {scene.missingFields.length > 0 && (
            <div className="text-xs text-muted-foreground mt-0.5">
              缺失字段: {scene.missingFields.join(", ")}
            </div>
          )}
          {scene.evidence && (
            <div className="mt-1 text-xs text-muted-foreground/70 italic truncate">
              「{scene.evidence}」
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function BlueprintFulfillmentCard({
  report,
}: {
  readonly report: BlueprintFulfillmentReport;
}) {
  const scoreColor =
    report.score >= 80
      ? "text-green-400"
      : report.score >= 50
        ? "text-yellow-400"
        : "text-red-400";

  const satisfiedCount = report.scenes.filter((s) => s.status === "satisfied").length;
  const weakCount = report.scenes.filter((s) => s.status === "weak").length;
  const missingCount = report.scenes.filter((s) => s.status === "missing").length;

  return (
    <section
      className="mt-3 rounded-lg border border-border/70 bg-card/40 p-4"
      data-testid="blueprint-fulfillment-card"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">📋 蓝图兑现审计</h3>
        <div className="flex items-center gap-2">
          <span className={`text-lg font-bold ${scoreColor}`} data-testid="blueprint-score">
            {report.score}分
          </span>
          {report.shouldRewrite && (
            <span className="rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-xs text-red-400" data-testid="blueprint-should-rewrite">
              建议重写
            </span>
          )}
        </div>
      </div>

      {/* Score bar */}
      <div className="mb-3 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            report.score >= 80 ? "bg-green-500" : report.score >= 50 ? "bg-yellow-500" : "bg-red-500"
          }`}
          style={{ width: `${report.score}%` }}
        />
      </div>

      {/* Hook summary row */}
      <div className="flex gap-3 mb-3 text-xs flex-wrap" data-testid="blueprint-hook-summary">
        <span>
          {HOOK_STATUS_ICONS[report.openingHook.status]} 开场钩
          {report.openingHook.status === "satisfied"
            ? "（前300字）"
            : report.openingHook.status === "weak"
              ? `（第${report.openingHook.position}字）`
              : "（缺失）"}
        </span>
        <span>
          {HOOK_STATUS_ICONS[report.payoffRequired.status]} 核心兑现
          {report.payoffRequired.status === "missing" ? "（缺失）" : ""}
        </span>
        <span>
          {HOOK_STATUS_ICONS[report.endingHook.status]} 章尾钩
          {report.endingHook.nearChapterEnd ? "（章尾✓）" : report.endingHook.status === "missing" ? "（缺失）" : "（位置偏前）"}
        </span>
      </div>

      {/* Scene stats */}
      <div className="flex gap-3 mb-3 text-xs" data-testid="blueprint-scene-stats">
        <span className="text-green-400">✅ 满足 {satisfiedCount}</span>
        <span className="text-yellow-400">⚠️ 不足 {weakCount}</span>
        <span className="text-red-400">❌ 缺失 {missingCount}</span>
      </div>

      {/* Scene details */}
      <div className="space-y-1.5 mb-3">
        {report.scenes.map((scene) => (
          <SceneRow key={scene.index} scene={scene} />
        ))}
      </div>

      {/* Blocking issues */}
      {report.blockingIssues.length > 0 && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2" data-testid="blueprint-blocking-issues">
          <div className="text-xs font-medium text-red-400 mb-1">🚫 阻塞问题</div>
          <ul className="space-y-0.5">
            {report.blockingIssues.map((issue, i) => (
              <li key={i} className="text-xs text-red-400/90">• {issue}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
