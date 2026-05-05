/**
 * DevelopmentalEditorAgent — P5 blueprint-aware developmental editor.
 *
 * Analyses a BlueprintFulfillmentReport and generates a TargetedRewritePlan
 * that specifies only the failed/weak elements, with explicit repair instructions.
 *
 * This is a pure heuristic function (no LLM needed). The plan is fed into
 * TargetedBlueprintReviser for the actual LLM revision.
 *
 * Key invariant: only confirmed blueprints ever reach this function.
 * Callers must validate blueprint.status === "confirmed" before calling.
 */

import type { ChapterBlueprint } from "../models/input-governance.js";
import type { BlueprintFulfillmentReport } from "./blueprint-fulfillment-auditor.js";

// ── Public types ────────────────────────────────────────────────────────

export interface TargetedRewriteInstruction {
  /**
   * Element identifier: "openingHook" | "payoffRequired" | "endingHook" | "scene-1" …
   * Used by tests to assert the prompt includes/excludes specific beats.
   */
  readonly element: string;
  /** Short label describing the issue */
  readonly issue: string;
  /** Original blueprint requirement text (for reference) */
  readonly required: string;
  /** Specific rewrite instruction to pass to the LLM reviser */
  readonly instruction: string;
}

export interface TargetedRewritePlan {
  readonly instructions: ReadonlyArray<TargetedRewriteInstruction>;
  /** Number of elements that need fixing */
  readonly fixCount: number;
  /** Summary of what needs to be fixed */
  readonly summary: string;
}

export interface BlueprintEditorReport {
  readonly targetedRewritePlan: TargetedRewritePlan;
  /** Blocking issues propagated from the fulfillment audit */
  readonly blockingIssues: ReadonlyArray<string>;
  /** Whether the chapter still needs to be rewritten */
  readonly shouldRewrite: boolean;
}

// ── Main function ───────────────────────────────────────────────────────

/**
 * Generate a targeted rewrite plan from a blueprint fulfillment audit report.
 *
 * Only failed/weak elements are included in the plan.
 * Satisfied elements are intentionally omitted — they must not be modified.
 */
export function generateBlueprintEditorReport(
  fulfillment: BlueprintFulfillmentReport,
  blueprint: ChapterBlueprint,
): BlueprintEditorReport {
  const instructions: TargetedRewriteInstruction[] = [];

  // ── Opening hook ──────────────────────────────────────────────────
  if (fulfillment.openingHook.status === "missing") {
    instructions.push({
      element: "openingHook",
      issue: "开篇钩子未出现在正文中",
      required: blueprint.openingHook,
      instruction: `在章节开头 300 字以内加入以下开篇钩子的核心元素：${blueprint.openingHook}`,
    });
  } else if (fulfillment.openingHook.status === "weak") {
    instructions.push({
      element: "openingHook",
      issue: `开篇钩子出现位置过晚（第 ${fulfillment.openingHook.position} 字处，应在前 300 字内）`,
      required: blueprint.openingHook,
      instruction: `将开篇钩子的核心元素移到章节前 300 字内：${blueprint.openingHook}`,
    });
  }

  // ── Payoff required ───────────────────────────────────────────────
  if (fulfillment.payoffRequired.status === "missing") {
    instructions.push({
      element: "payoffRequired",
      issue: "必须兑现的爽点/payoff 未在正文中体现",
      required: blueprint.payoffRequired,
      instruction: `在章节中明确体现以下爽点兑现：${blueprint.payoffRequired}`,
    });
  } else if (fulfillment.payoffRequired.status === "weak") {
    instructions.push({
      element: "payoffRequired",
      issue: "爽点兑现元素不完整，覆盖度不足",
      required: blueprint.payoffRequired,
      instruction: `强化章节中的爽点兑现，使其更明确完整：${blueprint.payoffRequired}`,
    });
  }

  // ── Ending hook ───────────────────────────────────────────────────
  if (fulfillment.endingHook.status === "missing") {
    instructions.push({
      element: "endingHook",
      issue: "结尾钩子未出现在正文中",
      required: blueprint.endingHook,
      instruction: `在章节结尾部分加入以下结尾钩子：${blueprint.endingHook}`,
    });
  } else if (fulfillment.endingHook.status === "weak") {
    instructions.push({
      element: "endingHook",
      issue: "结尾钩子出现但不在章节末尾区间",
      required: blueprint.endingHook,
      instruction: `将结尾钩子移到章节末尾（最后 20% 部分）：${blueprint.endingHook}`,
    });
  }

  // ── Failed scenes ─────────────────────────────────────────────────
  for (const scene of fulfillment.scenes) {
    if (scene.status === "satisfied") continue;

    const missingFields = scene.missingFields;
    const missingFieldsText =
      missingFields.length > 0 ? `（缺失要素：${missingFields.join("、")}）` : "";

    // Build per-field instructions — only for missing fields when partial failure
    const ALL_FIELD_NAMES = ["beat", "conflict", "turn", "payoff", "cost"] as const;
    const allFieldDefs: Record<string, string> = {
      beat: scene.beat,
      conflict: scene.conflict,
      turn: scene.turn,
      payoff: scene.payoff,
      cost: scene.cost,
    };

    const fieldsToFix: string[] =
      scene.status === "missing"
        ? // Scene completely missing: fix all five fields
          ALL_FIELD_NAMES.map((f) => `  - ${f}（${fieldLabel(f)}）：${allFieldDefs[f]}`)
        : // Scene weak: only fix the missing fields
          missingFields.map((f) => `  - ${f}（${fieldLabel(f)}）：${allFieldDefs[f] ?? ""}}`);

    instructions.push({
      element: `scene-${scene.index + 1}`,
      issue: `场景 ${scene.index + 1} ${scene.status === "missing" ? "完全缺失" : "要素不完整"}${missingFieldsText}`,
      required: `beat: ${scene.beat}; conflict: ${scene.conflict}; turn: ${scene.turn}; payoff: ${scene.payoff}; cost: ${scene.cost}`,
      instruction:
        `在场景 ${scene.index + 1} 中补充以下内容（只修改该场景，保持其他已满足场景原样）：\n` +
        fieldsToFix.join("\n"),
    });
  }

  const fixCount = instructions.length;
  const summary =
    fixCount > 0
      ? `需要定点修复 ${fixCount} 处：${instructions.map((i) => i.element).join("、")}`
      : "所有蓝图要素已满足，无需修复";

  return {
    targetedRewritePlan: {
      instructions,
      fixCount,
      summary,
    },
    blockingIssues: fulfillment.blockingIssues,
    shouldRewrite: fulfillment.shouldRewrite,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

function fieldLabel(fieldName: string): string {
  const LABELS: Record<string, string> = {
    beat: "节拍",
    conflict: "冲突",
    turn: "转折",
    payoff: "回报",
    cost: "代价",
  };
  return LABELS[fieldName] ?? fieldName;
}
