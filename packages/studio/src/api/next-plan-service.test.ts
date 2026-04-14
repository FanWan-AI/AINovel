import { describe, expect, it } from "vitest";
import { previewNextPlan, isPlanLowQuality, PlanLowConfidenceError } from "./services/next-plan-service";

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

  it("throws PlanLowConfidenceError when conflicts are all global-planning lines (both attempts)", async () => {
    await expect(
      previewNextPlan("book-2", {}, {
        planChapter: async () => ({
          chapterNumber: 3,
          goal: "推进主线",
          conflicts: ["**总体规划：全书四卷**"],
        }),
      }),
    ).rejects.toBeInstanceOf(PlanLowConfidenceError);
  });
});

// ---------------------------------------------------------------------------
// isPlanLowQuality — quality detection
// ---------------------------------------------------------------------------

describe("isPlanLowQuality", () => {
  it("returns false for a high-quality plan with specific goal and conflict", () => {
    expect(isPlanLowQuality({
      chapterNumber: 1,
      goal: "主角揭露幕后黑手",
      conflicts: ["外部冲突: 追杀与逃亡"],
    })).toBe(false);
  });

  it("returns true when goal is the generic fallback placeholder", () => {
    expect(isPlanLowQuality({
      chapterNumber: 1,
      goal: "推进本章核心事件，并让主角做出一个带代价的关键选择。",
      conflicts: ["外部冲突: 追杀与逃亡"],
    })).toBe(true);
  });

  it("returns true when goal is empty", () => {
    expect(isPlanLowQuality({
      chapterNumber: 1,
      goal: "",
      conflicts: ["外部冲突: 追杀与逃亡"],
    })).toBe(true);
  });

  it("returns true when all conflicts are the fallback prompt", () => {
    expect(isPlanLowQuality({
      chapterNumber: 1,
      goal: "主角揭露幕后黑手",
      conflicts: ["请补充本章冲突：主角想达成什么、被谁阻拦、失败代价是什么。"],
    })).toBe(true);
  });

  it("returns true when conflicts array is empty", () => {
    expect(isPlanLowQuality({
      chapterNumber: 1,
      goal: "主角揭露幕后黑手",
      conflicts: [],
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// previewNextPlan — auto retry and PlanLowConfidenceError
// ---------------------------------------------------------------------------

describe("previewNextPlan quality gate", () => {
  it("returns the plan immediately if the first attempt passes quality check", async () => {
    let callCount = 0;
    const plan = await previewNextPlan("book-1", {}, {
      planChapter: async () => {
        callCount++;
        return {
          chapterNumber: 5,
          goal: "主角发现幕后真相并面临抉择",
          conflicts: ["外部冲突: 追杀与逃亡"],
        };
      },
    });

    expect(callCount).toBe(1);
    expect(plan.goal).toBe("主角发现幕后真相并面临抉择");
  });

  it("retries once when the first attempt is low quality and returns retry result", async () => {
    let callCount = 0;
    const plan = await previewNextPlan("book-2", {}, {
      planChapter: async () => {
        callCount++;
        if (callCount === 1) {
          // First call: low quality — goal is the fallback placeholder
          return {
            chapterNumber: 3,
            goal: "推进本章核心事件，并让主角做出一个带代价的关键选择。",
            conflicts: ["请补充本章冲突：主角想达成什么、被谁阻拦、失败代价是什么。"],
          };
        }
        // Second call: good quality
        return {
          chapterNumber: 3,
          goal: "主角揭露幕后黑手",
          conflicts: ["外部冲突: 债主逼迫主角违约"],
        };
      },
    });

    expect(callCount).toBe(2);
    expect(plan.goal).toBe("主角揭露幕后黑手");
  });

  it("throws PlanLowConfidenceError when both attempts produce low-quality output", async () => {
    let callCount = 0;
    await expect(
      previewNextPlan("book-3", {}, {
        planChapter: async () => {
          callCount++;
          return {
            chapterNumber: 1,
            goal: "推进本章核心事件，并让主角做出一个带代价的关键选择。",
            conflicts: ["请补充本章冲突：主角想达成什么、被谁阻拦、失败代价是什么。"],
          };
        },
      }),
    ).rejects.toBeInstanceOf(PlanLowConfidenceError);

    expect(callCount).toBe(2);
  });
});
