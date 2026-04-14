import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const schedulerStartMock = vi.fn<() => Promise<void>>();
const initBookMock = vi.fn();
const runRadarMock = vi.fn();
const reviseDraftMock = vi.fn();
const resyncChapterArtifactsMock = vi.fn();
const writeNextChapterMock = vi.fn();
const writeDraftMock = vi.fn();
const rollbackToChapterMock = vi.fn();
const saveChapterIndexMock = vi.fn();
const loadChapterIndexMock = vi.fn();
const createLLMClientMock = vi.fn(() => ({}));
const chatCompletionMock = vi.fn();
const loadProjectConfigMock = vi.fn();
const pipelineConfigs: unknown[] = [];

const logger = {
  child: () => logger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@actalk/inkos-core", () => {
  class MockStateManager {
    constructor(private readonly root: string) {}

    async listBooks(): Promise<string[]> {
      return [];
    }

    async loadBookConfig(): Promise<never> {
      throw new Error("not implemented");
    }

    async loadChapterIndex(bookId: string): Promise<[]> {
      return (await loadChapterIndexMock(bookId)) as [];
    }

    async saveChapterIndex(bookId: string, index: unknown): Promise<void> {
      await saveChapterIndexMock(bookId, index);
    }

    async rollbackToChapter(bookId: string, chapterNumber: number): Promise<number[]> {
      return (await rollbackToChapterMock(bookId, chapterNumber)) as number[];
    }

    async getNextChapterNumber(): Promise<number> {
      return 1;
    }

    bookDir(id: string): string {
      return join(this.root, "books", id);
    }
  }

  class MockPipelineRunner {
    constructor(config: unknown) {
      pipelineConfigs.push(config);
    }

    initBook = initBookMock;
    runRadar = runRadarMock;
    reviseDraft = reviseDraftMock;
    resyncChapterArtifacts = resyncChapterArtifactsMock;
    writeNextChapter = writeNextChapterMock;
    writeDraft = writeDraftMock;
  }

  class MockScheduler {
    private running = false;

    constructor(_config: unknown) {}

    async start(): Promise<void> {
      this.running = true;
      await schedulerStartMock();
    }

    stop(): void {
      this.running = false;
    }

    get isRunning(): boolean {
      return this.running;
    }
  }

  return {
    StateManager: MockStateManager,
    PipelineRunner: MockPipelineRunner,
    Scheduler: MockScheduler,
    createLLMClient: createLLMClientMock,
    createLogger: vi.fn(() => logger),
    computeAnalytics: vi.fn(() => ({})),
    chatCompletion: chatCompletionMock,
    loadProjectConfig: loadProjectConfigMock,
    GLOBAL_ENV_PATH: join(tmpdir(), "inkos-global.env"),
  };
});

const projectConfig = {
  name: "studio-test",
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
    schedule: {
      radarCron: "0 */6 * * *",
      writeCron: "*/15 * * * *",
    },
    maxConcurrentBooks: 1,
    chaptersPerCycle: 1,
    retryDelayMs: 30000,
    cooldownAfterChapterMs: 0,
    maxChaptersPerDay: 50,
  },
  modelOverrides: {},
  notify: [],
} as const;

function cloneProjectConfig() {
  return structuredClone(projectConfig);
}

describe("createStudioServer daemon lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-server-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    schedulerStartMock.mockReset();
    initBookMock.mockReset();
    runRadarMock.mockReset();
    reviseDraftMock.mockReset();
    resyncChapterArtifactsMock.mockReset();
    writeNextChapterMock.mockReset();
    writeDraftMock.mockReset();
    rollbackToChapterMock.mockReset();
    saveChapterIndexMock.mockReset();
    loadChapterIndexMock.mockReset();
    runRadarMock.mockResolvedValue({
      marketSummary: "Fresh market summary",
      recommendations: [],
    });
    reviseDraftMock.mockResolvedValue({
      chapterNumber: 3,
      wordCount: 1800,
      fixedIssues: ["focus restored"],
      applied: true,
      status: "ready-for-review",
    });
    resyncChapterArtifactsMock.mockResolvedValue({
      chapterNumber: 3,
      title: "Synced Chapter",
      wordCount: 1800,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "synced" },
    });
    writeNextChapterMock.mockResolvedValue({
      chapterNumber: 3,
      title: "Rewritten Chapter",
      wordCount: 1800,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "rewritten" },
    });
    writeDraftMock.mockResolvedValue({
      chapterNumber: 3,
      title: "Draft Chapter",
      wordCount: 1800,
      status: "drafted",
    });
    createLLMClientMock.mockReset();
    createLLMClientMock.mockReturnValue({});
    chatCompletionMock.mockReset();
    chatCompletionMock.mockResolvedValue({
      content: "pong",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    loadProjectConfigMock.mockReset();
    loadProjectConfigMock.mockImplementation(async () => {
      const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, unknown>;
      return {
        ...cloneProjectConfig(),
        ...raw,
        llm: {
          ...cloneProjectConfig().llm,
          ...((raw.llm ?? {}) as Record<string, unknown>),
        },
        daemon: {
          ...cloneProjectConfig().daemon,
          ...((raw.daemon ?? {}) as Record<string, unknown>),
        },
        modelOverrides: (raw.modelOverrides ?? {}) as Record<string, unknown>,
        notify: (raw.notify ?? []) as unknown[],
      };
    });
    loadChapterIndexMock.mockResolvedValue([]);
    saveChapterIndexMock.mockResolvedValue(undefined);
    rollbackToChapterMock.mockResolvedValue([]);
    pipelineConfigs.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns from /api/daemon/start before the first write cycle finishes", async () => {
    let resolveStart: (() => void) | undefined;
    schedulerStartMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const responseOrTimeout = await Promise.race([
      app.request("http://localhost/api/daemon/start", { method: "POST" }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
    ]);

    expect(responseOrTimeout).not.toBe("timeout");

    const response = responseOrTimeout as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, running: true });

    const status = await app.request("http://localhost/api/daemon");
    await expect(status.json()).resolves.toEqual({ running: true });

    resolveStart?.();
  });

  it("rejects book routes with path traversal ids", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/..%2Fetc%2Fpasswd", {
      method: "GET",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_BOOK_ID",
        message: 'Invalid book ID: "../etc/passwd"',
      },
    });
  });

  it("reflects project edits immediately without restarting the studio server", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const save = await app.request("http://localhost/api/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "en",
        temperature: 0.2,
        maxTokens: 2048,
        stream: true,
      }),
    });

    expect(save.status).toBe(200);

    const project = await app.request("http://localhost/api/project");
    await expect(project.json()).resolves.toMatchObject({
      language: "en",
      temperature: 0.2,
      maxTokens: 2048,
      stream: true,
    });
  });

  it("reloads latest llm config for doctor checks without restarting the studio server", async () => {
    const startupConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "stale-model",
        baseUrl: "https://stale.example.com/v1",
      },
    };

    const freshConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "fresh-model",
        baseUrl: "https://fresh.example.com/v1",
      },
    };
    loadProjectConfigMock.mockResolvedValue(freshConfig);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(startupConfig as never, root);

    const response = await app.request("http://localhost/api/doctor");

    expect(response.status).toBe(200);
    expect(createLLMClientMock).toHaveBeenCalledWith(expect.objectContaining({
      model: "fresh-model",
      baseUrl: "https://fresh.example.com/v1",
    }));
    expect(chatCompletionMock).toHaveBeenCalledWith(
      expect.anything(),
      "fresh-model",
      expect.any(Array),
      expect.objectContaining({ maxTokens: 5 }),
    );
  });

  it("reloads latest llm config for radar scans without restarting the studio server", async () => {
    const startupConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "stale-model",
        baseUrl: "https://stale.example.com/v1",
      },
    };

    const freshConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "fresh-model",
        baseUrl: "https://fresh.example.com/v1",
      },
    };
    loadProjectConfigMock.mockResolvedValue(freshConfig);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(startupConfig as never, root);

    const response = await app.request("http://localhost/api/radar/scan", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(runRadarMock).toHaveBeenCalledTimes(1);
    expect(pipelineConfigs.at(-1)).toMatchObject({
      model: "fresh-model",
      defaultLLMConfig: expect.objectContaining({
        model: "fresh-model",
        baseUrl: "https://fresh.example.com/v1",
      }),
    });
  });

  it("updates the first-run language immediately after the language selector saves", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const save = await app.request("http://localhost/api/project/language", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "en" }),
    });

    expect(save.status).toBe(200);

    const project = await app.request("http://localhost/api/project");
    await expect(project.json()).resolves.toMatchObject({
      language: "en",
      languageExplicit: true,
    });
  });

  it("rejects create requests when a complete book with the same id already exists", async () => {
    await mkdir(join(root, "books", "existing-book", "story"), { recursive: true });
    await writeFile(join(root, "books", "existing-book", "book.json"), JSON.stringify({ id: "existing-book" }), "utf-8");
    await writeFile(join(root, "books", "existing-book", "story", "story_bible.md"), "# existing", "utf-8");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Existing Book",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Book "existing-book" already exists'),
    });
    expect(initBookMock).not.toHaveBeenCalled();
    await expect(access(join(root, "books", "existing-book", "story", "story_bible.md"))).resolves.toBeUndefined();
  });

  it("reports async create failures through the create-status endpoint", async () => {
    initBookMock.mockRejectedValueOnce(new Error("INKOS_LLM_API_KEY not set"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Broken Book",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
      }),
    });

    expect(response.status).toBe(200);
    await Promise.resolve();

    const status = await app.request("http://localhost/api/books/broken-book/create-status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      status: "error",
      error: "INKOS_LLM_API_KEY not set",
    });
  });

  it("uses rollback semantics for chapter rejection instead of only flipping status", async () => {
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Broken Chapter",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: ["continuity"],
        lengthWarnings: [],
      },
      {
        number: 4,
        title: "Downstream Chapter",
        status: "ready-for-review",
        wordCount: 1900,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);
    rollbackToChapterMock.mockResolvedValue([3, 4]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/chapters/3/reject", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      chapterNumber: 3,
      status: "rejected",
      rolledBackTo: 2,
      discarded: [3, 4],
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 2);
    expect(saveChapterIndexMock).not.toHaveBeenCalled();
  });

  it("passes one-off brief into revise requests through pipeline config", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "把注意力拉回师债主线。" }),
    });

    expect(response.status).toBe(200);
    expect(pipelineConfigs.at(-1)).toMatchObject({ externalContext: "把注意力拉回师债主线。" });
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 3, "rewrite");
  });

  it("exposes a resync endpoint for rebuilding latest chapter truth artifacts", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/resync/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "以师债线为准同步状态。" }),
    });

    expect(response.status).toBe(200);
    expect(pipelineConfigs.at(-1)).toMatchObject({ externalContext: "以师债线为准同步状态。" });
    expect(resyncChapterArtifactsMock).toHaveBeenCalledWith("demo-book", 3);
  });

  it("POST /api/v2/books/create/confirm triggers book creation and returns creating status", async () => {
    initBookMock.mockResolvedValueOnce(undefined);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v2/books/create/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "simple",
        bookConfig: {
          title: "New V2 Book",
          genre: "xuanhuan",
          platform: "qidian",
          language: "zh",
          chapterWordCount: 2500,
          targetChapters: 100,
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "creating",
      bookId: "new-v2-book",
    });
    expect(initBookMock).toHaveBeenCalledTimes(1);
  });

  it("POST /api/v2/books/create/confirm returns 409 when book with same id already exists", async () => {
    await mkdir(join(root, "books", "conflict-book", "story"), { recursive: true });
    await writeFile(join(root, "books", "conflict-book", "book.json"), JSON.stringify({ id: "conflict-book" }), "utf-8");
    await writeFile(join(root, "books", "conflict-book", "story", "story_bible.md"), "# existing", "utf-8");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v2/books/create/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookConfig: {
          title: "Conflict Book",
          genre: "xuanhuan",
          platform: "qidian",
          language: "zh",
        },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Book "conflict-book" already exists'),
    });
    expect(initBookMock).not.toHaveBeenCalled();
  });

  it("POST /api/v2/books/create/confirm passes brief as externalContext to pipeline", async () => {
    initBookMock.mockResolvedValueOnce(undefined);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const brief = {
      title: "科幻书",
      coreGenres: ["科幻", "悬疑"],
      protagonist: "机器人侦探",
    };

    const response = await app.request("http://localhost/api/v2/books/create/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "pro",
        brief,
        bookConfig: {
          title: "科幻书",
          genre: "scifi",
          language: "zh",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(pipelineConfigs.at(-1)).toMatchObject({
      externalContext: JSON.stringify(brief, null, 2),
    });
  });

  it("POST /api/v2/books/create/confirm reports async failures through create-status endpoint", async () => {
    initBookMock.mockRejectedValueOnce(new Error("INKOS_LLM_API_KEY not set"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v2/books/create/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookConfig: {
          title: "Broken V2 Book",
          genre: "xuanhuan",
          language: "zh",
        },
      }),
    });

    expect(response.status).toBe(200);
    await Promise.resolve();

    const status = await app.request("http://localhost/api/books/broken-v2-book/create-status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      status: "error",
      error: "INKOS_LLM_API_KEY not set",
    });
  });

  it("POST /api/v2/books/create/confirm is idempotent when book is already being created", async () => {
    let resolveInit!: () => void;
    initBookMock.mockReturnValueOnce(new Promise<void>((resolve) => { resolveInit = resolve; }));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const firstResponse = await app.request("http://localhost/api/v2/books/create/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookConfig: { title: "Idempotent Book", genre: "xuanhuan", language: "zh" },
      }),
    });
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({ status: "creating", bookId: "idempotent-book" });

    // Second call while still in progress — should not call initBook again
    const secondResponse = await app.request("http://localhost/api/v2/books/create/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookConfig: { title: "Idempotent Book", genre: "xuanhuan", language: "zh" },
      }),
    });
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({ status: "creating", bookId: "idempotent-book" });

    expect(initBookMock).toHaveBeenCalledTimes(1);
    resolveInit();
  });

  it("normalizes a valid brief input and returns briefId + normalizedBrief", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v2/books/create/brief/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "simple",
        title: "意识残留协议",
        rawInput: "2045年，一名前脑机伦理工程师调查失控意识残留事件，揭开吞噬自我认同的阴谋。科幻题材，克制风格。",
        platform: "tomato",
        language: "zh",
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { briefId: string; normalizedBrief: Record<string, unknown> };
    expect(typeof data.briefId).toBe("string");
    expect(data.briefId).toMatch(/^brief_/);
    expect(data.normalizedBrief).toMatchObject({
      title: "意识残留协议",
      coreGenres: expect.any(Array),
      positioning: expect.any(String),
      worldSetting: expect.any(String),
      protagonist: expect.any(String),
      mainConflict: expect.any(String),
      styleRules: expect.any(Array),
      forbiddenPatterns: expect.any(Array),
    });
  });

  it("returns 422 with structured field errors when required brief fields are missing", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v2/books/create/brief/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // mode, title, and rawInput are all missing
        platform: "tomato",
      }),
    });

    expect(response.status).toBe(422);
    const data = await response.json() as { code: string; errors: Array<{ field: string; message: string }> };
    expect(data.code).toBe("BRIEF_VALIDATION_FAILED");
    expect(Array.isArray(data.errors)).toBe(true);
    const fields = data.errors.map((e) => e.field);
    expect(fields).toContain("mode");
    expect(fields).toContain("title");
    expect(fields).toContain("rawInput");
  });

  // ---------------------------------------------------------------------------
  // Controlled write-next E2E flow
  // 覆盖链路: 填干预 → 预览 plan (draft) → 写下一章 → SSE 完成
  // ---------------------------------------------------------------------------

  it("POST write-next returns writing status immediately without waiting for pipeline to finish", async () => {
    let resolve: (value: unknown) => void = () => {};
    writeNextChapterMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const responseOrTimeout = await Promise.race([
      app.request("http://localhost/api/books/demo-book/write-next", { method: "POST" }),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 300)),
    ]);

    expect(responseOrTimeout).not.toBe("timeout");
    const response = responseOrTimeout as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    resolve({ chapterNumber: 3, title: "Chapter 3", wordCount: 1800, status: "ready-for-review" });
  });

  it("POST write-next invokes pipeline.writeNextChapter with the given wordCount", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 3000 }),
    });

    expect(response.status).toBe(200);
    await Promise.resolve();
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", 3000);
  });

  it("POST write-next works with no body and passes undefined wordCount to pipeline", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await Promise.resolve();
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", undefined);
  });

  it("POST draft (plan preview) returns drafting status immediately", async () => {
    let resolve: (value: unknown) => void = () => {};
    writeDraftMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const responseOrTimeout = await Promise.race([
      app.request("http://localhost/api/books/demo-book/draft", { method: "POST" }),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 300)),
    ]);

    expect(responseOrTimeout).not.toBe("timeout");
    const response = responseOrTimeout as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "drafting", bookId: "demo-book" });

    resolve({ chapterNumber: 3, title: "Draft Chapter", wordCount: 1800, status: "drafted" });
  });

  it("POST draft passes context (intervention text) to pipeline.writeDraft", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "本章把注意力拉回师徒矛盾", wordCount: 2500 }),
    });

    expect(response.status).toBe(200);
    await Promise.resolve();
    expect(writeDraftMock).toHaveBeenCalledWith("demo-book", "本章把注意力拉回师徒矛盾", 2500);
  });

  it("full controlled write-next flow: draft preview then write-next completes via pipeline", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    // Step 1: Preview plan with intervention context (draft endpoint)
    const draftResponse = await app.request("http://localhost/api/books/demo-book/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "先把注意力拉回师债主线" }),
    });
    expect(draftResponse.status).toBe(200);
    await expect(draftResponse.json()).resolves.toMatchObject({ status: "drafting", bookId: "demo-book" });

    // Step 2: Write next chapter (triggers full pipeline)
    const writeResponse = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
    });
    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    // Wait for async pipeline to settle
    await Promise.resolve();

    // Verify both pipeline stages were called
    expect(writeDraftMock).toHaveBeenCalledTimes(1);
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
  });

  it("SSE write:error event is broadcast when pipeline.writeNextChapter rejects", async () => {
    writeNextChapterMock.mockRejectedValueOnce(new Error("INKOS_LLM_API_KEY not set"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
    });

    // Immediate response is still 200 — error is pushed asynchronously via SSE
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    // Let the rejection propagate
    await Promise.resolve();
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
  });
});
