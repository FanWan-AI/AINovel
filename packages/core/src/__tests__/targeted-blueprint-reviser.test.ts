/**
 * Unit tests for TargetedBlueprintReviser (P5)
 * Tests: static prompt builders — verifies failed beats ARE in prompt, satisfied beats are NOT.
 */

import { describe, it, expect } from "vitest";
import { TargetedBlueprintReviser } from "../agents/targeted-blueprint-reviser.js";
import type { TargetedRewritePlan } from "../agents/developmental-editor-agent.js";
import type { ChapterBlueprint } from "../models/input-governance.js";

const BASE_BLUEPRINT: ChapterBlueprint = {
  openingHook: "林清雪主动找万凡，把一份错误资料拍在他面前",
  scenes: [
    {
      beat: "林清雪公开试探万凡",
      conflict: "错误资料压迫万凡表态",
      turn: "万凡反问来源",
      payoff: "信息差压制成立",
      cost: "互信被消耗",
    },
    {
      beat: "万凡设置系统反馈验证",
      conflict: "反馈不能被旁人看见",
      turn: "反馈指向林清雪身边人",
      payoff: "信息差成立",
      cost: "万凡暴露异常判断力",
    },
    {
      beat: "误判反转在办公室爆开",
      conflict: "真正泄密者反咬万凡",
      turn: "林清雪当众改口护住万凡",
      payoff: "关系筹码改变",
      cost: "林清雪卷入对立面",
    },
  ],
  payoffRequired: "林清雪主动找万凡带来关系筹码变化，并出现一次误判反转",
  endingHook: "那份错误资料最初来自林清雪的私人账号",
  contractSatisfaction: [],
  status: "confirmed",
};

function makePlan(failedElements: string[]): TargetedRewritePlan {
  const instructions = failedElements.map((element) => {
    if (element === "openingHook") {
      return {
        element,
        issue: "开篇钩子未出现",
        required: BASE_BLUEPRINT.openingHook,
        instruction: `在章节开头 300 字以内加入：${BASE_BLUEPRINT.openingHook}`,
      };
    }
    if (element === "payoffRequired") {
      return {
        element,
        issue: "爽点未体现",
        required: BASE_BLUEPRINT.payoffRequired,
        instruction: `补充爽点：${BASE_BLUEPRINT.payoffRequired}`,
      };
    }
    if (element === "endingHook") {
      return {
        element,
        issue: "结尾钩子未出现",
        required: BASE_BLUEPRINT.endingHook,
        instruction: `加入结尾钩子：${BASE_BLUEPRINT.endingHook}`,
      };
    }
    const sceneMatch = element.match(/^scene-(\d+)$/);
    if (sceneMatch) {
      const idx = Number(sceneMatch[1]) - 1;
      const scene = BASE_BLUEPRINT.scenes[idx]!;
      return {
        element,
        issue: `场景 ${sceneMatch[1]} 完全缺失`,
        required: `beat: ${scene.beat}`,
        instruction: `补充场景 ${sceneMatch[1]}：${scene.beat}`,
      };
    }
    return { element, issue: "未知问题", required: "", instruction: "" };
  });

  return {
    instructions,
    fixCount: instructions.length,
    summary: `需要修复：${failedElements.join("、")}`,
  };
}

describe("TargetedBlueprintReviser.buildSystemPrompt", () => {
  it("prompt contains failed beat text", () => {
    const plan = makePlan(["scene-2"]);
    const prompt = TargetedBlueprintReviser.buildSystemPrompt(BASE_BLUEPRINT, plan);

    // Failed beat should appear in the prompt
    expect(prompt).toContain("万凡设置系统反馈验证");
    // scene-2 element label should appear
    expect(prompt).toContain("scene-2");
  });

  it("prompt does NOT instruct modification of satisfied scenes", () => {
    // Only scene-2 is failing; scene-1 and scene-3 are satisfied
    const plan = makePlan(["scene-2"]);
    const prompt = TargetedBlueprintReviser.buildSystemPrompt(BASE_BLUEPRINT, plan);

    // Satisfied scenes are listed as DO NOT TOUCH
    expect(prompt).toContain("scene-1（已满足，禁止改动）");
    expect(prompt).toContain("scene-3（已满足，禁止改动）");
    // scene-2 is in the "需要修复" section, not in DO NOT TOUCH
    expect(prompt).not.toContain("scene-2（已满足，禁止改动）");
  });

  it("satisfied openingHook listed as DO NOT TOUCH when not failing", () => {
    const plan = makePlan(["scene-2"]); // openingHook not in failed list
    const prompt = TargetedBlueprintReviser.buildSystemPrompt(BASE_BLUEPRINT, plan);

    expect(prompt).toContain("openingHook（已满足，禁止改动）");
  });

  it("failing openingHook NOT listed as DO NOT TOUCH", () => {
    const plan = makePlan(["openingHook", "scene-2"]);
    const prompt = TargetedBlueprintReviser.buildSystemPrompt(BASE_BLUEPRINT, plan);

    expect(prompt).not.toContain("openingHook（已满足，禁止改动）");
    // But the failing openingHook instruction must appear
    expect(prompt).toContain("开篇钩子未出现");
  });

  it("prompt contains fixCount in header", () => {
    const plan = makePlan(["openingHook", "endingHook"]);
    const prompt = TargetedBlueprintReviser.buildSystemPrompt(BASE_BLUEPRINT, plan);

    expect(prompt).toContain("共 2 处");
  });

  it("all elements failing → no DO NOT TOUCH section for top-level", () => {
    const plan = makePlan(["openingHook", "payoffRequired", "endingHook"]);
    const prompt = TargetedBlueprintReviser.buildSystemPrompt(BASE_BLUEPRINT, plan);

    // All three top-level elements are failing, so none should be in DO NOT TOUCH
    expect(prompt).not.toContain("openingHook（已满足，禁止改动）");
    expect(prompt).not.toContain("payoffRequired（已满足，禁止改动）");
    expect(prompt).not.toContain("endingHook（已满足，禁止改动）");
  });

  it("prompt contains output format markers", () => {
    const plan = makePlan(["scene-1"]);
    const prompt = TargetedBlueprintReviser.buildSystemPrompt(BASE_BLUEPRINT, plan);

    expect(prompt).toContain("=== APPLIED_FIXES ===");
    expect(prompt).toContain("=== REVISED_CONTENT ===");
  });
});

describe("TargetedBlueprintReviser.buildUserPrompt", () => {
  it("user prompt contains chapter text", () => {
    const plan = makePlan(["scene-2"]);
    const chapterText = "万凡坐在办公室里，无事发生。";
    const prompt = TargetedBlueprintReviser.buildUserPrompt(chapterText, plan, 3);

    expect(prompt).toContain(chapterText);
    expect(prompt).toContain("第 3 章");
  });

  it("user prompt contains plan summary", () => {
    const plan = makePlan(["openingHook"]);
    const prompt = TargetedBlueprintReviser.buildUserPrompt("任意正文", plan);

    expect(prompt).toContain(plan.summary);
  });

  it("chapter number defaults to ? when not provided", () => {
    const plan = makePlan(["scene-1"]);
    const prompt = TargetedBlueprintReviser.buildUserPrompt("正文内容", plan);

    expect(prompt).toContain("第 ? 章");
  });
});
