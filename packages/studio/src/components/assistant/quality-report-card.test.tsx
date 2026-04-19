import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mapQualityDimensionRows, QualityReportCard } from "./QualityReportCard";

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

  it("renders chapter/book toggles, cache badge and markdown evidence", () => {
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
              excerpt: "主线围绕王城阴谋推进。",
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
    expect(html).toContain("章节视图");
    expect(html).toContain("全书视图");
    expect(html).toContain("已复用 book memory 缓存");
    expect(html).toContain("动机承接偏弱");
    expect(html).toContain("chapter-run:run_01");
    expect(html).toContain("<table>");
    expect(html).toContain("目标与结果不一致");
    expect(html).not.toContain("下一步：spot-fix");
  });
});
