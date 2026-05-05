/**
 * Tests for NovelOS P4 UI card components.
 * Uses renderToStaticMarkup (same pattern as existing component tests).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { ContractCard, type ContractCardPayload } from "./ContractCard.js";
import { BlueprintPreviewCard, type BlueprintPreviewPayload } from "./BlueprintPreviewCard.js";
import { ContractVerificationCard, type VerificationReportPayload } from "./ContractVerificationCard.js";
import { PlotCritiqueCard, type PlotCritiqueCardPayload } from "./PlotCritiqueCard.js";
import { EditorReportCard, P5RevisionCard, type EditorReportPayload, type P5AutoRevisionPayload } from "./EditorReportCard.js";

describe("ContractCard", () => {
  it("renders contract with all sections", () => {
    const contract: ContractCardPayload = {
      goal: "林清雪主动找万凡",
      mustInclude: ["林清雪主动找万凡", "误判反转"],
      mustAvoid: ["万凡被动等消息"],
      sceneBeats: ["开场压力", "反转发生"],
      payoffRequired: "万凡用信息差反制",
      endingHook: "新悬念引入",
      priority: "hard",
      sourceArtifactIds: ["art_123456789abc"],
      rawRequest: "测试请求",
    };

    const html = renderToStaticMarkup(createElement(ContractCard, { contract }));
    expect(html).toContain("下一章契约");
    expect(html).toContain("硬约束");
    expect(html).toContain("林清雪主动找万凡");
    expect(html).toContain("误判反转");
    expect(html).toContain("万凡被动等消息");
    expect(html).toContain("万凡用信息差反制");
    expect(html).toContain("开场压力");
    expect(html).toContain("art_12345678"); // ContractCard truncates ids to 12 chars
  });

  it("renders soft priority style", () => {
    const contract: ContractCardPayload = {
      mustInclude: [],
      mustAvoid: [],
      sceneBeats: [],
      priority: "soft",
      sourceArtifactIds: [],
      rawRequest: "",
    };

    const html = renderToStaticMarkup(createElement(ContractCard, { contract }));
    expect(html).toContain("软约束");
  });

  it("renders minimal contract without optional fields", () => {
    const contract: ContractCardPayload = {
      mustInclude: ["唯一要求"],
      mustAvoid: [],
      sceneBeats: [],
      priority: "normal",
      sourceArtifactIds: [],
      rawRequest: "",
    };

    const html = renderToStaticMarkup(createElement(ContractCard, { contract }));
    expect(html).toContain("唯一要求");
    expect(html).toContain("普通");
    expect(html).not.toContain("必须避免");
    expect(html).not.toContain("场景节拍");
  });
});

describe("BlueprintPreviewCard", () => {
  it("renders blueprint with 5+ scenes", () => {
    const blueprint: BlueprintPreviewPayload = {
      openingHook: "以一个具体压力点开场",
      scenes: [
        { beat: "场景1：林清雪决定行动", conflict: "信息不对称", turn: "发现真相", payoff: "读者期待满足", cost: "暴露风险" },
        { beat: "场景2：万凡布局", conflict: "对手反击", turn: "逆转局势", payoff: "爽点释放", cost: "损失信任" },
        { beat: "场景3：正面交锋", conflict: "直接对抗", turn: "误判发生", payoff: "真相揭露", cost: "关系受损" },
        { beat: "场景4：代价显现", conflict: "内心挣扎", turn: "接受现实", payoff: "成长体现", cost: "代价付出" },
        { beat: "场景5：新悬念", conflict: "未知威胁", turn: "章尾反转", payoff: "持续吸引", cost: "更多问题" },
      ],
      payoffRequired: "具体可感的变化",
      endingHook: "由本章兑现后的新问题产生",
      contractSatisfaction: ["目标：林清雪主动找万凡", "必须包含：误判反转"],
    };

    const html = renderToStaticMarkup(createElement(BlueprintPreviewCard, { blueprint }));
    expect(html).toContain("章节蓝图预览");
    expect(html).toContain("以一个具体压力点开场");
    expect(html).toContain("由本章兑现后的新问题产生");
    expect(html).toContain("场景1：林清雪决定行动");
    expect(html).toContain("场景5：新悬念");
    expect(html).toContain("信息不对称");
    expect(html).toContain("目标：林清雪主动找万凡");
  });

  it("renders draft status badge by default when status is not provided", () => {
    const blueprint: BlueprintPreviewPayload = {
      openingHook: "开场",
      scenes: [
        { beat: "1", conflict: "c1", turn: "t1", payoff: "p1", cost: "cost1" },
        { beat: "2", conflict: "c2", turn: "t2", payoff: "p2", cost: "cost2" },
        { beat: "3", conflict: "c3", turn: "t3", payoff: "p3", cost: "cost3" },
        { beat: "4", conflict: "c4", turn: "t4", payoff: "p4", cost: "cost4" },
        { beat: "5", conflict: "c5", turn: "t5", payoff: "p5", cost: "cost5" },
      ],
      payoffRequired: "兑现",
      endingHook: "结尾",
      contractSatisfaction: [],
    };
    const html = renderToStaticMarkup(createElement(BlueprintPreviewCard, { blueprint }));
    expect(html).toContain("草稿");
    expect(html).toContain("v1");
  });

  it("renders confirmed status badge when status=confirmed", () => {
    const blueprint: BlueprintPreviewPayload = {
      openingHook: "开场",
      scenes: [
        { beat: "1", conflict: "c1", turn: "t1", payoff: "p1", cost: "cost1" },
        { beat: "2", conflict: "c2", turn: "t2", payoff: "p2", cost: "cost2" },
        { beat: "3", conflict: "c3", turn: "t3", payoff: "p3", cost: "cost3" },
        { beat: "4", conflict: "c4", turn: "t4", payoff: "p4", cost: "cost4" },
        { beat: "5", conflict: "c5", turn: "t5", payoff: "p5", cost: "cost5" },
      ],
      payoffRequired: "兑现",
      endingHook: "结尾",
      contractSatisfaction: [],
      status: "confirmed",
      version: 2,
    };
    const html = renderToStaticMarkup(createElement(BlueprintPreviewCard, { blueprint }));
    expect(html).toContain("已确认");
    expect(html).toContain("v2");
  });

  it("renders edited status badge when status=edited", () => {
    const blueprint: BlueprintPreviewPayload = {
      openingHook: "开场",
      scenes: [
        { beat: "1", conflict: "c1", turn: "t1", payoff: "p1", cost: "cost1" },
        { beat: "2", conflict: "c2", turn: "t2", payoff: "p2", cost: "cost2" },
        { beat: "3", conflict: "c3", turn: "t3", payoff: "p3", cost: "cost3" },
        { beat: "4", conflict: "c4", turn: "t4", payoff: "p4", cost: "cost4" },
        { beat: "5", conflict: "c5", turn: "t5", payoff: "p5", cost: "cost5" },
      ],
      payoffRequired: "兑现",
      endingHook: "结尾",
      contractSatisfaction: [],
      status: "edited",
      version: 3,
    };
    const html = renderToStaticMarkup(createElement(BlueprintPreviewCard, { blueprint }));
    expect(html).toContain("已编辑");
    expect(html).toContain("v3");
  });

  it("renders confirm and edit buttons when callbacks are provided", () => {
    const blueprint: BlueprintPreviewPayload = {
      openingHook: "开场",
      scenes: [
        { beat: "1", conflict: "c1", turn: "t1", payoff: "p1", cost: "cost1" },
        { beat: "2", conflict: "c2", turn: "t2", payoff: "p2", cost: "cost2" },
        { beat: "3", conflict: "c3", turn: "t3", payoff: "p3", cost: "cost3" },
        { beat: "4", conflict: "c4", turn: "t4", payoff: "p4", cost: "cost4" },
        { beat: "5", conflict: "c5", turn: "t5", payoff: "p5", cost: "cost5" },
      ],
      payoffRequired: "兑现",
      endingHook: "结尾",
      contractSatisfaction: [],
      status: "draft",
    };
    const html = renderToStaticMarkup(
      createElement(BlueprintPreviewCard, { blueprint, onConfirm: () => {}, onEdit: () => {} }),
    );
    expect(html).toContain("确认蓝图");
    expect(html).toContain("编辑蓝图");
  });

  it("does not render confirm button when status=confirmed even if onConfirm provided", () => {
    const blueprint: BlueprintPreviewPayload = {
      openingHook: "开场",
      scenes: [
        { beat: "1", conflict: "c1", turn: "t1", payoff: "p1", cost: "cost1" },
        { beat: "2", conflict: "c2", turn: "t2", payoff: "p2", cost: "cost2" },
        { beat: "3", conflict: "c3", turn: "t3", payoff: "p3", cost: "cost3" },
        { beat: "4", conflict: "c4", turn: "t4", payoff: "p4", cost: "cost4" },
        { beat: "5", conflict: "c5", turn: "t5", payoff: "p5", cost: "cost5" },
      ],
      payoffRequired: "兑现",
      endingHook: "结尾",
      contractSatisfaction: [],
      status: "confirmed",
    };
    const html = renderToStaticMarkup(
      createElement(BlueprintPreviewCard, { blueprint, onConfirm: () => {} }),
    );
    expect(html).not.toContain("确认蓝图");
  });

  it("does not render action buttons when no callbacks are provided", () => {
    const blueprint: BlueprintPreviewPayload = {
      openingHook: "开场",
      scenes: [
        { beat: "1", conflict: "c1", turn: "t1", payoff: "p1", cost: "cost1" },
        { beat: "2", conflict: "c2", turn: "t2", payoff: "p2", cost: "cost2" },
        { beat: "3", conflict: "c3", turn: "t3", payoff: "p3", cost: "cost3" },
        { beat: "4", conflict: "c4", turn: "t4", payoff: "p4", cost: "cost4" },
        { beat: "5", conflict: "c5", turn: "t5", payoff: "p5", cost: "cost5" },
      ],
      payoffRequired: "兑现",
      endingHook: "结尾",
      contractSatisfaction: [],
    };
    const html = renderToStaticMarkup(createElement(BlueprintPreviewCard, { blueprint }));
    expect(html).not.toContain("确认蓝图");
    expect(html).not.toContain("编辑蓝图");
  });
});

describe("ContractVerificationCard", () => {
  it("renders 100% satisfied report", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 1.0,
      items: [
        { requirement: "必须包含: 林清雪主动找万凡", status: "satisfied", reason: "精确匹配", evidence: "林清雪主动找万凡" },
        { requirement: "必须包含: 误判反转", status: "satisfied", reason: "精确匹配" },
        { requirement: "必须避免: 万凡被动等消息", status: "satisfied", reason: "未发现" },
      ],
      shouldRewrite: false,
    };

    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("契约验证报告");
    expect(html).toContain("100%");
    expect(html).not.toContain("需要重写");
  });

  it("renders 33% partial report with rewrite flag", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 0.33,
      items: [
        { requirement: "必须包含: 林清雪主动找万凡", status: "satisfied", reason: "匹配" },
        { requirement: "必须包含: 误判反转", status: "missing", reason: "未找到" },
        { requirement: "必须避免: 万凡被动等消息", status: "missing", reason: "发现违规" },
      ],
      shouldRewrite: true,
    };

    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("33%");
    expect(html).toContain("需要重写");
  });

  it("renders warning banner when warning field is present", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 0.33,
      items: [
        { requirement: "必须包含：关键反转", status: "missing", reason: "未找到" },
      ],
      shouldRewrite: true,
      warning: "硬性用户要求未全部满足，建议修订",
    };

    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("硬性用户要求未全部满足，建议修订");
  });

  it("renders graphPatchConsumption section when present", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 0.75,
      items: [
        { requirement: "必须包含：角色关系变化", status: "satisfied", reason: "匹配" },
      ],
      shouldRewrite: false,
      graphPatchConsumption: {
        patches: [
          { patchId: "patch-001", status: "consumed", reason: "所有硬性要求已满足", satisfiedRequirements: ["要求A"], missingRequirements: [] },
          { patchId: "patch-002", status: "consumed", reason: "所有硬性要求已满足", satisfiedRequirements: ["要求B"], missingRequirements: [] },
          { patchId: "patch-003", status: "pending", reason: "硬性要求未满足", satisfiedRequirements: [], missingRequirements: ["要求C"] },
        ],
        consumed: ["patch-001", "patch-002"],
        pending: ["patch-003"],
        partiallyConsumed: [],
      },
    };

    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("graph-patch-consumption");
  });

  it("renders blueprint fulfillment audit when verification payload includes it", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 1,
      items: [],
      shouldRewrite: false,
      blueprintFulfillment: {
        score: 86,
        shouldRewrite: false,
        openingHook: {
          expected: "林清雪主动找万凡",
          position: 0,
          withinFirst300Words: true,
          status: "satisfied",
          evidence: "林清雪主动找万凡",
        },
        scenes: [
          {
            index: 0,
            beat: "林清雪进入地下室",
            conflict: "她误判万凡状态",
            turn: "误判被系统提示反转",
            payoff: "关系筹码发生变化",
            cost: "暴露链接风险",
            status: "satisfied",
            evidence: "林清雪进入地下室",
            missingFields: [],
          },
        ],
        payoffRequired: { status: "satisfied", evidence: "关系筹码发生变化" },
        endingHook: { status: "satisfied", nearChapterEnd: true, evidence: "新的监控者出现" },
        blockingIssues: [],
      },
    };

    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("蓝图兑现审计");
    expect(html).toContain("86分");
    expect(html).toContain("林清雪进入地下室");
  });

  it("renders consumed, partially_consumed, and pending patch states in graphPatchConsumption", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 0.6,
      items: [
        { requirement: "必须包含：主角决断", status: "satisfied", reason: "匹配" },
        { requirement: "必须包含：反派出场", status: "missing", reason: "未找到" },
      ],
      shouldRewrite: false,
      graphPatchConsumption: {
        patches: [
          { patchId: "patch-consumed", status: "consumed", reason: "所有硬性要求已满足", satisfiedRequirements: ["主角决断"], missingRequirements: [] },
          { patchId: "patch-partial", status: "partially_consumed", reason: "部分硬性要求已满足（1/2）", satisfiedRequirements: ["主角决断"], missingRequirements: ["反派出场"] },
          { patchId: "patch-pending", status: "pending", reason: "硬性要求未满足", satisfiedRequirements: [], missingRequirements: ["反派出场"] },
        ],
        consumed: ["patch-consumed"],
        partiallyConsumed: ["patch-partial"],
        pending: ["patch-pending"],
      },
    };

    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("patch-entry-consumed");
    expect(html).toContain("patch-entry-partially_consumed");
    expect(html).toContain("patch-entry-pending");
    expect(html).toContain("所有硬性要求已满足");
    expect(html).toContain("部分硬性要求已满足（1/2）");
    expect(html).toContain("硬性要求未满足");
  });

  it("renders pending verification card without crash and shows 正在验证 text", () => {
    const report: VerificationReportPayload = {
      pending: true,
      bookId: "book-1",
      chapterNumber: 5,
    };

    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("contract-verification-card");
    expect(html).toContain("正在验证");
    expect(html).toContain("章节已生成，正在验证用户契约");
    expect(html).not.toContain("NaN%");
    expect(html).not.toContain("undefined");
  });

  it("renders pending card without chapterNumber without crash", () => {
    const report: VerificationReportPayload = { pending: true, bookId: "book-2" };
    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("正在验证");
    expect(html).not.toContain("undefined");
  });
});

describe("PlotCritiqueCard", () => {
  it("renders full critique with opportunities", () => {
    const critique: PlotCritiqueCardPayload = {
      bookId: "book-1",
      chapterRange: { from: 1, to: 5 },
      strengths: ["设定完整", "悬念编织"],
      weaknesses: ["节奏慢", "AI痕迹重"],
      stalePatterns: ["过度内省", "推延行动"],
      nextChapterOpportunities: [
        { title: "主角主动出击", why: "近期被动过多", mustInclude: ["主角做出主动选择"], risk: "转折突兀", payoff: "读者期待" },
      ],
    };

    const html = renderToStaticMarkup(createElement(PlotCritiqueCard, { critique }));
    expect(html).toContain("剧情诊断");
    expect(html).toContain("章节 1~5");
    expect(html).toContain("设定完整");
    expect(html).toContain("节奏慢");
    expect(html).toContain("过度内省");
    expect(html).toContain("主角主动出击");
    expect(html).toContain("转折突兀");
  });
});

describe("EditorReportCard", () => {
  it("renders editor scores with dimensions", () => {
    const report: EditorReportPayload = {
      overallScore: 7.5,
      dimensions: {
        conflict: 8,
        agency: 7,
        payoff: 6,
        relationshipMovement: 7,
        hook: 8,
        proseFreshness: 5,
        contractSatisfaction: 10,
      },
      blockingIssues: ["未满足 mustInclude: 误判反转"],
      rewriteAdvice: ["增加反转或爽点释放"],
    };

    const html = renderToStaticMarkup(createElement(EditorReportCard, { report }));
    expect(html).toContain("章节质量评估");
    expect(html).toContain("7.5");
    expect(html).toContain("冲突强度");
    expect(html).toContain("主角主动性");
    expect(html).toContain("契约满足率");
    expect(html).toContain("未满足 mustInclude: 误判反转");
    expect(html).toContain("增加反转或爽点释放");
  });
});

// ── P5RevisionCard ──────────────────────────────────────────────────────

const BASE_P5_EDITOR_REPORT: P5AutoRevisionPayload["editorReport"] = {
  targetedRewritePlan: {
    instructions: [
      { element: "openingHook", issue: "开篇无钩子", required: "前300字内植入钩子", instruction: "在首段末尾添加悬念" },
    ],
    fixCount: 1,
    summary: "修复1处开篇问题",
  },
  blockingIssues: ["开篇无钩子"],
  shouldRewrite: true,
};

const BASE_P5_REVISED_FULFILLMENT: P5AutoRevisionPayload["revisedBlueprintFulfillment"] = {
  score: 82,
  shouldRewrite: false,
  blockingIssues: [],
};

describe("P5RevisionCard", () => {
  it("renders candidate_pending_approval status with pending notice", () => {
    const revision: P5AutoRevisionPayload = {
      editorReport: BASE_P5_EDITOR_REPORT,
      appliedFixes: ["在第一段末尾添加悬念钩子"],
      revisedBlueprintFulfillment: BASE_P5_REVISED_FULFILLMENT,
      status: "candidate_pending_approval",
      runId: "run-abc12345-pending",
    };
    const html = renderToStaticMarkup(createElement(P5RevisionCard, { revision }));
    expect(html).toContain("p5-revision-card");
    expect(html).toContain("蓝图定点修订候选（待批准）");
    expect(html).toContain("已生成蓝图定点修订候选");
    expect(html).toContain("run:run-abc1");
    expect(html).toContain("score: 82");
    expect(html).toContain("在第一段末尾添加悬念钩子");
    expect(html).not.toContain("蓝图定点修订失败");
    expect(html).not.toContain("仍存在的问题");
  });

  it("renders still-failing status with blocking issues", () => {
    const revision: P5AutoRevisionPayload = {
      editorReport: BASE_P5_EDITOR_REPORT,
      appliedFixes: ["尝试修复开篇"],
      revisedBlueprintFulfillment: {
        score: 55,
        shouldRewrite: true,
        blockingIssues: ["开篇仍无钩子", "场景2缺少冲突转折"],
      },
      status: "still-failing",
      runId: "run-def67890-failing",
    };
    const html = renderToStaticMarkup(createElement(P5RevisionCard, { revision }));
    expect(html).toContain("p5-revision-card");
    expect(html).toContain("蓝图定点修订候选（仍需复核）");
    expect(html).toContain("修订候选仍存在蓝图问题");
    expect(html).toContain("score: 55");
    expect(html).toContain("⚠️ 修订后仍存在的问题");
    expect(html).toContain("开篇仍无钩子");
    expect(html).toContain("场景2缺少冲突转折");
  });

  it("renders failed status with error message", () => {
    const revision: P5AutoRevisionPayload = {
      status: "failed",
      error: "LLM timeout after 30s",
    };
    const html = renderToStaticMarkup(createElement(P5RevisionCard, { revision }));
    expect(html).toContain("p5-revision-card");
    expect(html).toContain("蓝图定点修订失败");
    expect(html).toContain("LLM timeout after 30s");
    expect(html).not.toContain("已生成蓝图定点修订候选");
    expect(html).not.toContain("score:");
  });

  it("renders failed status without error gracefully", () => {
    const revision: P5AutoRevisionPayload = { status: "failed" };
    const html = renderToStaticMarkup(createElement(P5RevisionCard, { revision }));
    expect(html).toContain("蓝图定点修订失败");
    expect(html).not.toContain("undefined");
  });

  it("shows fix target badges for each instruction element", () => {
    const revision: P5AutoRevisionPayload = {
      editorReport: {
        targetedRewritePlan: {
          instructions: [
            { element: "openingHook", issue: "issue1", required: "req1", instruction: "inst1" },
            { element: "scene-2", issue: "issue2", required: "req2", instruction: "inst2" },
          ],
          fixCount: 2,
          summary: "修复2处",
        },
        blockingIssues: [],
        shouldRewrite: true,
      },
      appliedFixes: [],
      revisedBlueprintFulfillment: { score: 75, shouldRewrite: false, blockingIssues: [] },
      status: "candidate_pending_approval",
      runId: "run-xyz",
    };
    const html = renderToStaticMarkup(createElement(P5RevisionCard, { revision }));
    expect(html).toContain("开篇钩子");   // openingHook label
    expect(html).toContain("场景 2");     // scene-2 label
    expect(html).toContain("修复目标（2 处）");
  });
});

describe("ContractVerificationCard – p5AutoRevision integration", () => {
  it("renders P5RevisionCard when p5AutoRevision is candidate_pending_approval", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 0.6,
      items: [],
      shouldRewrite: true,
      p5AutoRevision: {
        editorReport: BASE_P5_EDITOR_REPORT,
        appliedFixes: ["修复钩子"],
        revisedBlueprintFulfillment: { score: 80, shouldRewrite: false, blockingIssues: [] },
        status: "candidate_pending_approval",
        runId: "run-integration-test",
      },
    };
    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("p5-revision-card");
    expect(html).toContain("蓝图定点修订候选（待批准）");
    expect(html).toContain("score: 80");
  });

  it("renders P5RevisionCard when p5AutoRevision is failed", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 0.3,
      items: [],
      shouldRewrite: true,
      p5AutoRevision: {
        status: "failed",
        error: "Connection refused",
      },
    };
    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).toContain("p5-revision-card");
    expect(html).toContain("蓝图定点修订失败");
    expect(html).toContain("Connection refused");
  });

  it("does not render P5RevisionCard when p5AutoRevision is absent", () => {
    const report: VerificationReportPayload = {
      satisfactionRate: 1.0,
      items: [],
      shouldRewrite: false,
    };
    const html = renderToStaticMarkup(createElement(ContractVerificationCard, { report }));
    expect(html).not.toContain("p5-revision-card");
  });
});
