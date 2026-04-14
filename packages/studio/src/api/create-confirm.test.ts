/**
 * Unit tests for confirmCreateBook + BookCreateRunStore.
 *
 * Covers:
 *  - Idempotency: duplicate confirm requests while active do not create a
 *    second pipeline run.
 *  - Failure recovery: a failed run can be retried; its state does not
 *    pollute subsequent successful runs.
 *  - Run-state lifecycle: queued → running → succeeded | failed progression.
 *  - Conflict detection: completed books still produce a 409-equivalent error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BookCreateRunStore } from "./lib/run-store.js";
import { confirmCreateBook } from "./services/create-flow-service.js";
import type { CreateFlowServiceDeps } from "./services/create-flow-service.js";
import type { StudioBookConfigDraft } from "./book-create.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBookId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function makeDeps(
  root: string,
  overrides: Partial<CreateFlowServiceDeps> = {},
): CreateFlowServiceDeps & { runStore: BookCreateRunStore; bookCreateStatus: Map<string, { status: "creating" | "error"; error?: string }> } {
  const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();
  const runStore = new BookCreateRunStore();
  return {
    bookDir: (id) => join(root, "books", id),
    broadcast: vi.fn(),
    bookCreateStatus,
    runStore,
    initBook: vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRequest(title: string) {
  return {
    bookConfig: { title, genre: "xuanhuan", language: "zh" as const },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("confirmCreateBook", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-confirm-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("returns the same bookId on duplicate requests while a run is active", async () => {
      let resolveInit!: () => void;
      const initBook = vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>(
        () => new Promise<void>((r) => { resolveInit = r; }),
      );
      const deps = makeDeps(root, { initBook });
      const req = makeRequest("My Novel");

      const first = await confirmCreateBook(req, deps);
      expect(first.bookId).toBe(makeBookId("My Novel"));

      // Second call while still running — must not launch a new pipeline
      const second = await confirmCreateBook(req, deps);
      expect(second.bookId).toBe(first.bookId);
      expect(initBook).toHaveBeenCalledTimes(1);

      resolveInit();
    });

    it("does not start a new run when status is 'queued'", async () => {
      // Manually set the store to queued without completing the run
      const deps = makeDeps(root);
      deps.runStore.enqueue(makeBookId("Queued Novel"));

      const req = makeRequest("Queued Novel");
      const result = await confirmCreateBook(req, deps);

      expect(result.bookId).toBe(makeBookId("Queued Novel"));
      // initBook must not have been called — idempotency gate fired
      expect(deps.initBook).not.toHaveBeenCalled();
    });

    it("does not start a new run when status is 'running'", async () => {
      const deps = makeDeps(root);
      deps.runStore.enqueue(makeBookId("Running Novel"));
      deps.runStore.markRunning(makeBookId("Running Novel"));

      const req = makeRequest("Running Novel");
      const result = await confirmCreateBook(req, deps);

      expect(result.bookId).toBe(makeBookId("Running Novel"));
      expect(deps.initBook).not.toHaveBeenCalled();
    });
  });

  // ── Failure recovery ─────────────────────────────────────────────────────

  describe("failure recovery", () => {
    it("allows a retry after a previous run has failed", async () => {
      const initBook = vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>();
      // First attempt: fail
      initBook.mockRejectedValueOnce(new Error("LLM unavailable"));
      // Second attempt: succeed
      initBook.mockResolvedValueOnce(undefined);

      const deps = makeDeps(root, { initBook });
      const req = makeRequest("Retry Novel");

      // First call — triggers the pipeline
      await confirmCreateBook(req, deps);
      // Wait for the rejection to propagate
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.runStore.get(makeBookId("Retry Novel"))?.status).toBe("failed");

      // Second call — should clear the failed state and start a new run
      await confirmCreateBook(req, deps);
      await Promise.resolve();
      await Promise.resolve();

      expect(initBook).toHaveBeenCalledTimes(2);
    });

    it("does not pollute a succeeded book when an unrelated book fails", async () => {
      const initBook = vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>();
      initBook.mockResolvedValueOnce(undefined); // book A succeeds
      initBook.mockRejectedValueOnce(new Error("oops")); // book B fails

      const deps = makeDeps(root, { initBook });

      await confirmCreateBook(makeRequest("Book A"), deps);
      await confirmCreateBook(makeRequest("Book B"), deps);
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.runStore.get(makeBookId("Book A"))?.status).toBe("succeeded");
      // Book A must remain succeeded — failure of Book B must not affect it
      expect(deps.runStore.get(makeBookId("Book B"))?.status).toBe("failed");
    });
  });

  // ── Run-state lifecycle ──────────────────────────────────────────────────

  describe("run-state lifecycle", () => {
    it("transitions from running to succeeded when initBook resolves", async () => {
      let resolveInit!: () => void;
      const initBook = vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>(
        () => new Promise<void>((r) => { resolveInit = r; }),
      );
      const deps = makeDeps(root, { initBook });
      const bookId = makeBookId("Lifecycle Success");

      await confirmCreateBook(makeRequest("Lifecycle Success"), deps);

      // After confirmCreateBook returns, the run is in "running" state
      expect(deps.runStore.get(bookId)?.status).toBe("running");

      // Resolve initBook — run should transition to "succeeded"
      resolveInit();
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.runStore.get(bookId)?.status).toBe("succeeded");
    });

    it("transitions from running to failed when initBook rejects", async () => {
      let rejectInit!: (err: Error) => void;
      const initBook = vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>(
        () => new Promise<void>((_, reject) => { rejectInit = reject; }),
      );
      const deps = makeDeps(root, { initBook });
      const bookId = makeBookId("Lifecycle Failure");

      await confirmCreateBook(makeRequest("Lifecycle Failure"), deps);

      expect(deps.runStore.get(bookId)?.status).toBe("running");

      rejectInit(new Error("pipeline crash"));
      await Promise.resolve();
      await Promise.resolve();

      const run = deps.runStore.get(bookId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("pipeline crash");
    });

    it("propagates failure error to the legacy bookCreateStatus map", async () => {
      const initBook = vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>().mockRejectedValueOnce(
        new Error("key missing"),
      );
      const deps = makeDeps(root, { initBook });
      const bookId = makeBookId("Legacy Compat");

      await confirmCreateBook(makeRequest("Legacy Compat"), deps);
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.bookCreateStatus.get(bookId)).toMatchObject({
        status: "error",
        error: "key missing",
      });
    });

    it("removes the legacy bookCreateStatus entry on success", async () => {
      const initBook = vi.fn<(bookConfig: StudioBookConfigDraft) => Promise<void>>().mockResolvedValueOnce(undefined);
      const deps = makeDeps(root, { initBook });
      const bookId = makeBookId("Legacy Success");

      await confirmCreateBook(makeRequest("Legacy Success"), deps);
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.bookCreateStatus.has(bookId)).toBe(false);
    });
  });

  // ── Conflict detection ───────────────────────────────────────────────────

  describe("conflict detection", () => {
    it("throws BOOK_CREATE_CONFLICT when the book already exists on disk", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const bookId = makeBookId("Existing Book");
      const bookDir = join(root, "books", bookId);
      await mkdir(join(bookDir, "story"), { recursive: true });
      await writeFile(join(bookDir, "book.json"), "{}", "utf-8");
      await writeFile(join(bookDir, "story", "story_bible.md"), "# Bible", "utf-8");

      const deps = makeDeps(root);
      await expect(
        confirmCreateBook(makeRequest("Existing Book"), deps),
      ).rejects.toMatchObject({ code: "BOOK_CREATE_CONFLICT" });
    });
  });
});
