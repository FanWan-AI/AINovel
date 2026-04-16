import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mapQualityDimensionRows, QualityReportCard } from "./QualityReportCard";

describe("QualityReportCard", () => {
  it("maps dimension scores into stable serializable integer values", () => {
    const rows = mapQualityDimensionRows({
      continuity: 88.6,
      readability: Number.NaN,
      styleConsistency: -5,
      aiTraceRisk: 130,
    });
    expect(rows.map((row) => row.score)).toEqual([89, 0, 0, 100]);
  });

  it("renders blocking issues, evidence and next action triggers", () => {
    const onRunNextAction = vi.fn();
    const html = renderToStaticMarkup(
      createElement(QualityReportCard, {
        report: {
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
            excerpt: "冲突目标与行动结果不一致",
            reason: "关键冲突未闭环",
          }],
        },
        suggestedNextActions: ["spot-fix", "re-audit"],
        onRunNextAction,
      }),
    );
    expect(html).toContain("assistant-quality-report-card");
    expect(html).toContain("动机承接偏弱");
    expect(html).toContain("chapter-run:run_01");
    expect(html).toContain("冲突目标与行动结果不一致");
    expect(html).toContain("下一步：spot-fix");
  });
});
