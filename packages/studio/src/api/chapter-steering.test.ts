/**
 * Tests for chapter-steering-service + GET/PUT /api/books/:id/steering-prefs.
 *
 * Covers:
 *  - validateSteeringPrefsInput — field-level validation
 *  - loadSteeringPrefs / saveSteeringPrefs — file I/O round-trip
 *  - GET /api/books/:id/steering-prefs — returns null when nothing saved
 *  - PUT /api/books/:id/steering-prefs — persists prefs and returns them
 *  - Security: path-traversal bookId is rejected with 400
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateSteeringPrefsInput,
  loadSteeringPrefs,
  saveSteeringPrefs,
  STEERING_PREFS_SCHEMA_VERSION,
} from "./services/chapter-steering-service.js";

// ---------------------------------------------------------------------------
// Service unit tests
// ---------------------------------------------------------------------------

describe("validateSteeringPrefsInput", () => {
  it("returns ok=false with a body error for non-object input", () => {
    const result = validateSteeringPrefsInput("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].field).toBe("body");
    }
  });

  it("returns ok=false with a body error for array input", () => {
    const result = validateSteeringPrefsInput([]);
    expect(result.ok).toBe(false);
  });

  it("returns ok=true for an empty object (all fields optional)", () => {
    const result = validateSteeringPrefsInput({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
  });

  it("accepts valid wordCount within range", () => {
    const result = validateSteeringPrefsInput({ wordCount: 2000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wordCount).toBe(2000);
    }
  });

  it("rejects wordCount below minimum", () => {
    const result = validateSteeringPrefsInput({ wordCount: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "wordCount")).toBe(true);
    }
  });

  it("rejects wordCount above maximum", () => {
    const result = validateSteeringPrefsInput({ wordCount: 99999 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "wordCount")).toBe(true);
    }
  });

  it("rejects non-integer wordCount", () => {
    const result = validateSteeringPrefsInput({ wordCount: 2000.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "wordCount")).toBe(true);
    }
  });

  it("rejects wordCount that is not a number", () => {
    const result = validateSteeringPrefsInput({ wordCount: "2000" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "wordCount")).toBe(true);
    }
  });

  it("accepts valid style string", () => {
    const result = validateSteeringPrefsInput({ style: "紧张、快节奏" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.style).toBe("紧张、快节奏");
    }
  });

  it("trims whitespace from style", () => {
    const result = validateSteeringPrefsInput({ style: "  浪漫  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.style).toBe("浪漫");
    }
  });

  it("rejects style that exceeds max length", () => {
    const result = validateSteeringPrefsInput({ style: "A".repeat(501) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "style")).toBe(true);
    }
  });

  it("rejects style that is not a string", () => {
    const result = validateSteeringPrefsInput({ style: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "style")).toBe(true);
    }
  });

  it("accepts valid instructions string", () => {
    const result = validateSteeringPrefsInput({ instructions: "请多使用环境描写烘托气氛。" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.instructions).toBe("请多使用环境描写烘托气氛。");
    }
  });

  it("trims whitespace from instructions", () => {
    const result = validateSteeringPrefsInput({ instructions: "  多对话  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.instructions).toBe("多对话");
    }
  });

  it("rejects instructions exceeding max length", () => {
    const result = validateSteeringPrefsInput({ instructions: "B".repeat(2001) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "instructions")).toBe(true);
    }
  });

  it("returns multiple errors when multiple fields are invalid", () => {
    const result = validateSteeringPrefsInput({ wordCount: 9999999, style: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("accepts all valid fields together", () => {
    const result = validateSteeringPrefsInput({
      wordCount: 3000,
      style: "悬疑、紧张",
      instructions: "多使用倒叙手法，增加悬念。",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wordCount).toBe(3000);
      expect(result.value.style).toBe("悬疑、紧张");
      expect(result.value.instructions).toBe("多使用倒叙手法，增加悬念。");
    }
  });
});

// ---------------------------------------------------------------------------
// File I/O tests
// ---------------------------------------------------------------------------

describe("loadSteeringPrefs / saveSteeringPrefs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "steering-prefs-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no prefs file exists", async () => {
    const bookDir = join(tmpDir, "books", "my-book");
    const prefs = await loadSteeringPrefs(bookDir);
    expect(prefs).toBeNull();
  });

  it("saves prefs and reads them back", async () => {
    const bookDir = join(tmpDir, "books", "my-book");
    const saved = await saveSteeringPrefs(bookDir, { wordCount: 2500, style: "快节奏" }, "2026-01-01T00:00:00.000Z");

    expect(saved.schemaVersion).toBe(STEERING_PREFS_SCHEMA_VERSION);
    expect(saved.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(saved.wordCount).toBe(2500);
    expect(saved.style).toBe("快节奏");

    const loaded = await loadSteeringPrefs(bookDir);
    expect(loaded).toEqual(saved);
  });

  it("creates the book directory if it does not exist", async () => {
    const bookDir = join(tmpDir, "books", "new-book");
    await saveSteeringPrefs(bookDir, { instructions: "简洁明快" });

    const loaded = await loadSteeringPrefs(bookDir);
    expect(loaded?.instructions).toBe("简洁明快");
  });

  it("writes valid JSON to disk with schemaVersion", async () => {
    const bookDir = join(tmpDir, "books", "json-book");
    await saveSteeringPrefs(bookDir, { wordCount: 1800 });

    const raw = await readFile(join(bookDir, "steering-prefs.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.wordCount).toBe(1800);
  });

  it("overwrites existing prefs with the new values", async () => {
    const bookDir = join(tmpDir, "books", "overwrite-book");
    await saveSteeringPrefs(bookDir, { wordCount: 1000 }, "2026-01-01T00:00:00.000Z");
    await saveSteeringPrefs(bookDir, { wordCount: 2000 }, "2026-06-01T00:00:00.000Z");

    const loaded = await loadSteeringPrefs(bookDir);
    expect(loaded?.wordCount).toBe(2000);
    expect(loaded?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests via createStudioServer
// ---------------------------------------------------------------------------

const loadProjectConfigMock = vi.fn();

vi.mock("@actalk/inkos-core", () => {
  class MockStateManager {
    constructor(private readonly root: string) {}
    bookDir(id: string): string { return join(this.root, "books", id); }
    async listBooks(): Promise<string[]> { return []; }
    async loadBookConfig(): Promise<never> { throw new Error("not implemented"); }
    async loadChapterIndex(): Promise<[]> { return []; }
    async saveChapterIndex(): Promise<void> {}
    async rollbackToChapter(): Promise<number[]> { return []; }
    async getNextChapterNumber(): Promise<number> { return 1; }
  }

  class MockPipelineRunner {}
  class MockScheduler {
    get isRunning() { return false; }
    async start() {}
    stop() {}
  }

  return {
    StateManager: MockStateManager,
    PipelineRunner: MockPipelineRunner,
    Scheduler: MockScheduler,
    createLLMClient: vi.fn(() => ({})),
    createLogger: vi.fn(() => ({ child: () => ({}), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    computeAnalytics: vi.fn(() => ({})),
    chatCompletion: vi.fn(),
    loadProjectConfig: loadProjectConfigMock,
    GLOBAL_ENV_PATH: join(tmpdir(), "inkos-global-steering.env"),
  };
});

const projectConfig = {
  name: "steering-test",
  version: "0.1.0",
  language: "zh",
  llm: {
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "gpt-5.4",
    temperature: 0.7,
    maxTokens: 4096,
    stream: false,
  },
  daemon: {
    schedule: { radarCron: "0 */6 * * *", writeCron: "*/15 * * * *" },
    maxConcurrentBooks: 1,
    chaptersPerCycle: 1,
    retryDelayMs: 30000,
    cooldownAfterChapterMs: 0,
    maxChaptersPerDay: 50,
  },
  modelOverrides: {},
  notify: [],
} as const;

describe("GET/PUT /api/books/:id/steering-prefs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-steering-http-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    loadProjectConfigMock.mockResolvedValue(structuredClone(projectConfig));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("GET returns { prefs: null } when no prefs file exists", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    const res = await app.request("http://localhost/api/books/my-book/steering-prefs");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ prefs: null });
  });

  it("PUT saves prefs and returns them", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    const res = await app.request("http://localhost/api/books/my-book/steering-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 3000, style: "悬疑", instructions: "多留悬念" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; prefs: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.prefs.wordCount).toBe(3000);
    expect(body.prefs.style).toBe("悬疑");
    expect(body.prefs.instructions).toBe("多留悬念");
    expect(body.prefs.schemaVersion).toBe(1);
    expect(typeof body.prefs.updatedAt).toBe("string");
  });

  it("GET returns saved prefs after a PUT", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    await app.request("http://localhost/api/books/my-book/steering-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 2000, style: "浪漫" }),
    });

    const res = await app.request("http://localhost/api/books/my-book/steering-prefs");
    expect(res.status).toBe(200);
    const body = await res.json() as { prefs: Record<string, unknown> };
    expect(body.prefs.wordCount).toBe(2000);
    expect(body.prefs.style).toBe("浪漫");
  });

  it("PUT returns 400 with errors for invalid wordCount", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    const res = await app.request("http://localhost/api/books/my-book/steering-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: -1 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { errors: Array<{ field: string }> };
    expect(body.errors.some((e) => e.field === "wordCount")).toBe(true);
  });

  it("PUT returns 400 for invalid JSON body", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    const res = await app.request("http://localhost/api/books/my-book/steering-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
  });

  it("GET rejects path-traversal bookId with 400", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    const res = await app.request("http://localhost/api/books/..%2Fetc%2Fpasswd/steering-prefs");
    expect(res.status).toBe(400);
  });

  it("PUT rejects path-traversal bookId with 400", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    const res = await app.request("http://localhost/api/books/..%2Fetc%2Fpasswd/steering-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 2000 }),
    });

    expect(res.status).toBe(400);
  });

  it("PUT with only instructions field is accepted", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    const res = await app.request("http://localhost/api/books/instructions-only/steering-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "请专注于主角的内心独白。" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; prefs: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.prefs.instructions).toBe("请专注于主角的内心独白。");
    expect(body.prefs.wordCount).toBeUndefined();
  });

  it("prefs are isolated per book — different bookIds do not share prefs", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(structuredClone(projectConfig) as never, root);

    await app.request("http://localhost/api/books/book-alpha/steering-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 1500 }),
    });

    const res = await app.request("http://localhost/api/books/book-beta/steering-prefs");
    expect(res.status).toBe(200);
    const body = await res.json() as { prefs: null };
    expect(body.prefs).toBeNull();
  });
});
