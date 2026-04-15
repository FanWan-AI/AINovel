import { describe, expect, it } from "vitest";
import {
  buildAdvancedPlanPayload,
  deriveRuntimeControlState,
  deriveEventLevel,
  deriveEventSource,
  deriveRuntimeSessionViewModel,
  deriveRuntimeBookRunViewModels,
  filterEvents,
  deriveEmptyHint,
  parseBookIds,
  validateAdvancedForm,
} from "./RuntimeCenter";
import { derivePlanBudgetPreview } from "../components/daemon/PlanBudgetCard";
import { toggleBookSelection } from "../components/daemon/BookScopePicker";
import type { SSEMessage } from "../hooks/use-sse";
import type { DaemonSessionSummary } from "../shared/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(event: string, data: Record<string, unknown> = {}, timestamp = 0): SSEMessage {
  return { event, data, timestamp };
}

// ---------------------------------------------------------------------------
// deriveEventLevel
// ---------------------------------------------------------------------------

describe("deriveEventLevel", () => {
  it("reads level field from log events", () => {
    expect(deriveEventLevel(makeMsg("log", { level: "error" }))).toBe("error");
    expect(deriveEventLevel(makeMsg("log", { level: "WARN" }))).toBe("warn");
    expect(deriveEventLevel(makeMsg("log", { level: "Info" }))).toBe("info");
  });

  it("infers error from events ending in :error", () => {
    expect(deriveEventLevel(makeMsg("write:error"))).toBe("error");
    expect(deriveEventLevel(makeMsg("daemon:error"))).toBe("error");
  });

  it("infers error from semantic fail events", () => {
    expect(deriveEventLevel(makeMsg("rewrite:fail"))).toBe("error");
    expect(deriveEventLevel(makeMsg("revise:fail"))).toBe("error");
  });

  it("infers info from events ending in :complete or :start", () => {
    expect(deriveEventLevel(makeMsg("write:complete"))).toBe("info");
    expect(deriveEventLevel(makeMsg("draft:start"))).toBe("info");
    expect(deriveEventLevel(makeMsg("write-next:success"))).toBe("info");
  });

  it("falls back to debug for unrecognised events", () => {
    expect(deriveEventLevel(makeMsg("ping"))).toBe("debug");
    expect(deriveEventLevel(makeMsg("unknown"))).toBe("debug");
  });
});

// ---------------------------------------------------------------------------
// deriveEventSource
// ---------------------------------------------------------------------------

describe("deriveEventSource", () => {
  it("returns the prefix before the first colon", () => {
    expect(deriveEventSource(makeMsg("write:start"))).toBe("write");
    expect(deriveEventSource(makeMsg("daemon:chapter"))).toBe("daemon");
  });

  it("returns the full event name when there is no colon", () => {
    expect(deriveEventSource(makeMsg("ping"))).toBe("ping");
    expect(deriveEventSource(makeMsg("log"))).toBe("log");
  });
});

// ---------------------------------------------------------------------------
// filterEvents
// ---------------------------------------------------------------------------

const messages: ReadonlyArray<SSEMessage> = [
  makeMsg("write:start",    { bookId: "book1" }),
  makeMsg("write:complete", { bookId: "book1" }),
  makeMsg("daemon:error",   {}),
  makeMsg("log",            { level: "warn", message: "low disk" }),
  makeMsg("log",            { level: "info", message: "ok" }),
];

describe("filterEvents", () => {
  it("returns all messages when filter is empty", () => {
    const result = filterEvents(messages, { level: "", source: "", bookId: "" });
    expect(result).toHaveLength(messages.length);
  });

  it("filters by level", () => {
    const result = filterEvents(messages, { level: "error", source: "", bookId: "" });
    expect(result).toHaveLength(1);
    expect(result[0].event).toBe("daemon:error");
  });

  it("filters by source prefix", () => {
    const result = filterEvents(messages, { level: "", source: "write", bookId: "" });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.event.startsWith("write:"))).toBe(true);
  });

  it("filters by bookId", () => {
    const result = filterEvents(messages, { level: "", source: "", bookId: "book1" });
    expect(result).toHaveLength(2);
    expect(result.every((m) => (m.data as Record<string, unknown>).bookId === "book1")).toBe(true);
  });

  it("combines multiple filter criteria", () => {
    const result = filterEvents(messages, { level: "error", source: "daemon", bookId: "" });
    expect(result).toHaveLength(1);
    expect(result[0].event).toBe("daemon:error");
  });

  it("returns empty when nothing matches", () => {
    const result = filterEvents(messages, { level: "", source: "noop", bookId: "" });
    expect(result).toHaveLength(0);
  });

  it("hides noisy heartbeat messages", () => {
    const noisy: ReadonlyArray<SSEMessage> = [
      makeMsg("ping", {}, 1),
      makeMsg("log", { level: "debug", message: "ping null" }, 2),
      makeMsg("log", { level: "info", message: "real log" }, 3),
    ];
    const result = filterEvents(noisy, { level: "", source: "", bookId: "" });
    expect(result).toHaveLength(1);
    expect((result[0]?.data as { message?: string })?.message).toBe("real log");
  });
});

// ---------------------------------------------------------------------------
// deriveEmptyHint
// ---------------------------------------------------------------------------

describe("deriveEmptyHint", () => {
  it("shows the idle hint when daemon is stopped and no active filter", () => {
    expect(deriveEmptyHint(false, false)).toBe("rc.emptyIdle");
  });

  it("shows the running hint when daemon is running and no active filter", () => {
    expect(deriveEmptyHint(true, false)).toBe("rc.emptyRunning");
  });

  it("shows the filtered hint when a filter is active regardless of daemon state", () => {
    expect(deriveEmptyHint(false, true)).toBe("rc.emptyFiltered");
    expect(deriveEmptyHint(true, true)).toBe("rc.emptyFiltered");
  });
});

describe("parseBookIds", () => {
  it("parses comma/newline-separated book ids and deduplicates", () => {
    expect(parseBookIds("book-a, book-b\nbook-a")).toEqual(["book-a", "book-b"]);
  });
});

describe("validateAdvancedForm", () => {
  it("returns field errors for invalid advanced form", () => {
    const errors = validateAdvancedForm({
      scopeType: "book-list",
      bookIdsText: " ",
      perBookChapterCap: "0",
      globalChapterCap: "x",
      frequencyMinutes: "",
      cooldownSeconds: "0",
      concurrency: "-1",
    });

    expect(errors).toEqual([
      "rc.error.bookIdsRequired",
      "rc.error.perBookRequired",
      "rc.error.globalRequired",
      "rc.error.frequencyRequired",
      "rc.error.cooldownRequired",
      "rc.error.concurrencyRequired",
    ]);
  });

  it("allows all-active scope without book ids", () => {
    const errors = validateAdvancedForm({
      scopeType: "all-active",
      bookIdsText: "",
      perBookChapterCap: "2",
      globalChapterCap: "20",
      frequencyMinutes: "5",
      cooldownSeconds: "30",
      concurrency: "2",
    });

    expect(errors).toEqual([]);
  });
});

describe("buildAdvancedPlanPayload", () => {
  it("assembles advanced plan payload with custom plan mode", () => {
    expect(buildAdvancedPlanPayload({
      scopeType: "book-list",
      bookIdsText: "b1,b2,b1",
      perBookChapterCap: "2",
      globalChapterCap: "10",
      frequencyMinutes: "5",
      cooldownSeconds: "30",
      concurrency: "3",
    })).toEqual({
      plan: {
        mode: "custom-plan",
        bookScope: { type: "book-list", bookIds: ["b1", "b2"] },
        perBookChapterCap: 2,
        globalChapterCap: 10,
        schedule: { everyMinutes: 5, cooldownSeconds: 30 },
        maxConcurrentBooks: 3,
      },
    });
  });
});

describe("deriveRuntimeSessionViewModel", () => {
  it("renders session summary from daemon session + runtime events", () => {
    const session: DaemonSessionSummary = {
      state: "running",
      running: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastError: { message: "network timeout", timestamp: "2026-01-01T00:00:01.000Z" },
    };
    const model = deriveRuntimeSessionViewModel(session, [
      makeMsg("daemon:chapter", { bookId: "book-1", chapter: 3, status: "success" }),
      makeMsg("daemon:error", { error: "temporary issue" }),
    ]);

    expect(model).toEqual({
      state: "running",
      currentBook: "book-1",
      currentChapter: "3",
      completedCount: 1,
      failedCount: 1,
      recentError: "network timeout",
    });
  });

  it("falls back to daemon session fields when no daemon:chapter event exists", () => {
    const session: DaemonSessionSummary = {
      state: "running",
      running: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      currentBookId: "book-2",
      currentChapter: 8,
      completedCount: 12,
      failedCount: 2,
    };

    const model = deriveRuntimeSessionViewModel(
      session,
      [],
      new Map([["book-2", "多子多福"]]),
    );

    expect(model).toEqual({
      state: "running",
      currentBook: "多子多福",
      currentChapter: "8",
      completedCount: 12,
      failedCount: 2,
      recentError: "—",
    });
  });

  it("falls back to activeBookIds when currentBookId is missing", () => {
    const session: DaemonSessionSummary = {
      state: "running",
      running: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      activeBookIds: ["book-3"],
      completedCount: 0,
      failedCount: 0,
    };

    const model = deriveRuntimeSessionViewModel(
      session,
      [],
      new Map([["book-3", "选定书籍"]]),
    );

    expect(model).toEqual({
      state: "running",
      currentBook: "选定书籍",
      currentChapter: "待调度",
      completedCount: 0,
      failedCount: 0,
      recentError: "—",
    });
  });

  it("extracts chapter number from stage log when daemon:chapter event is not present", () => {
    const session: DaemonSessionSummary = {
      state: "running",
      running: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      currentBookId: "book-2",
      completedCount: 0,
      failedCount: 0,
    };
    const model = deriveRuntimeSessionViewModel(
      session,
      [makeMsg("log", { level: "info", message: "阶段 1：创作正文（第14章）" })],
      new Map([["book-2", "多子多福"]]),
    );
    expect(model.currentChapter).toBe("14");
  });
});

describe("deriveRuntimeControlState", () => {
  it("exposes button states for mode transitions", () => {
    expect(deriveRuntimeControlState("idle", false)).toEqual({
      showStart: true,
      showPause: false,
      showResume: false,
      stopDisabled: true,
    });
    expect(deriveRuntimeControlState("running", false)).toEqual({
      showStart: false,
      showPause: true,
      showResume: false,
      stopDisabled: false,
    });
    expect(deriveRuntimeControlState("paused", true)).toEqual({
      showStart: false,
      showPause: false,
      showResume: true,
      stopDisabled: true,
    });
  });
});

describe("deriveRuntimeBookRunViewModels", () => {
  it("builds per-book panels from activeBookIds and daemon chapter events", () => {
    const session: DaemonSessionSummary = {
      state: "running",
      running: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      activeBookIds: ["book-a", "book-b"],
      currentBookId: "book-b",
      completedCount: 3,
      failedCount: 0,
    };

    const rows = deriveRuntimeBookRunViewModels(
      session,
      [
        makeMsg("daemon:chapter", { bookId: "book-a", chapter: 11, status: "success" }),
        makeMsg("daemon:chapter", { bookId: "book-b", chapter: 14, status: "running" }),
      ],
      new Map([
        ["book-a", "书 A"],
        ["book-b", "书 B"],
      ]),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      bookId: "book-b",
      title: "书 B",
      chapter: "14",
      isCurrent: true,
    });
    expect(rows[1]).toMatchObject({
      bookId: "book-a",
      title: "书 A",
      chapter: "11",
      completedCount: 1,
      isCurrent: false,
    });
  });
});

describe("toggleBookSelection", () => {
  it("adds and removes selected ids immutably", () => {
    expect(toggleBookSelection([], "book-1", true)).toEqual(["book-1"]);
    expect(toggleBookSelection(["book-1"], "book-1", true)).toEqual(["book-1"]);
    expect(toggleBookSelection(["book-1", "book-2"], "book-1", false)).toEqual(["book-2"]);
  });
});

describe("derivePlanBudgetPreview", () => {
  it("computes estimated chapters and rounds from valid inputs", () => {
    expect(derivePlanBudgetPreview({
      perBookChapterCap: "3",
      globalChapterCap: "20",
      concurrency: "4",
      targetBookCount: 5,
    })).toEqual({
      perBookCap: 3,
      globalCap: 20,
      concurrency: 4,
      targetBookCount: 5,
      estimatedTotalChapters: 15,
      estimatedRounds: 4,
    });
  });

  it("returns pending estimate when inputs are incomplete or no targets", () => {
    expect(derivePlanBudgetPreview({
      perBookChapterCap: "3",
      globalChapterCap: "",
      concurrency: "2",
      targetBookCount: 2,
    }).estimatedRounds).toBeNull();
    expect(derivePlanBudgetPreview({
      perBookChapterCap: "3",
      globalChapterCap: "6",
      concurrency: "2",
      targetBookCount: 0,
    }).estimatedTotalChapters).toBeNull();
  });
});
