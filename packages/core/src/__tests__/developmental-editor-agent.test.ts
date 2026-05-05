/**
 * Unit tests for DevelopmentalEditorAgent (P5)
 * Tests: generateBlueprintEditorReport — heuristic plan generation from BlueprintFulfillmentReport
 */

import { describe, it, expect } from "vitest";
import { generateBlueprintEditorReport } from "../agents/developmental-editor-agent.js";
import type { BlueprintFulfillmentReport } from "../agents/blueprint-fulfillment-auditor.js";
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
  ],
  payoffRequired: "林清雪主动找万凡带来关系筹码变化，并出现一次误判反转",
  endingHook: "那份错误资料最初来自林清雪的私人账号",
  contractSatisfaction: [],
  status: "confirmed",
};

function makeFulfillmentReport(
  overrides: Partial<BlueprintFulfillmentReport>,
): BlueprintFulfillmentReport {
  return {
    score: 80,
    shouldRewrite: false,
    blockingIssues: [],
    openingHook: {
      expected: BASE_BLUEPRINT.openingHook,
      position: 0,
      withinFirst300Words: true,
      status: "satisfied",
    },
    scenes: BASE_BLUEPRINT.scenes.map((s, i) => ({
      index: i,
      beat: s.beat,
      conflict: s.conflict,
      turn: s.turn,
      payoff: s.payoff,
      cost: s.cost,
      status: "satisfied" as const,
      missingFields: [],
    })),
    payoffRequired: { status: "satisfied" },
    endingHook: { status: "satisfied", nearChapterEnd: true },
    ...overrides,
  };
}

describe("generateBlueprintEditorReport", () => {
  it("all satisfied → fixCount=0, shouldRewrite=false", () => {
    const report = generateBlueprintEditorReport(makeFulfillmentReport({}), BASE_BLUEPRINT);
    expect(report.targetedRewritePlan.fixCount).toBe(0);
    expect(report.targetedRewritePlan.instructions).toHaveLength(0);
    expect(report.shouldRewrite).toBe(false);
    expect(report.targetedRewritePlan.summary).toContain("无需修复");
  });

  it("openingHook missing → instructions contains openingHook element", () => {
    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({
        openingHook: { expected: BASE_BLUEPRINT.openingHook, position: -1, withinFirst300Words: false, status: "missing" },
        shouldRewrite: true,
        blockingIssues: ["openingHook 未出现"],
      }),
      BASE_BLUEPRINT,
    );

    const el = report.targetedRewritePlan.instructions.find((i) => i.element === "openingHook");
    expect(el).toBeDefined();
    expect(el!.issue).toContain("开篇钩子未出现");
    expect(el!.required).toBe(BASE_BLUEPRINT.openingHook);
    expect(el!.instruction).toContain(BASE_BLUEPRINT.openingHook);
    expect(report.targetedRewritePlan.fixCount).toBeGreaterThan(0);
  });

  it("openingHook weak (position too late) → instructions contains openingHook with position hint", () => {
    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({
        openingHook: { expected: BASE_BLUEPRINT.openingHook, position: 500, withinFirst300Words: false, status: "weak" },
        shouldRewrite: true,
        blockingIssues: ["openingHook 出现但不在前 300 字内"],
      }),
      BASE_BLUEPRINT,
    );

    const el = report.targetedRewritePlan.instructions.find((i) => i.element === "openingHook");
    expect(el).toBeDefined();
    expect(el!.issue).toContain("500");
  });

  it("scene 2 missing → instructions contain scene-2 but NOT scene-1 (satisfied)", () => {
    const scenes = makeFulfillmentReport({}).scenes.map((s) => ({ ...s }));
    // Override scene index 1 (scene-2) to missing
    const modifiedScenes = [
      scenes[0]!,
      {
        ...scenes[1]!,
        status: "missing" as const,
        missingFields: ["beat", "conflict", "turn", "payoff", "cost"],
      },
    ];

    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({
        scenes: modifiedScenes,
        shouldRewrite: true,
        blockingIssues: ["场景 2 缺失"],
      }),
      BASE_BLUEPRINT,
    );

    const scene1 = report.targetedRewritePlan.instructions.find((i) => i.element === "scene-1");
    const scene2 = report.targetedRewritePlan.instructions.find((i) => i.element === "scene-2");

    expect(scene1).toBeUndefined(); // scene 1 satisfied → not included
    expect(scene2).toBeDefined();
    expect(scene2!.issue).toContain("完全缺失");
    expect(scene2!.required).toContain(BASE_BLUEPRINT.scenes[1]!.beat);
  });

  it("scene 1 weak (partial) → only missing fields listed in instruction", () => {
    const modifiedScenes = [
      {
        ...makeFulfillmentReport({}).scenes[0]!,
        status: "weak" as const,
        missingFields: ["turn", "cost"],
      },
      makeFulfillmentReport({}).scenes[1]!,
    ];

    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({
        scenes: modifiedScenes,
        shouldRewrite: true,
        blockingIssues: [],
      }),
      BASE_BLUEPRINT,
    );

    const scene1 = report.targetedRewritePlan.instructions.find((i) => i.element === "scene-1");
    expect(scene1).toBeDefined();
    expect(scene1!.issue).toContain("要素不完整");
    expect(scene1!.instruction).toContain("turn");
    expect(scene1!.instruction).toContain("cost");
  });

  it("endingHook missing → instructions contain endingHook", () => {
    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({
        endingHook: { status: "missing", nearChapterEnd: false },
        shouldRewrite: true,
        blockingIssues: ["endingHook 未出现"],
      }),
      BASE_BLUEPRINT,
    );

    const el = report.targetedRewritePlan.instructions.find((i) => i.element === "endingHook");
    expect(el).toBeDefined();
    expect(el!.required).toBe(BASE_BLUEPRINT.endingHook);
  });

  it("payoffRequired missing → instructions contain payoffRequired", () => {
    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({
        payoffRequired: { status: "missing" },
        shouldRewrite: true,
        blockingIssues: ["payoffRequired 未体现"],
      }),
      BASE_BLUEPRINT,
    );

    const el = report.targetedRewritePlan.instructions.find((i) => i.element === "payoffRequired");
    expect(el).toBeDefined();
    expect(el!.required).toBe(BASE_BLUEPRINT.payoffRequired);
  });

  it("multiple failures → summary lists all elements", () => {
    const modifiedScenes = makeFulfillmentReport({}).scenes.map((s) => ({
      ...s,
      status: "missing" as const,
      missingFields: ["beat"],
    }));
    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({
        openingHook: { expected: BASE_BLUEPRINT.openingHook, position: -1, withinFirst300Words: false, status: "missing" },
        scenes: modifiedScenes,
        shouldRewrite: true,
        blockingIssues: [],
      }),
      BASE_BLUEPRINT,
    );

    expect(report.targetedRewritePlan.fixCount).toBeGreaterThanOrEqual(3);
    expect(report.targetedRewritePlan.summary).toContain("openingHook");
    expect(report.targetedRewritePlan.summary).toContain("scene-1");
    expect(report.targetedRewritePlan.summary).toContain("scene-2");
  });

  it("blockingIssues propagated from fulfillment", () => {
    const issues = ["openingHook 未出现", "场景 1 缺失"];
    const report = generateBlueprintEditorReport(
      makeFulfillmentReport({ blockingIssues: issues, shouldRewrite: true }),
      BASE_BLUEPRINT,
    );

    expect(report.blockingIssues).toEqual(issues);
  });
});
