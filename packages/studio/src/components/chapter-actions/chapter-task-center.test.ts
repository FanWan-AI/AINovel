import { describe, expect, it } from "vitest";
import { filterTaskRuns, formatRunDuration, actionTypeLabel, isAuditFailedP5Run } from "./ChapterTaskCenter";
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

describe("actionTypeLabel", () => {
  it("returns 蓝图定点修订 for blueprint-targeted-revise", () => {
    expect(actionTypeLabel("blueprint-targeted-revise", t)).toBe("蓝图定点修订");
  });

  it("returns book.rewrite for rewrite", () => {
    expect(actionTypeLabel("rewrite", t)).toBe("book.rewrite");
  });

  it("returns book.antiDetect for anti-detect", () => {
    expect(actionTypeLabel("anti-detect", t)).toBe("book.antiDetect");
  });

  it("returns resync fallback for resync", () => {
    expect(actionTypeLabel("resync", t)).toBe("chapterTaskCenter.actionResync");
  });
});

describe("isAuditFailedP5Run", () => {
  const base: ChapterRunRecord = {
    id: "r1",
    chapterNumber: 1,
    actionType: "blueprint-targeted-revise",
    status: "unchanged",
    startedAt: Date.now(),
  };

  it("returns true for blueprint-targeted-revise + unchanged + audit-failed candidate", () => {
    expect(isAuditFailedP5Run({ ...base, candidateStatus: "audit-failed" })).toBe(true);
  });

  it("returns false when candidateStatus is ready-for-review", () => {
    expect(isAuditFailedP5Run({ ...base, candidateStatus: "ready-for-review" })).toBe(false);
  });

  it("returns false when candidateStatus is absent", () => {
    expect(isAuditFailedP5Run(base)).toBe(false);
  });

  it("returns false for non-P5 action types", () => {
    expect(isAuditFailedP5Run({ ...base, actionType: "spot-fix", candidateStatus: "audit-failed" })).toBe(false);
  });

  it("returns false when run is not in unchanged status", () => {
    expect(isAuditFailedP5Run({ ...base, status: "success", candidateStatus: "audit-failed" })).toBe(false);
  });
});
