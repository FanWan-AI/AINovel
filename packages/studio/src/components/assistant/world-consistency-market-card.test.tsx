import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorldConsistencyMarketCard } from "./WorldConsistencyMarketCard";

describe("WorldConsistencyMarketCard", () => {
  it("renders blocking issues, market signals with source+timestamp, and repair task actions", () => {
    const html = renderToStaticMarkup(createElement(WorldConsistencyMarketCard, {
      report: {
        bookId: "demo-book",
        generatedAt: "2026-04-16T10:30:00.000Z",
        consistency: {
          blockingIssues: [{
            issueId: "wc-foreshadowing-unresolved-overload",
            title: "未回收伏笔积压",
            description: "检测到 3 条待回收伏笔。",
            recommendation: "优先安排章节回收积压伏笔。",
            evidence: {
              source: "story/pending_hooks.md",
              line: 3,
              excerpt: "- 黑纹戒指来历未回收",
            },
          }],
        },
        market: {
          summary: "都市悬疑趋势上升。",
          signals: [{
            signalId: "market_signal_01",
            source: "radar:番茄小说",
            timestamp: "2026-04-16T10:00:00.000Z",
            trend: "都市悬疑+系统博弈",
            recommendation: "题材热度稳定。",
            confidence: 0.81,
          }],
        },
        repairTasks: [{
          stepId: "wc_fix_01",
          action: "revise",
          mode: "spot-fix",
          chapter: 3,
          objective: "优先安排章节回收积压伏笔。",
        }],
      },
      onRunRepairTask: vi.fn(),
    }));

    expect(html).toContain("assistant-world-market-card");
    expect(html).toContain("未回收伏笔积压");
    expect(html).toContain("radar:番茄小说");
    expect(html).toContain("2026-04-16T10:00:00.000Z");
    expect(html).toContain("修复任务：wc_fix_01");
  });
});
