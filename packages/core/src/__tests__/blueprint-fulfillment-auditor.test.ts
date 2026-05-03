/**
 * Core unit tests for BlueprintFulfillmentAuditor (P4)
 *
 * Tests confirm heuristic rules:
 *  1. openingHook in first 300 chars → satisfied
 *  2. openingHook after 300 chars → weak, shouldRewrite=true
 *  3. openingHook absent → missing, shouldRewrite=true
 *  4. scene beat absent → scene status=missing
 *  5. endingHook not near chapter end → weak, shouldRewrite=true
 *  6. endingHook absent → missing, shouldRewrite=true
 *  7. 3+ missing scenes → shouldRewrite=true
 *  8. full happy path → high score, shouldRewrite=false
 *  9. payoffRequired absent → shouldRewrite=true
 */

import { describe, it, expect } from "vitest";
import { auditBlueprintFulfillment } from "../agents/blueprint-fulfillment-auditor.js";
import type { ChapterBlueprint } from "../models/input-governance.js";

// ── Fixtures ───────────────────────────────────────────────────────────

const BASE_BLUEPRINT: ChapterBlueprint = {
  openingHook: "林清雪主动找万凡",
  scenes: [
    { beat: "场景一开始", conflict: "冲突一发生", turn: "转折一出现", payoff: "爽点一兑现", cost: "代价一付出" },
    { beat: "场景二开始", conflict: "冲突二发生", turn: "转折二出现", payoff: "爽点二兑现", cost: "代价二付出" },
    { beat: "场景三开始", conflict: "冲突三发生", turn: "转折三出现", payoff: "爽点三兑现", cost: "代价三付出" },
    { beat: "场景四开始", conflict: "冲突四发生", turn: "转折四出现", payoff: "爽点四兑现", cost: "代价四付出" },
    { beat: "场景五开始", conflict: "冲突五发生", turn: "转折五出现", payoff: "爽点五兑现", cost: "代价五付出" },
  ],
  payoffRequired: "关系筹码发生变化",
  endingHook: "揭示真相改变局面",
  contractSatisfaction: [],
  status: "confirmed",
};

/** Build a text where the opening hook is at character position `pos` */
function buildTextWithOpeningAt(
  hook: string,
  pos: number,
  payload: string,
  ending: string,
): string {
  const padding = "万凡在办公室沉默地思考，时间一分一秒地流逝。".repeat(Math.ceil(pos / 20));
  return padding.slice(0, pos) + hook + payload + ending;
}

// ── Test groups ────────────────────────────────────────────────────────

describe("BlueprintFulfillmentAuditor — openingHook", () => {
  it("openingHook 在前 300 字内 → status=satisfied, withinFirst300Words=true", () => {
    const text =
      "林清雪主动找万凡，把一份错误资料拍在他面前。" +
      "万凡没有辩解而是反问来源。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化是确定的。" +
      "最终揭示真相改变局面，一切都不同了。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.openingHook.status).toBe("satisfied");
    expect(report.openingHook.withinFirst300Words).toBe(true);
    expect(report.openingHook.position).toBeGreaterThanOrEqual(0);
    expect(report.openingHook.position).toBeLessThan(300);
  });

  it("openingHook 在 300 字之后 → status=weak, withinFirst300Words=false", () => {
    // padding must not contain keywords from the hook ("林清雪","主动","找","万凡")
    const safeChar = "日";
    const padding = safeChar.repeat(400);
    const text =
      padding +
      "林清雪主动找万凡，把一份错误资料拍在他面前。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化。揭示真相改变局面。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.openingHook.status).toBe("weak");
    expect(report.openingHook.withinFirst300Words).toBe(false);
    expect(report.shouldRewrite).toBe(true);
    expect(report.blockingIssues.some((issue) => issue.includes("openingHook"))).toBe(true);
  });

  it("openingHook 不在正文中 → status=missing, shouldRewrite=true", () => {
    const text =
      "万凡走进办公室，没有人来找他。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "关系筹码发生变化。揭示真相改变局面。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.openingHook.status).toBe("missing");
    expect(report.shouldRewrite).toBe(true);
    expect(report.blockingIssues.some((i) => i.includes("openingHook"))).toBe(true);
  });
});

describe("BlueprintFulfillmentAuditor — scenes", () => {
  it("scene beat 缺失 → scene status=missing", () => {
    const text =
      "林清雪主动找万凡。" +
      // scene 1 completely absent
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化。揭示真相改变局面。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.scenes[0]?.status).toBe("missing");
    expect(report.scenes[0]?.missingFields).toContain("beat");
  });

  it("所有 scene beat 存在 → scene status=satisfied", () => {
    const text =
      "林清雪主动找万凡。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化。揭示真相改变局面。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    for (const scene of report.scenes) {
      expect(scene.status).toBe("satisfied");
    }
  });

  it("3 个以上 scene 缺失 → shouldRewrite=true", () => {
    const text =
      "林清雪主动找万凡。" +
      // only scenes 4 and 5 have content
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化。揭示真相改变局面。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    const missingCount = report.scenes.filter((s) => s.status === "missing").length;
    expect(missingCount).toBeGreaterThanOrEqual(3);
    expect(report.shouldRewrite).toBe(true);
  });
});

describe("BlueprintFulfillmentAuditor — endingHook", () => {
  it("endingHook 不在章尾 → status=weak", () => {
    // hook appears early in the text
    const endingContent = "揭示真相改变局面，";
    const padding = "万凡沉默思考后续影响。".repeat(100);
    const text =
      "林清雪主动找万凡。" +
      endingContent + // early in the text
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化。" +
      padding; // large trailing content pushes hook to early position

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.endingHook.nearChapterEnd).toBe(false);
    expect(report.endingHook.status).toBe("weak");
    expect(report.shouldRewrite).toBe(true);
  });

  it("短文本中 endingHook 出现在中段 → 不应误判为章尾", () => {
    const text =
      "林清雪主动找万凡。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "揭示真相改变局面。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化。最后只剩下一段平淡收束。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.endingHook.status).toBe("weak");
    expect(report.endingHook.nearChapterEnd).toBe(false);
    expect(report.shouldRewrite).toBe(true);
  });

  it("endingHook 不在正文中 → missing, shouldRewrite=true", () => {
    const text =
      "林清雪主动找万凡。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化。但什么都没有真正改变。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.endingHook.status).toBe("missing");
    expect(report.shouldRewrite).toBe(true);
    expect(report.blockingIssues.some((i) => i.includes("endingHook"))).toBe(true);
  });

  it("endingHook 在章尾 → satisfied, nearChapterEnd=true", () => {
    const body =
      "林清雪主动找万凡，把一份错误资料拍在他面前。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化，一切都明朗了。" +
      "揭示真相改变局面。";

    const report = auditBlueprintFulfillment({ chapterText: body, blueprint: BASE_BLUEPRINT });
    expect(report.endingHook.status).toBe("satisfied");
    expect(report.endingHook.nearChapterEnd).toBe(true);
  });
});

describe("BlueprintFulfillmentAuditor — payoffRequired", () => {
  it("payoffRequired 缺失 → shouldRewrite=true, blockingIssues 有提示", () => {
    const text =
      "林清雪主动找万凡。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "揭示真相改变局面。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.payoffRequired.status).toBe("missing");
    expect(report.shouldRewrite).toBe(true);
    expect(report.blockingIssues.some((i) => i.includes("payoffRequired"))).toBe(true);
  });
});

describe("BlueprintFulfillmentAuditor — happy path", () => {
  it("全满足 → 高分, shouldRewrite=false, blockingIssues 为空", () => {
    const text =
      "林清雪主动找万凡，把一份错误资料拍在他面前。万凡没有辩解而是反问来源。" +
      "场景一开始了冲突一发生了转折一出现了爽点一兑现了代价一付出了。" +
      "场景二开始了冲突二发生了转折二出现了爽点二兑现了代价二付出了。" +
      "场景三开始了冲突三发生了转折三出现了爽点三兑现了代价三付出了。" +
      "场景四开始了冲突四发生了转折四出现了爽点四兑现了代价四付出了。" +
      "场景五开始了冲突五发生了转折五出现了爽点五兑现了代价五付出了。" +
      "关系筹码发生变化，双方立场彻底改变。" +
      "最终揭示真相改变局面，一切都无法再回头。";

    const report = auditBlueprintFulfillment({ chapterText: text, blueprint: BASE_BLUEPRINT });
    expect(report.score).toBeGreaterThanOrEqual(80);
    expect(report.shouldRewrite).toBe(false);
    expect(report.blockingIssues).toHaveLength(0);
    expect(report.openingHook.status).toBe("satisfied");
    expect(report.payoffRequired.status).not.toBe("missing");
    expect(report.endingHook.status).toBe("satisfied");
  });

  it("score 结构：0-100 范围内", () => {
    const report = auditBlueprintFulfillment({ chapterText: "只有一点点内容", blueprint: BASE_BLUEPRINT });
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

describe("BlueprintFulfillmentAuditor — scenes count", () => {
  it("返回与 blueprint.scenes 数量相同的 SceneFulfillmentResult", () => {
    const report = auditBlueprintFulfillment({ chapterText: "内容", blueprint: BASE_BLUEPRINT });
    expect(report.scenes).toHaveLength(BASE_BLUEPRINT.scenes.length);
  });
});
