import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildQualitySnapshot, mapQualityDimensionRows, QualityReportCard } from "./QualityReportCard";

describe("QualityReportCard", () => {
  it("maps chapter and book dimension scores into stable serializable integer values", () => {
    const chapterRows = mapQualityDimensionRows({
      scopeType: "chapter",
      overallScore: 0,
      dimensions: {
        continuity: 88.6,
        readability: Number.NaN,
        styleConsistency: -5,
        aiTraceRisk: 130,
      },
      blockingIssues: [],
      evidence: [],
    });
    expect(chapterRows.map((row) => row.score)).toEqual([89, 0, 0, 100]);

    const bookRows = mapQualityDimensionRows({
      scopeType: "book",
      overallScore: 0,
      dimensions: {
        mainline: 84.5,
        character: 79.1,
        foreshadowing: 73.9,
        repetition: 68.4,
        style: 90,
        pacing: 62.2,
      },
      blockingIssues: [],
      evidence: [],
    });
    expect(bookRows.map((row) => row.score)).toEqual([85, 79, 74, 68, 90, 62]);
  });

  it("builds a compact book health snapshot with actionable issues", () => {
    const snapshot = buildQualitySnapshot({
      scopeType: "book",
      overallScore: 68,
      dimensions: {
        mainline: 82,
        character: 81,
        foreshadowing: 30,
        repetition: 72,
        style: 78,
        pacing: 62,
      },
      blockingIssues: ["最新章节运行中有 1 条失败记录，需先处理阻断问题。"],
      evidence: [],
    });

    expect(snapshot).toEqual({
      label: "全书健康",
      score: 68,
      summaryParts: ["伏笔积压", "有失败运行", "节奏偏弱"],
      actionItems: [
        "伏笔积压：伏笔分 30，优先回收或关闭旧钩子。",
        "最新章节运行中有 1 条失败记录，需先处理阻断问题。",
        "节奏偏弱：节奏分 62，下一章需要明确推进或降调喘息。",
      ],
    });
  });

  it("renders a collapsed health strip by default without long evidence text", () => {
    const onRunNextAction = vi.fn();
    const html = renderToStaticMarkup(
      createElement(QualityReportCard, {
        report: {
          chapter: {
            scopeType: "chapter",
            overallScore: 78,
            dimensions: {
              continuity: 81,
              readability: 76,
              styleConsistency: 74,
              aiTraceRisk: 69,
            },
            blockingIssues: ["动机承接偏弱"],
            evidence: [{
              source: "chapter-run:run_01:book:demo-book:chapter:14",
              excerpt: "| 维度 | 观察 |\n| --- | --- |\n| 冲突 | 目标与结果不一致 |",
              reason: "关键冲突未闭环",
            }],
            cached: true,
          },
          book: {
            scopeType: "book",
            overallScore: 82,
            dimensions: {
              mainline: 84,
              character: 80,
              foreshadowing: 79,
              repetition: 77,
              style: 83,
              pacing: 81,
            },
            blockingIssues: [],
            evidence: [{
              source: "book-story:demo-book:story_bible.md",
              excerpt: "主线围绕王城阴谋推进。这是一段很长的证据原文，不应该在默认健康条中直接铺开。",
              reason: "story_bible 与章节覆盖率一致。",
            }],
            cached: true,
          },
        },
        suggestedNextActions: ["spot-fix", "re-audit"],
        onRunNextAction,
      }),
    );
    expect(html).toContain("assistant-quality-report-card");
    expect(html).toContain("全书健康：82");
    expect(html).toContain("已复用 book memory 缓存");
    expect(html).toContain("查看全书健康");
    expect(html).not.toContain("章节视图");
    expect(html).not.toContain("全书视图");
    expect(html).not.toContain("动机承接偏弱");
    expect(html).not.toContain("chapter-run:run_01");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("目标与结果不一致");
    expect(html).not.toContain("不应该在默认健康条中直接铺开");
    expect(html).not.toContain("下一步：spot-fix");
  });
});
