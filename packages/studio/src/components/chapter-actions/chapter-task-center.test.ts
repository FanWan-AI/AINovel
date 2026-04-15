import { describe, expect, it } from "vitest";
import { filterTaskRuns, formatRunDuration } from "./ChapterTaskCenter";
import type { TFunction } from "../../hooks/use-i18n";
import type { ChapterRunRecord } from "../../hooks/use-chapter-runs";

const t: TFunction = (key) => key;

const runs: ReadonlyArray<ChapterRunRecord> = [
  {
    id: "run-1",
    chapterNumber: 1,
    actionType: "spot-fix",
    status: "success",
    startedAt: 1,
    durationMs: 250,
  },
  {
    id: "run-2",
    chapterNumber: 2,
    actionType: "anti-detect",
    status: "failed",
    startedAt: 2,
  },
  {
    id: "run-3",
    chapterNumber: 2,
    actionType: "rewrite",
    status: "running",
    startedAt: 3,
  },
];

describe("filterTaskRuns", () => {
  it("supports chapter + status + action filters", () => {
    const result = filterTaskRuns(runs, 2, "failed", "anti-detect");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("run-2");
  });

  it("returns all records when all filters are all", () => {
    expect(filterTaskRuns(runs, "all", "all", "all")).toHaveLength(3);
  });
});

describe("formatRunDuration", () => {
  it("formats pending state when duration is missing", () => {
    expect(formatRunDuration(undefined, t)).toBe("chapterTaskCenter.durationPending");
  });

  it("formats milliseconds and seconds", () => {
    expect(formatRunDuration(500, t)).toBe("500ms");
    expect(formatRunDuration(2450, t)).toBe("2.5s");
  });
});
