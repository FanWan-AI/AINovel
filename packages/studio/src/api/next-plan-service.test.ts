import { describe, expect, it } from "vitest";
import { previewNextPlan } from "./services/next-plan-service";

describe("previewNextPlan sanitization", () => {
  it("strips markdown and removes global planning lines from goal", async () => {
    const plan = await previewNextPlan("book-1", {}, {
      planChapter: async () => ({
        chapterNumber: 8,
        goal: "**总体规划：200章，六卷**\n- 本章让主角与债主正面摊牌",
        conflicts: ["主角要守住底线，债主逼迫他违约"],
      }),
    });

    expect(plan.goal).toBe("本章让主角与债主正面摊牌");
  });

  it("returns a conflict fallback when conflicts are empty after sanitization", async () => {
    const plan = await previewNextPlan("book-2", {}, {
      planChapter: async () => ({
        chapterNumber: 3,
        goal: "推进主线",
        conflicts: ["**总体规划：全书四卷**"],
      }),
    });

    expect(plan.conflicts.length).toBe(1);
    expect(plan.conflicts[0]).toContain("请补充本章冲突");
  });
});
