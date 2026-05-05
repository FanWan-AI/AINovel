/**
 * TargetedBlueprintReviser — P5 LLM-based targeted revision agent.
 *
 * Revises a chapter by applying a TargetedRewritePlan:
 *   - Only modifies failed/weak blueprint elements
 *   - Preserves all satisfied elements (they are explicitly listed as DO NOT TOUCH)
 *   - Outputs complete revised chapter + applied-fixes log
 *
 * Static prompt builders are exposed so unit tests can verify the prompt
 * contains the failed beats and NOT the satisfied beats without an LLM call.
 */

import { BaseAgent, type AgentContext } from "./base.js";
import type { ChapterBlueprint } from "../models/input-governance.js";
import type { TargetedRewritePlan } from "./developmental-editor-agent.js";

// ── Public types ────────────────────────────────────────────────────────

export interface TargetedReviseInput {
  readonly chapterText: string;
  readonly blueprint: ChapterBlueprint;
  readonly plan: TargetedRewritePlan;
  readonly chapterNumber?: number;
}

export interface TargetedReviseOutput {
  readonly revisedText: string;
  readonly appliedFixes: ReadonlyArray<string>;
}

// ── Agent ───────────────────────────────────────────────────────────────

export class TargetedBlueprintReviser extends BaseAgent {
  get name(): string { return "TargetedBlueprintReviser"; }

  constructor(ctx: AgentContext) {
    super(ctx);
  }

  /**
   * Build the system prompt for targeted revision.
   *
   * Includes only the failed elements from `plan`. Satisfied elements are
   * explicitly listed as "已满足，禁止改动" so the LLM does not drift.
   *
   * Exposed as static so unit tests can validate prompt content.
   */
  static buildSystemPrompt(blueprint: ChapterBlueprint, plan: TargetedRewritePlan): string {
    const failedItems = plan.instructions
      .map(
        (inst, i) =>
          `${i + 1}. [${inst.element}] ${inst.issue}\n   蓝图要求：${inst.required}\n   修改指令：${inst.instruction}`,
      )
      .join("\n\n");

    // Collect satisfied top-level elements to list as DO NOT TOUCH
    const failedElementSet = new Set(plan.instructions.map((inst) => inst.element));
    const satisfiedLines: string[] = [];
    if (!failedElementSet.has("openingHook")) {
      satisfiedLines.push(`- openingHook（已满足，禁止改动）：${blueprint.openingHook.slice(0, 60)}`);
    }
    if (!failedElementSet.has("payoffRequired")) {
      satisfiedLines.push(`- payoffRequired（已满足，禁止改动）：${blueprint.payoffRequired.slice(0, 60)}`);
    }
    if (!failedElementSet.has("endingHook")) {
      satisfiedLines.push(`- endingHook（已满足，禁止改动）：${blueprint.endingHook.slice(0, 60)}`);
    }
    // Satisfied scenes
    for (let i = 0; i < blueprint.scenes.length; i++) {
      const sceneKey = `scene-${i + 1}`;
      if (!failedElementSet.has(sceneKey)) {
        satisfiedLines.push(`- scene-${i + 1}（已满足，禁止改动）：${blueprint.scenes[i]!.beat.slice(0, 40)}`);
      }
    }

    const satisfiedBlock =
      satisfiedLines.length > 0
        ? `\n\n【已满足要素 — 禁止改动】\n${satisfiedLines.join("\n")}`
        : "";

    return `你是专业的网络小说修稿编辑，专门负责蓝图兑现定点修订。你的任务是根据蓝图兑现审计结果，对章节进行最小化的定点修订。

【重要限制】
1. 只修改下面"需要修复的要素"中列出的具体元素，其余段落保持原样
2. 禁止修改已满足的场景或要素
3. 不改变整体剧情走向和核心冲突
4. 修改后必须输出完整章节正文

【需要修复的要素】（共 ${plan.fixCount} 处）

${failedItems}${satisfiedBlock}

输出格式：

=== APPLIED_FIXES ===
（逐条说明修复了哪些内容，一行一条）

=== REVISED_CONTENT ===
（修改后的完整正文）`;
  }

  /**
   * Build the user prompt for targeted revision.
   * Exposed as static so unit tests can inspect it without an LLM call.
   */
  static buildUserPrompt(
    chapterText: string,
    plan: TargetedRewritePlan,
    chapterNumber?: number,
  ): string {
    return `请按照修订指令，对第 ${chapterNumber ?? "?"} 章进行蓝图定点修订。

【修复摘要】${plan.summary}

【原始正文】
${chapterText}`;
  }

  /**
   * Perform the targeted LLM revision.
   */
  async revise(input: TargetedReviseInput): Promise<TargetedReviseOutput> {
    const systemPrompt = TargetedBlueprintReviser.buildSystemPrompt(
      input.blueprint,
      input.plan,
    );
    const userPrompt = TargetedBlueprintReviser.buildUserPrompt(
      input.chapterText,
      input.plan,
      input.chapterNumber,
    );

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.7 },
    );

    return parseTargetedReviseOutput(response.content);
  }
}

// ── Output parser ───────────────────────────────────────────────────────

function parseTargetedReviseOutput(raw: string): TargetedReviseOutput {
  const appliedFixesMatch = raw.match(
    /=== APPLIED_FIXES ===\s*([\s\S]*?)(?:=== REVISED_CONTENT ===|$)/,
  );
  const revisedContentMatch = raw.match(/=== REVISED_CONTENT ===\s*([\s\S]*?)$/);

  const appliedFixesRaw = appliedFixesMatch?.[1]?.trim() ?? "";
  const revisedText = revisedContentMatch?.[1]?.trim() ?? "";

  const appliedFixes = appliedFixesRaw
    .split(/\n/)
    .map((line) => line.replace(/^[-•*\d.]+\s*/, "").trim())
    .filter((line) => line.length > 0);

  return {
    // Fallback to raw output when no section markers found
    revisedText: revisedText.length > 0 ? revisedText : raw.trim(),
    appliedFixes,
  };
}
