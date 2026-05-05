import { beforeEach, describe, expect, it } from "vitest";
import {
  createChapterRunId,
  loadChapterRuns,
  mapLifecycleActionTypes,
  saveChapterRuns,
  upsertLifecycleRun,
  type ChapterRunRecord,
} from "./use-chapter-runs";

function makeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data: Record<string, string> = {};
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
  };
}

describe("createChapterRunId", () => {
  it("returns a non-empty id", () => {
    expect(createChapterRunId()).toMatch(/^chapter-run-/);
  });
});

describe("load/save chapter runs", () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
  });

  it("round-trips stored runs", () => {
    const runs: ReadonlyArray<ChapterRunRecord> = [{
      id: "run-1",
      chapterNumber: 1,
      actionType: "spot-fix",
      status: "running",
      startedAt: 100,
    }];
    expect(saveChapterRuns("book-1", runs, storage)).toBeNull();
    expect(loadChapterRuns("book-1", storage).runs).toEqual(runs);
  });

  it("preserves P5 candidateStatus for audit-failed stored runs", () => {
    const runs: ReadonlyArray<ChapterRunRecord> = [{
      id: "run-p5",
      chapterNumber: 25,
      actionType: "blueprint-targeted-revise",
      status: "unchanged",
      startedAt: 100,
      candidateStatus: "audit-failed",
    }];
    expect(saveChapterRuns("book-1", runs, storage)).toBeNull();
    expect(loadChapterRuns("book-1", storage).runs[0]).toMatchObject({
      id: "run-p5",
      candidateStatus: "audit-failed",
    });
  });

  it("returns read error key when storage contains invalid JSON", () => {
    storage.setItem("inkos-chapter-runs-v1:book-1", "not-json");
    expect(loadChapterRuns("book-1", storage).error).toBe("chapterTaskCenter.storageReadFailed");
  });
});

describe("mapLifecycleActionTypes", () => {
  it("maps revise to all revise-mode action types", () => {
    expect(mapLifecycleActionTypes("revise")).toEqual(["spot-fix", "polish", "rework", "rewrite", "anti-detect"]);
  });
});

describe("upsertLifecycleRun", () => {
  it("updates latest running matching run", () => {
    const prev: ReadonlyArray<ChapterRunRecord> = [{
      id: "run-1",
      chapterNumber: 3,
      actionType: "polish",
      status: "running",
      startedAt: 1_000,
    }];

    const next = upsertLifecycleRun(prev, {
      chapterNumber: 3,
      action: "revise",
      stage: "success",
      timestamp: 1_500,
      briefSummary: "focus pacing",
    });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "run-1",
      status: "success",
      durationMs: 500,
      briefSummary: "focus pacing",
    });
  });

  it("ignores orphan lifecycle events when no matching task exists", () => {
    const next = upsertLifecycleRun([], {
      chapterNumber: 8,
      action: "anti-detect",
      stage: "fail",
      reason: "model timeout",
      timestamp: 9_999,
    });

    expect(next).toHaveLength(0);
  });
});
