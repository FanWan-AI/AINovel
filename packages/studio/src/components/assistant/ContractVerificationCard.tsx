/**
 * ContractVerificationCard — displays contract verification results.
 * Shows each requirement with satisfied/partial/missing status and evidence,
 * plus optional graph patch consumption summary and warnings.
 */

import { BlueprintFulfillmentCard, type BlueprintFulfillmentReport } from "./BlueprintFulfillmentCard.js";

export interface VerificationItem {
  readonly requirement: string;
  readonly status: "satisfied" | "partial" | "missing";
  readonly evidence?: string;
  readonly reason: string;
}

export interface GraphPatchConsumptionEntry {
  readonly patchId: string;
  readonly status: "consumed" | "pending" | "partially_consumed";
  readonly reason: string;
  readonly satisfiedRequirements: ReadonlyArray<string>;
  readonly missingRequirements: ReadonlyArray<string>;
}

export interface GraphPatchConsumption {
  readonly patches: ReadonlyArray<GraphPatchConsumptionEntry>;
  readonly consumed: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
  readonly partiallyConsumed: ReadonlyArray<string>;
}

export interface VerificationReportPayload {
  /** When true, verification has not yet completed — do not access satisfactionRate/items/shouldRewrite. */
  readonly pending?: boolean;
  /** bookId associated with this pending/completed verification. */
  readonly bookId?: string;
  /** Chapter number associated with this pending/completed verification. */
  readonly chapterNumber?: number;
  readonly satisfactionRate?: number;
  readonly items?: ReadonlyArray<VerificationItem>;
  readonly shouldRewrite?: boolean;
  // Extended fields from server write-next verification (optional for backward compat)
  readonly contractSatisfaction?: number;
  readonly satisfiedRequirements?: ReadonlyArray<string>;
  readonly missingRequirements?: ReadonlyArray<string>;
  readonly sourceArtifactIds?: ReadonlyArray<string>;
  readonly graphPatchConsumption?: GraphPatchConsumption;
  readonly blueprintFulfillment?: BlueprintFulfillmentReport;
  readonly warning?: string;
}

const STATUS_ICONS: Record<string, string> = {
  satisfied: "✅",
  partial: "⚠️",
  missing: "❌",
};

const STATUS_STYLES: Record<string, string> = {
  satisfied: "border-green-500/30 bg-green-500/5",
  partial: "border-yellow-500/30 bg-yellow-500/5",
  missing: "border-red-500/30 bg-red-500/5",
};

export function ContractVerificationCard({ report }: { readonly report: VerificationReportPayload }) {
  // Handle pending state — verification has not yet completed
  if (report.pending === true) {
    return (
      <section className="mt-3 rounded-lg border border-border/70 bg-card/40 p-4" data-testid="contract-verification-card">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-foreground">🔍 契约验证报告</h3>
          <span className="text-xs text-muted-foreground">正在验证中…</span>
        </div>
        <p className="text-sm text-muted-foreground" data-testid="verification-pending">
          章节已生成，正在验证用户契约
          {report.chapterNumber !== undefined ? `（第${report.chapterNumber}章）` : ""}
        </p>
      </section>
    );
  }

  const satisfactionRate = report.satisfactionRate ?? 0;
  const items = report.items ?? [];
  const ratePercent = Math.round(satisfactionRate * 100);
  const rateColor = ratePercent >= 80 ? "text-green-400" : ratePercent >= 50 ? "text-yellow-400" : "text-red-400";
  const gpc = report.graphPatchConsumption;
  const hasGraphPatches = gpc && (
    (gpc.patches && gpc.patches.length > 0)
    || gpc.consumed.length > 0
    || gpc.pending.length > 0
    || (gpc.partiallyConsumed && gpc.partiallyConsumed.length > 0)
  );

  return (
    <section className="mt-3 rounded-lg border border-border/70 bg-card/40 p-4" data-testid="contract-verification-card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">🔍 契约验证报告</h3>
        <div className="flex items-center gap-2">
          <span className={`text-lg font-bold ${rateColor}`}>{ratePercent}%</span>
          {report.shouldRewrite === true && (
            <span className="rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-xs text-red-400">
              需要重写
            </span>
          )}
        </div>
      </div>

      {report.warning && (
        <div className="mb-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-xs text-yellow-400">
          ⚠️ {report.warning}
        </div>
      )}

      <div className="mb-3 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${ratePercent >= 80 ? "bg-green-500" : ratePercent >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
          style={{ width: `${ratePercent}%` }}
        />
      </div>

      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className={`rounded-md border p-2 ${STATUS_STYLES[item.status] ?? ""}`} data-testid={`verification-item-${i}`}>
            <div className="flex items-start gap-2">
              <span className="shrink-0 mt-0.5">{STATUS_ICONS[item.status]}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground">{item.requirement}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{item.reason}</div>
                {item.evidence && (
                  <div className="mt-1 text-xs text-muted-foreground/70 italic truncate">「{item.evidence}」</div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {hasGraphPatches && (
        <div className="mt-3 rounded-md border border-border/50 bg-muted/20 p-3" data-testid="graph-patch-consumption">
          <div className="text-xs font-medium text-muted-foreground mb-2">📊 知识图谱 Patch 消费情况</div>
          {gpc!.patches && gpc!.patches.length > 0
            ? gpc!.patches.map((entry) => (
              <div key={entry.patchId} className="mb-1 text-xs" data-testid={`patch-entry-${entry.status}`}>
                {entry.status === "consumed" && <span className="text-green-400">✅ {entry.patchId}: {entry.reason}</span>}
                {entry.status === "partially_consumed" && <span className="text-yellow-400">⚡ {entry.patchId}: {entry.reason}</span>}
                {entry.status === "pending" && <span className="text-muted-foreground">⏳ {entry.patchId}: {entry.reason}</span>}
              </div>
            ))
            : (
              <>
                {gpc!.consumed.length > 0 && (
                  <div className="text-xs text-green-400 mb-1">
                    ✅ 已消费 ({gpc!.consumed.length}): {gpc!.consumed.slice(0, 3).join(", ")}{gpc!.consumed.length > 3 ? " ..." : ""}
                  </div>
                )}
                {gpc!.partiallyConsumed && gpc!.partiallyConsumed.length > 0 && (
                  <div className="text-xs text-yellow-400 mb-1">
                    ⚡ 部分消费 ({gpc!.partiallyConsumed.length}): {gpc!.partiallyConsumed.slice(0, 3).join(", ")}{gpc!.partiallyConsumed.length > 3 ? " ..." : ""}
                  </div>
                )}
                {gpc!.pending.length > 0 && (
                  <div className="text-xs text-yellow-400">
                    ⏳ 待满足 ({gpc!.pending.length}): 需求未完全体现，将在下次写作中重试
                  </div>
                )}
              </>
            )
          }
        </div>
      )}

      {report.blueprintFulfillment && (
        <BlueprintFulfillmentCard report={report.blueprintFulfillment} />
      )}
    </section>
  );
}
