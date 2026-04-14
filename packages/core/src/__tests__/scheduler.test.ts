import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler, type RunPlan, type SchedulerConfig } from "../pipeline/scheduler.js";
import type { BookConfig } from "../models/book.js";

function createConfig(): SchedulerConfig {
  return {
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 1024,
        thinkingBudget: 0, maxTokensCap: null,
      },
    } as SchedulerConfig["client"],
    model: "test-model",
    projectRoot: process.cwd(),
    radarCron: "*/1 * * * *",
    writeCron: "*/1 * * * *",
    maxConcurrentBooks: 1,
    chaptersPerCycle: 1,
    retryDelayMs: 0,
    cooldownAfterChapterMs: 0,
    maxChaptersPerDay: 10,
  };
}

function createBookConfig(id: string): BookConfig {
  return {
    id,
    title: id,
    platform: "other",
    genre: "other",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 2200,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("Scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not start a second write cycle while one is still running", async () => {
    const scheduler = new Scheduler(createConfig());
    let releaseCycle: (() => void) | undefined;
    const blockedCycle = new Promise<void>((resolve) => {
      releaseCycle = resolve;
    });

    const runWriteCycle = vi
      .spyOn(scheduler as unknown as { runWriteCycle: () => Promise<void> }, "runWriteCycle")
      .mockImplementation(async () => {
        if (runWriteCycle.mock.calls.length === 1) {
          return;
        }
        await blockedCycle;
      });
    vi.spyOn(scheduler as unknown as { runRadarScan: () => Promise<void> }, "runRadarScan")
      .mockResolvedValue(undefined);

    await scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runWriteCycle).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runWriteCycle).toHaveBeenCalledTimes(2);

    releaseCycle?.();
    await blockedCycle;
    scheduler.stop();
  });

  it("treats state-degraded chapter results as handled failures", async () => {
    const onChapterComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      onChapterComplete,
    });
    const bookConfig: BookConfig = {
      id: "book-1",
      title: "Book 1",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2200,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };

    vi.spyOn(
      (scheduler as unknown as { pipeline: { writeNextChapter: (bookId: string, words?: number, temp?: number) => Promise<unknown> } }).pipeline,
      "writeNextChapter",
    ).mockResolvedValue({
        chapterNumber: 3,
        title: "Broken State",
        wordCount: 2100,
        revised: false,
        status: "state-degraded",
        auditResult: {
          passed: true,
          issues: [{
            severity: "warning",
            category: "state-validation",
            description: "state validation still failed after retry",
            suggestion: "repair state before continuing",
          }],
          summary: "clean",
        },
    });
    const handleAuditFailure = vi.spyOn(
      scheduler as unknown as { handleAuditFailure: (bookId: string, chapterNumber: number, issueCategories?: string[]) => Promise<void> },
      "handleAuditFailure",
    ).mockResolvedValue(undefined);

    const success = await (
      scheduler as unknown as {
        writeOneChapter: (bookId: string, bookConfig: BookConfig) => Promise<boolean>;
      }
    ).writeOneChapter("book-1", bookConfig);

    expect(success).toBe(false);
    expect(handleAuditFailure).toHaveBeenCalledWith("book-1", 3, ["state-validation"]);
    expect(onChapterComplete).toHaveBeenCalledWith("book-1", 3, "state-degraded");
  });

  it("runs only books listed in custom plan scope", async () => {
    const scheduler = new Scheduler({
      ...createConfig(),
      maxConcurrentBooks: 5,
    });
    const plan: RunPlan = {
      mode: "custom-plan",
      bookScope: {
        type: "book-list",
        bookIds: ["book-2"],
      },
      perBookChapterCap: 3,
      globalChapterCap: 3,
    };

    (scheduler as unknown as { running: boolean }).running = true;
    (scheduler as unknown as { runPlan?: RunPlan }).runPlan = plan;

    vi.spyOn(
      (scheduler as unknown as { state: { listBooks: () => Promise<string[]> } }).state,
      "listBooks",
    ).mockResolvedValue(["book-1", "book-2", "book-3"]);
    vi.spyOn(
      (scheduler as unknown as { state: { loadBookConfig: (bookId: string) => Promise<BookConfig> } }).state,
      "loadBookConfig",
    ).mockImplementation(async (bookId: string) => createBookConfig(bookId));

    const processBook = vi.spyOn(
      scheduler as unknown as { processBook: (bookId: string, bookConfig: BookConfig) => Promise<void> },
      "processBook",
    ).mockResolvedValue(undefined);

    await (scheduler as unknown as { runWriteCycle: () => Promise<void> }).runWriteCycle();

    expect(processBook).toHaveBeenCalledTimes(1);
    expect(processBook).toHaveBeenCalledWith("book-2", expect.objectContaining({ id: "book-2" }));
  });

  it("stops writing when custom plan reaches global chapter cap", async () => {
    const scheduler = new Scheduler({
      ...createConfig(),
      maxConcurrentBooks: 5,
      chaptersPerCycle: 5,
    });
    const plan: RunPlan = {
      mode: "custom-plan",
      bookScope: { type: "all-active" },
      perBookChapterCap: 10,
      globalChapterCap: 2,
    };

    (scheduler as unknown as { running: boolean }).running = true;
    (scheduler as unknown as { runPlan?: RunPlan }).runPlan = plan;

    vi.spyOn(
      (scheduler as unknown as { state: { listBooks: () => Promise<string[]> } }).state,
      "listBooks",
    ).mockResolvedValue(["book-1", "book-2"]);
    vi.spyOn(
      (scheduler as unknown as { state: { loadBookConfig: (bookId: string) => Promise<BookConfig> } }).state,
      "loadBookConfig",
    ).mockImplementation(async (bookId: string) => createBookConfig(bookId));
    const writeOneChapter = vi.spyOn(
      scheduler as unknown as { writeOneChapter: (bookId: string, bookConfig: BookConfig) => Promise<boolean> },
      "writeOneChapter",
    ).mockResolvedValue(true);

    await (scheduler as unknown as { runWriteCycle: () => Promise<void> }).runWriteCycle();

    expect(writeOneChapter).toHaveBeenCalledTimes(2);
    expect(writeOneChapter).toHaveBeenNthCalledWith(1, "book-1", expect.objectContaining({ id: "book-1" }));
    expect(writeOneChapter).toHaveBeenNthCalledWith(2, "book-1", expect.objectContaining({ id: "book-1" }));
  });

  it("does not fall back to full scan for custom plan with empty book list", async () => {
    const scheduler = new Scheduler({
      ...createConfig(),
      maxConcurrentBooks: 5,
    });
    const plan: RunPlan = {
      mode: "custom-plan",
      bookScope: {
        type: "book-list",
        bookIds: [],
      },
      perBookChapterCap: 1,
      globalChapterCap: 1,
    };

    (scheduler as unknown as { running: boolean }).running = true;
    (scheduler as unknown as { runPlan?: RunPlan }).runPlan = plan;

    const listBooks = vi.spyOn(
      (scheduler as unknown as { state: { listBooks: () => Promise<string[]> } }).state,
      "listBooks",
    ).mockResolvedValue(["book-1", "book-2"]);
    const loadBookConfig = vi.spyOn(
      (scheduler as unknown as { state: { loadBookConfig: (bookId: string) => Promise<BookConfig> } }).state,
      "loadBookConfig",
    ).mockResolvedValue(createBookConfig("book-1"));
    const processBook = vi.spyOn(
      scheduler as unknown as { processBook: (bookId: string, bookConfig: BookConfig) => Promise<void> },
      "processBook",
    ).mockResolvedValue(undefined);

    await (scheduler as unknown as { runWriteCycle: () => Promise<void> }).runWriteCycle();

    expect(listBooks).toHaveBeenCalledTimes(1);
    expect(loadBookConfig).not.toHaveBeenCalled();
    expect(processBook).not.toHaveBeenCalled();
  });
});
