import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonSessionSummary } from "../shared/contracts.js";

const schedulerStartMock = vi.fn<() => Promise<void>>();
const schedulerStartPlans: unknown[] = [];
const initBookMock = vi.fn();
const runRadarMock = vi.fn();
const reviseDraftMock = vi.fn();
const resyncChapterArtifactsMock = vi.fn();
const writeNextChapterMock = vi.fn();
const planChapterMock = vi.fn();
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
    planChapter = planChapterMock;
  }

  class MockScheduler {
    private running = false;

    constructor(_config: unknown) {}

    async start(plan?: unknown): Promise<void> {
      this.running = true;
      schedulerStartPlans.push(plan);
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
    schedulerStartPlans.length = 0;
    initBookMock.mockReset();
    runRadarMock.mockReset();
    reviseDraftMock.mockReset();
    resyncChapterArtifactsMock.mockReset();
    writeNextChapterMock.mockReset();
    planChapterMock.mockReset();
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
    planChapterMock.mockResolvedValue({
      bookId: "demo-book",
      chapterNumber: 5,
      intentPath: "chapters/intent/0005_intent.json",
      goal: "主角发现线索，局势骤然紧张",
      conflicts: ["外部冲突: 追杀与逃亡", "内部冲突: 信任危机"],
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

    const session = await app.request("http://localhost/api/daemon/session");
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({ state: "running", running: true });

    resolveStart?.();
  });

  it("daemon session transitions start -> running -> stop and keeps legacy daemon status compatible", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const initialSession = await app.request("http://localhost/api/daemon/session");
    expect(initialSession.status).toBe(200);
    await expect(initialSession.json()).resolves.toMatchObject({ state: "idle", running: false });

    const startResponse = await app.request("http://localhost/api/daemon/start", { method: "POST" });
    expect(startResponse.status).toBe(200);

    const runningSession = await app.request("http://localhost/api/daemon/session");
    await expect(runningSession.json()).resolves.toMatchObject({ state: "running", running: true });

    const legacyRunning = await app.request("http://localhost/api/daemon");
    await expect(legacyRunning.json()).resolves.toEqual({ running: true });

    const stopResponse = await app.request("http://localhost/api/daemon/stop", { method: "POST" });
    expect(stopResponse.status).toBe(200);

    const stoppedSession = await app.request("http://localhost/api/daemon/session");
    await expect(stoppedSession.json()).resolves.toMatchObject({ state: "stopped", running: false });

    const legacyStopped = await app.request("http://localhost/api/daemon");
    await expect(legacyStopped.json()).resolves.toEqual({ running: false });
  });

  it("daemon session transitions to error with summary when start loop fails", async () => {
    schedulerStartMock.mockRejectedValueOnce(new Error("scheduler exploded"));
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const startResponse = await app.request("http://localhost/api/daemon/start", { method: "POST" });
    expect(startResponse.status).toBe(200);

    await vi.waitFor(async () => {
      const session = await app.request("http://localhost/api/daemon/session");
      const body = await session.json() as DaemonSessionSummary;
      expect(body.state).toBe("error");
      expect(body.running).toBe(false);
      expect(body.lastError).toMatchObject({ message: "scheduler exploded" });
      expect(typeof body.lastError?.timestamp).toBe("string");
    });

    const daemonEvents = await app.request("http://localhost/api/runtime/events?source=daemon&limit=10");
    expect(daemonEvents.status).toBe(200);
    const daemonEventsBody = await daemonEvents.json() as {
      entries: Array<{ event: string }>;
    };
    expect(daemonEventsBody.entries.map((entry) => entry.event)).toContain("daemon:error");
  });

  it("creates daemon plan, starts with planId, and passes plan to scheduler", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const planResponse = await app.request("http://localhost/api/daemon/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: {
          mode: "custom-plan",
          bookScope: { type: "book-list", bookIds: ["demo-book", "demo-book"] },
          perBookChapterCap: 2,
          globalChapterCap: 5,
        },
      }),
    });
    expect(planResponse.status).toBe(200);
    const planned = await planResponse.json() as {
      ok: boolean;
      planId: string;
      updated: boolean;
      plan: { bookScope: { type: string; bookIds?: string[] } };
    };
    expect(planned.ok).toBe(true);
    expect(planned.updated).toBe(false);
    expect(planned.planId.length).toBeGreaterThan(0);
    expect(planned.plan.bookScope.type).toBe("book-list");
    expect(planned.plan.bookScope.bookIds).toEqual(["demo-book"]);
    expect(planned.plan.bookScope.bookIds).toHaveLength(1);

    const startResponse = await app.request("http://localhost/api/daemon/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: planned.planId }),
    });
    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toMatchObject({
      ok: true,
      running: true,
      planId: planned.planId,
      mode: "custom-plan",
    });

    expect(schedulerStartPlans).toHaveLength(1);
    expect(schedulerStartPlans[0]).toEqual({
      mode: "custom-plan",
      bookScope: { type: "book-list", bookIds: ["demo-book"] },
      perBookChapterCap: 2,
      globalChapterCap: 5,
    });
  });

  it("rejects duplicate daemon start with 409 business error", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const firstStart = await app.request("http://localhost/api/daemon/start", { method: "POST" });
    expect(firstStart.status).toBe(200);

    const secondStart = await app.request("http://localhost/api/daemon/start", { method: "POST" });
    expect(secondStart.status).toBe(409);
    await expect(secondStart.json()).resolves.toEqual({
      error: {
        code: "DAEMON_ALREADY_RUNNING",
        message: "Daemon already running.",
      },
    });
  });

  it("validates daemon plan/start inputs with 422 responses", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const invalidPlan = await app.request("http://localhost/api/daemon/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: { mode: "custom-plan", bookScope: { type: "book-list", bookIds: [] } } }),
    });
    expect(invalidPlan.status).toBe(422);
    await expect(invalidPlan.json()).resolves.toMatchObject({
      code: "DAEMON_PLAN_VALIDATION_FAILED",
      errors: [{ field: "plan.bookScope.bookIds" }],
    });

    const invalidStart = await app.request("http://localhost/api/daemon/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: "x", default: true }),
    });
    expect(invalidStart.status).toBe(422);
    await expect(invalidStart.json()).resolves.toMatchObject({
      code: "DAEMON_START_VALIDATION_FAILED",
      errors: [{ field: "planId" }],
    });
  });

  it("daemon session and events expose pause/resume transitions", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const start = await app.request("http://localhost/api/daemon/start", { method: "POST" });
    expect(start.status).toBe(200);

    const pause = await app.request("http://localhost/api/daemon/pause", { method: "POST" });
    expect(pause.status).toBe(200);
    await expect(pause.json()).resolves.toMatchObject({ ok: true, state: "paused", running: true });

    const pausedSession = await app.request("http://localhost/api/daemon/session");
    await expect(pausedSession.json()).resolves.toMatchObject({ state: "paused", running: true });

    const resume = await app.request("http://localhost/api/daemon/resume", { method: "POST" });
    expect(resume.status).toBe(200);
    await expect(resume.json()).resolves.toMatchObject({ ok: true, state: "running", running: true });

    const daemonEvents = await app.request("http://localhost/api/runtime/events?source=daemon&limit=10");
    expect(daemonEvents.status).toBe(200);
    const daemonEventsBody = await daemonEvents.json() as { entries: Array<{ event: string }> };
    expect(daemonEventsBody.entries.map((entry) => entry.event)).toContain("daemon:paused");
    expect(daemonEventsBody.entries.map((entry) => entry.event)).toContain("daemon:resumed");
  });

  it("runtime center status/events reflect daemon lifecycle and support history query", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const statusBefore = await app.request("http://localhost/api/runtime/status");
    expect(statusBefore.status).toBe(200);
    await expect(statusBefore.json()).resolves.toMatchObject({
      daemonRunning: false,
      eventCount: 0,
      recentErrorCount: 0,
    });

    const startResponse = await app.request("http://localhost/api/daemon/start", { method: "POST" });
    expect(startResponse.status).toBe(200);

    const stopResponse = await app.request("http://localhost/api/daemon/stop", { method: "POST" });
    expect(stopResponse.status).toBe(200);

    const statusAfter = await app.request("http://localhost/api/runtime/status");
    expect(statusAfter.status).toBe(200);
    await expect(statusAfter.json()).resolves.toMatchObject({
      daemonRunning: false,
      eventCount: 2,
    });

    const lifecycle = await app.request("http://localhost/api/runtime/events?source=daemon&limit=10");
    expect(lifecycle.status).toBe(200);
    const lifecycleData = await lifecycle.json() as {
      entries: Array<{ event: string }>;
      total: number;
    };
    expect(lifecycleData.entries.map((entry) => entry.event)).toEqual(["daemon:started", "daemon:stopped"]);
    expect(lifecycleData.total).toBe(2);

    // Simulate page refresh: historical events remain queryable via runtime API.
    const replay = await app.request("http://localhost/api/runtime/events?source=daemon&limit=10");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ total: 2 });
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

  it("allows opening dynamic truth markdown files under story/", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const bookId = "truth-dynamic";
    const storyDir = join(root, "books", bookId, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "author_intent.md"), "# intent\nline", "utf-8");

    const response = await app.request(`http://localhost/api/books/${bookId}/truth/author_intent.md`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      file: "author_intent.md",
      content: "# intent\nline",
    });
  });

  it("rejects unsafe truth file names", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo/truth/author%20intent.md");
    expect(response.status).toBe(400);
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

  it("persists chapter runs for revise/rewrite/anti-detect/resync and supports querying after refresh", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const reviseResponse = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "回收伏笔" }),
    });
    const antiDetectResponse = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "anti-detect", brief: "降低AI痕迹" }),
    });
    const rewriteResponse = await app.request("http://localhost/api/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "保留人物动机" }),
    });
    const resyncResponse = await app.request("http://localhost/api/books/demo-book/resync/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "同步事实" }),
    });

    expect(reviseResponse.status).toBe(200);
    expect(antiDetectResponse.status).toBe(200);
    expect(rewriteResponse.status).toBe(200);
    expect(resyncResponse.status).toBe(200);

    const reviseData = await reviseResponse.json() as {
      status: string;
      runId: string;
      bookId: string;
      chapter: number;
      mode: string;
      appliedBrief: string | null;
    };
    const antiDetectData = await antiDetectResponse.json() as {
      status: string;
      runId: string;
      bookId: string;
      chapter: number;
      mode: string;
      appliedBrief: string | null;
    };
    const rewriteData = await rewriteResponse.json() as {
      status: string;
      runId: string;
      bookId: string;
      chapter: number;
      rolledBackTo: number;
      discarded: number[];
      appliedBrief: string | null;
    };
    expect(reviseData).toMatchObject({
      status: "revising",
      bookId: "demo-book",
      chapter: 3,
      mode: "rewrite",
      appliedBrief: "回收伏笔",
    });
    expect(antiDetectData).toMatchObject({
      status: "revising",
      bookId: "demo-book",
      chapter: 3,
      mode: "anti-detect",
      appliedBrief: "降低AI痕迹",
    });
    expect(rewriteData).toMatchObject({
      status: "rewriting",
      bookId: "demo-book",
      chapter: 3,
      rolledBackTo: 2,
      discarded: [],
      appliedBrief: "保留人物动机",
    });
    const resyncData = await resyncResponse.json() as { runId: string };

    await vi.waitFor(async () => {
      const response = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${reviseData.runId}`);
      const data = await response.json() as { status: string };
      expect(data.status).toBe("succeeded");
    });
    await vi.waitFor(async () => {
      const response = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${rewriteData.runId}`);
      const data = await response.json() as { status: string };
      expect(data.status).toBe("succeeded");
    });

    const refreshedApp = createStudioServer(cloneProjectConfig() as never, root);
    const listResponse = await refreshedApp.request("http://localhost/api/books/demo-book/chapter-runs?limit=10");
    expect(listResponse.status).toBe(200);
    const listData = await listResponse.json() as {
      runs: Array<{
        runId: string;
        actionType: string;
        status: string;
        decision: string | null;
        appliedBrief: string | null;
        unchangedReason: string | null;
        startedAt: string;
        finishedAt: string | null;
      }>;
    };
    expect(listData.runs.length).toBeGreaterThanOrEqual(4);
    const runIds = listData.runs.map((run) => run.runId);
    expect(runIds).toContain(reviseData.runId);
    expect(runIds).toContain(antiDetectData.runId);
    expect(runIds).toContain(rewriteData.runId);
    expect(runIds).toContain(resyncData.runId);
    const antiDetectRun = listData.runs.find((run) => run.runId === antiDetectData.runId);
    expect(antiDetectRun?.actionType).toBe("anti-detect");
    expect(antiDetectRun).toMatchObject({
      status: "succeeded",
      decision: "applied",
      appliedBrief: "降低AI痕迹",
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    });

    const runResponse = await refreshedApp.request(`http://localhost/api/books/demo-book/chapter-runs/${resyncData.runId}`);
    expect(runResponse.status).toBe(200);
    await expect(runResponse.json()).resolves.toMatchObject({
      runId: resyncData.runId,
      actionType: "resync",
      status: "succeeded",
      decision: "unchanged",
      unchangedReason: "No truth artifacts required updates.",
      appliedBrief: "同步事实",
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    });

    const eventsResponse = await refreshedApp.request(`http://localhost/api/books/demo-book/chapter-runs/${resyncData.runId}/events`);
    expect(eventsResponse.status).toBe(200);
    const eventsData = await eventsResponse.json() as { events: Array<{ type: string; status: string }> };
    expect(eventsData.events.map((event) => event.type)).toEqual(["start", "success"]);
    expect(eventsData.events.map((event) => event.status)).toEqual(["running", "succeeded"]);
  });

  it("supports deleting a chapter run record", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const reviseResponse = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "删除测试" }),
    });
    expect(reviseResponse.status).toBe(200);
    const reviseData = await reviseResponse.json() as { runId: string };

    await vi.waitFor(async () => {
      const runResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${reviseData.runId}`);
      const runBody = await runResponse.json() as { status: string };
      expect(runBody.status).toBe("succeeded");
    });

    const deleteResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${reviseData.runId}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({ ok: true, runId: reviseData.runId });

    const lookupAfterDelete = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${reviseData.runId}`);
    expect(lookupAfterDelete.status).toBe(404);
  });

  it("exposes run-level before/after diff and briefTrace for revise/rewrite/anti-detect", async () => {
    const chapterDir = join(root, "books", "demo-book", "chapters");
    await mkdir(chapterDir, { recursive: true });
    const chapterPath = join(chapterDir, "0003_demo.md");
    await writeFile(chapterPath, "# 第3章\n初始文本：主角继续试探。", "utf-8");

    reviseDraftMock.mockImplementation(async (_bookId: string, _chapter: number, mode: string) => {
      if (mode === "anti-detect") {
        await writeFile(chapterPath, "# 第3章\n初始文本：主角继续试探。", "utf-8");
        return {
          chapterNumber: 3,
          wordCount: 1800,
          fixedIssues: [],
          applied: false,
          status: "ready-for-review",
        };
      }
      await writeFile(chapterPath, "# 第3章\n把注意力拉回师债主线并增强冲突。", "utf-8");
      return {
        chapterNumber: 3,
        wordCount: 1800,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "ready-for-review",
      };
    });
    writeNextChapterMock.mockImplementation(async () => {
      await writeFile(chapterPath, "# 第3章\n重写后保留人物动机并补充转折。", "utf-8");
      return {
        chapterNumber: 3,
        title: "Rewritten Chapter",
        wordCount: 1800,
        revised: true,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "rewritten" },
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const reviseResponse = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "拉回师债主线" }),
    });
    const antiDetectResponse = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "anti-detect", brief: "降低AI痕迹" }),
    });
    const rewriteResponse = await app.request("http://localhost/api/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "保留人物动机" }),
    });

    expect(reviseResponse.status).toBe(200);
    expect(antiDetectResponse.status).toBe(200);
    expect(rewriteResponse.status).toBe(200);

    const reviseData = await reviseResponse.json() as { runId: string };
    const antiDetectData = await antiDetectResponse.json() as { runId: string };
    const rewriteData = await rewriteResponse.json() as { runId: string };

    await vi.waitFor(async () => {
      const response = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${reviseData.runId}`);
      const data = await response.json() as { status: string };
      expect(data.status).toBe("succeeded");
    });
    await vi.waitFor(async () => {
      const response = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${rewriteData.runId}`);
      const data = await response.json() as { status: string };
      expect(data.status).toBe("succeeded");
    });
    await vi.waitFor(async () => {
      const response = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${antiDetectData.runId}`);
      const data = await response.json() as { status: string; decision: string | null };
      expect(data.status).toBe("succeeded");
      expect(data.decision).toBe("unchanged");
    });

    const reviseEventsResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${reviseData.runId}/events`);
    expect(reviseEventsResponse.status).toBe(200);
    await expect(reviseEventsResponse.json()).resolves.toMatchObject({
      runId: reviseData.runId,
      events: [
        { type: "start", status: "running" },
        { type: "success", status: "succeeded" },
      ],
    });

    const reviseDiffResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${reviseData.runId}/diff`);
    expect(reviseDiffResponse.status).toBe(200);
    await expect(reviseDiffResponse.json()).resolves.toMatchObject({
      runId: reviseData.runId,
      beforeContent: expect.stringContaining("初始文本"),
      afterContent: expect.stringContaining("师债主线"),
      briefTrace: [{ text: "拉回师债主线", matched: true }],
    });

    const antiDetectDiffResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${antiDetectData.runId}/diff`);
    expect(antiDetectDiffResponse.status).toBe(200);
    await expect(antiDetectDiffResponse.json()).resolves.toMatchObject({
      runId: antiDetectData.runId,
      decision: "unchanged",
      unchangedReason: "No revisions were applied.",
      briefTrace: [{ text: "降低AI痕迹", matched: false }],
    });

    const rewriteDiffResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${rewriteData.runId}/diff`);
    expect(rewriteDiffResponse.status).toBe(200);
    await expect(rewriteDiffResponse.json()).resolves.toMatchObject({
      runId: rewriteData.runId,
      beforeContent: expect.stringContaining("初始文本"),
      afterContent: expect.stringContaining("重写后保留人物动机"),
      briefTrace: [{ text: "保留人物动机", matched: true }],
    });
  });

  it("propagates unchanged reasons from core revise result into run records and events", async () => {
    const chapterDir = join(root, "books", "demo-book", "chapters");
    await mkdir(chapterDir, { recursive: true });
    await writeFile(join(chapterDir, "0003_demo.md"), "# 第3章\n原文。", "utf-8");

    reviseDraftMock.mockResolvedValue({
      chapterNumber: 3,
      wordCount: 1200,
      fixedIssues: [],
      applied: false,
      status: "unchanged",
      unchangedReason: "Manual revision did not improve merged audit or AI-tell metrics; kept original chapter.",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rework", brief: "强化冲突" }),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as { runId: string };

    await vi.waitFor(async () => {
      const runResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${data.runId}`);
      const run = await runResponse.json() as { status: string; decision: string | null; unchangedReason: string | null };
      expect(run.status).toBe("succeeded");
      expect(run.decision).toBe("unchanged");
      expect(run.unchangedReason).toContain("did not improve");
    });

    const runtimeResponse = await app.request("http://localhost/api/runtime/events?limit=50");
    expect(runtimeResponse.status).toBe(200);
    const runtimeData = await runtimeResponse.json() as {
      entries: Array<{ event?: string; eventType?: string; message?: string; data?: { message?: string } }>;
    };
    const unchangedEvent = runtimeData.entries.find((entry) =>
      entry.event === "revise:unchanged" || entry.eventType === "revise:unchanged");
    expect(unchangedEvent).toBeDefined();
    const unchangedMessage = unchangedEvent?.message ?? unchangedEvent?.data?.message;
    expect(unchangedMessage).toContain("did not improve");
  });

  it("keeps core unchanged reason and emits unmatched brief reasonCode when generated content keeps chapter unchanged", async () => {
    const chapterDir = join(root, "books", "demo-book", "chapters");
    await mkdir(chapterDir, { recursive: true });
    const chapterPath = join(chapterDir, "0003_demo.md");
    await writeFile(chapterPath, "# 第3章\n原文。", "utf-8");

    reviseDraftMock.mockImplementation(async () => {
      await writeFile(chapterPath, "# 第3章\n原文。", "utf-8");
      return {
        chapterNumber: 3,
        wordCount: 1200,
        fixedIssues: [],
        applied: false,
        status: "unchanged",
        unchangedReason: "No revisions were applied.",
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "改成完全不同的剧情走向" }),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as { runId: string };

    await vi.waitFor(async () => {
      const runResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${data.runId}`);
      const run = await runResponse.json() as { status: string; decision: string | null; unchangedReason: string | null };
      expect(run.status).toBe("succeeded");
      expect(run.decision).toBe("unchanged");
      expect(run.unchangedReason).toBe("No revisions were applied.");
    });

    const runtimeResponse = await app.request("http://localhost/api/runtime/events?limit=50");
    expect(runtimeResponse.status).toBe(200);
    const runtimeData = await runtimeResponse.json() as {
      entries: Array<{ event?: string; data?: { reasonCode?: string } }>;
    };
    const unchangedEvent = runtimeData.entries.find((entry) => entry.event === "revise:unchanged");
    expect(unchangedEvent?.data?.reasonCode).toBe("brief-unmatched");
  });

  it("allows approving unchanged revise runs when candidate revision is available", async () => {
    const chapterDir = join(root, "books", "demo-book", "chapters");
    await mkdir(chapterDir, { recursive: true });
    const chapterPath = join(chapterDir, "0003_demo.md");
    await writeFile(chapterPath, "# 第3章\n原文。", "utf-8");
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Demo",
        status: "audit-failed",
        wordCount: 1200,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    reviseDraftMock.mockResolvedValue({
      chapterNumber: 3,
      wordCount: 1200,
      fixedIssues: [],
      applied: false,
      status: "unchanged",
      unchangedReason: "Manual revision changed text, but safeguards rejected metric drift.",
      reviewRequired: true,
      candidateRevision: {
        content: "候选稿：主线冲突前置并收紧转场。",
        wordCount: 1222,
        updatedState: "(状态卡未更新)",
        updatedLedger: "(账本未更新)",
        updatedHooks: "(伏笔池未更新)",
        status: "audit-failed",
        auditIssues: ["[critical] 动机承接偏弱"],
        lengthWarnings: [],
      },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const startResponse = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "强化师债主线" }),
    });
    expect(startResponse.status).toBe(200);
    const { runId } = await startResponse.json() as { runId: string };

    await vi.waitFor(async () => {
      const runResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${runId}`);
      const run = await runResponse.json() as { status: string; decision: string | null };
      expect(run.status).toBe("succeeded");
      expect(run.decision).toBe("unchanged");
    });

    const diffBeforeApprove = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${runId}/diff`);
    expect(diffBeforeApprove.status).toBe(200);
    await expect(diffBeforeApprove.json()).resolves.toMatchObject({
      runId,
      decision: "unchanged",
      pendingApproval: true,
      afterContent: expect.stringContaining("候选稿"),
    });

    const approveResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${runId}/approve`, {
      method: "POST",
    });
    expect(approveResponse.status).toBe(200);
    await expect(approveResponse.json()).resolves.toMatchObject({
      ok: true,
      runId,
      decision: "applied",
    });

    const approvedRunResponse = await app.request(`http://localhost/api/books/demo-book/chapter-runs/${runId}`);
    expect(approvedRunResponse.status).toBe(200);
    await expect(approvedRunResponse.json()).resolves.toMatchObject({
      runId,
      decision: "applied",
    });

    await expect(readFile(chapterPath, "utf-8")).resolves.toContain("候选稿：主线冲突前置并收紧转场");
  });

  it("returns chapter-run validation and not-found errors for invalid queries", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const invalidQueryResponse = await app.request("http://localhost/api/books/demo-book/chapter-runs?chapter=abc&limit=0");
    expect(invalidQueryResponse.status).toBe(422);
    await expect(invalidQueryResponse.json()).resolves.toMatchObject({
      code: "CHAPTER_RUNS_VALIDATION_FAILED",
      errors: [
        { field: "chapter", message: expect.any(String) },
        { field: "limit", message: expect.any(String) },
      ],
    });

    const missingRunResponse = await app.request("http://localhost/api/books/demo-book/chapter-runs/missing-run-id");
    expect(missingRunResponse.status).toBe(404);
    await expect(missingRunResponse.json()).resolves.toEqual({ error: "Run not found" });

    const missingEventsResponse = await app.request("http://localhost/api/books/demo-book/chapter-runs/missing-run-id/events");
    expect(missingEventsResponse.status).toBe(404);
    await expect(missingEventsResponse.json()).resolves.toEqual({ error: "Run not found" });
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

  it("POST /api/books/:id/next-plan returns plan with goal, conflicts, and chapterNumber", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/next-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "聚焦师债主线，节奏加快。" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { plan: { goal: string; conflicts: string[]; chapterNumber: number } };
    expect(data.plan).toMatchObject({
      goal: expect.any(String),
      conflicts: expect.any(Array),
      chapterNumber: expect.any(Number),
    });
    expect(planChapterMock).toHaveBeenCalledWith("demo-book", "聚焦师债主线，节奏加快。");
  });

  it("POST /api/books/:id/next-plan accepts empty payload without error", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/next-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { plan: { goal: string; conflicts: string[]; chapterNumber: number } };
    expect(data.plan).toMatchObject({
      goal: expect.any(String),
      conflicts: expect.any(Array),
      chapterNumber: expect.any(Number),
    });
    expect(planChapterMock).toHaveBeenCalledWith("demo-book", undefined);
  });

  it("POST /api/books/:id/next-plan returns 422 when brief is not a string", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/next-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: 12345 }),
    });

    expect(response.status).toBe(422);
    const data = await response.json() as { code: string; errors: Array<{ field: string; message: string }> };
    expect(data.code).toBe("NEXT_PLAN_VALIDATION_FAILED");
    expect(Array.isArray(data.errors)).toBe(true);
    const fields = data.errors.map((e: { field: string }) => e.field);
    expect(fields).toContain("brief");
    expect(planChapterMock).not.toHaveBeenCalled();
  });

  it("POST /api/books/:id/next-plan returns contextual fallback plan when AI output is always placeholder", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    // Both attempts return the fallback placeholder (low-quality output)
    planChapterMock.mockResolvedValue({
      bookId: "demo-book",
      chapterNumber: 3,
      intentPath: "chapters/intent/0003_intent.json",
      goal: "推进本章核心事件，并让主角做出一个带代价的关键选择。",
      conflicts: ["请补充本章冲突：主角想达成什么、被谁阻拦、失败代价是什么。"],
    });

    const response = await app.request("http://localhost/api/books/demo-book/next-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as {
      plan: { goal: string; conflicts: string[]; chapterNumber: number };
      warning?: { code: string; message: string };
    };
    expect(data.warning?.code).toBe("PLAN_LOW_CONFIDENCE_FALLBACK");
    expect(data.plan.goal).not.toBe("推进本章核心事件，并让主角做出一个带代价的关键选择。");
    expect(data.plan.conflicts.length).toBeGreaterThan(0);
    // Should have retried once (2 total calls)
    expect(planChapterMock).toHaveBeenCalledTimes(2);
  });

  it("POST /api/books/:id/next-plan succeeds on the retry when the first attempt is low quality", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    let callCount = 0;
    planChapterMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          bookId: "demo-book",
          chapterNumber: 4,
          intentPath: "chapters/intent/0004_intent.json",
          goal: "推进本章核心事件，并让主角做出一个带代价的关键选择。",
          conflicts: ["请补充本章冲突：主角想达成什么、被谁阻拦、失败代价是什么。"],
        };
      }
      return {
        bookId: "demo-book",
        chapterNumber: 4,
        intentPath: "chapters/intent/0004_intent.json",
        goal: "主角揭露幕后黑手并面临生死抉择",
        conflicts: ["外部冲突: 债主逼迫主角违约"],
      };
    });

    const response = await app.request("http://localhost/api/books/demo-book/next-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { plan: { goal: string; conflicts: string[] } };
    expect(data.plan.goal).toBe("主角揭露幕后黑手并面临生死抉择");
    expect(planChapterMock).toHaveBeenCalledTimes(2);
  });

  it("write-next accepts a full steering payload and injects externalContext into pipeline", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wordCount: 3000,
        brief: "以师债线为核心，刻画师徒情感。",
        chapterGoal: "本章完成拜师契约签署。",
        mustInclude: ["白玉令", "血誓仪式"],
        mustAvoid: ["现代用语", "突破境界"],
        pace: "slow",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    const injectedContext = (pipelineConfigs.at(-1) as Record<string, unknown>)["externalContext"] as string;
    expect(typeof injectedContext).toBe("string");
    expect(injectedContext).toContain("以师债线为核心，刻画师徒情感。");
    expect(injectedContext).toContain("本章完成拜师契约签署。");
    expect(injectedContext).toContain("白玉令");
    expect(injectedContext).toContain("血誓仪式");
    expect(injectedContext).toContain("现代用语");
    expect(injectedContext).toContain("slow");

    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", 3000);
  });

  it("write-next with only wordCount does not inject externalContext (backward compat)", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 2000 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    const config = pipelineConfigs.at(-1) as Record<string, unknown>;
    expect(config["externalContext"]).toBeUndefined();
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", 2000);
  });

  it("write-next with no body also succeeds (backward compat)", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", undefined);
  });

  it("write-next with invalid payload returns 422 with structured errors", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wordCount: -5,
        pace: "turbo",
        mustInclude: "not-an-array",
      }),
    });

    expect(response.status).toBe(422);
    const data = await response.json() as { code: string; errors: Array<{ field: string; message: string }> };
    expect(data.code).toBe("WRITE_NEXT_VALIDATION_FAILED");
    expect(Array.isArray(data.errors)).toBe(true);
    const fields = data.errors.map((e) => e.field);
    expect(fields).toContain("wordCount");
    expect(fields).toContain("pace");
    expect(fields).toContain("mustInclude");
    expect(writeNextChapterMock).not.toHaveBeenCalled();
  });

  it("write-next with invalid mode returns 422 with mode error", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ultra-fast" }),
    });

    expect(response.status).toBe(422);
    const data = await response.json() as { code: string; errors: Array<{ field: string; message: string }> };
    expect(data.code).toBe("WRITE_NEXT_VALIDATION_FAILED");
    expect(Array.isArray(data.errors)).toBe(true);
    const fields = data.errors.map((e) => e.field);
    expect(fields).toContain("mode");
    expect(writeNextChapterMock).not.toHaveBeenCalled();
  });

  it("write-next mode=ai-plan calls planChapter then writeNextChapter with plan context", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "ai-plan",
        planInput: "聚焦师债主线，节奏加快。",
        wordCount: 3000,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    // Wait for the async plan → write pipeline to complete
    await vi.waitFor(() => expect(writeNextChapterMock).toHaveBeenCalled());

    expect(planChapterMock).toHaveBeenCalledWith("demo-book", "聚焦师债主线，节奏加快。");
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", 3000);

    // The pipeline config used for writing should contain plan-derived context
    const injectedContext = (pipelineConfigs.at(-1) as Record<string, unknown>)["externalContext"] as string;
    expect(typeof injectedContext).toBe("string");
    expect(injectedContext).toContain("主角发现线索，局势骤然紧张"); // plan goal from mock
  });

  it("write-next mode=manual-plan injects externalContext from steering fields", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "manual-plan",
        wordCount: 2500,
        chapterGoal: "主角完成最终抉择。",
        mustInclude: ["天命令牌"],
        mustAvoid: ["现代用语"],
        pace: "fast",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    await vi.waitFor(() => expect(writeNextChapterMock).toHaveBeenCalled());

    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", 2500);
    expect(planChapterMock).not.toHaveBeenCalled();

    const injectedContext = (pipelineConfigs.at(-1) as Record<string, unknown>)["externalContext"] as string;
    expect(typeof injectedContext).toBe("string");
    expect(injectedContext).toContain("主角完成最终抉择。");
    expect(injectedContext).toContain("天命令牌");
    expect(injectedContext).toContain("现代用语");
    expect(injectedContext).toContain("fast");
  });

  it("write-next mode=quick writes without planning or context injection", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "quick", wordCount: 1500 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "writing", bookId: "demo-book" });

    await vi.waitFor(() => expect(writeNextChapterMock).toHaveBeenCalled());

    expect(planChapterMock).not.toHaveBeenCalled();
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", 1500);

    const config = pipelineConfigs.at(-1) as Record<string, unknown>;
    expect(config["externalContext"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RuntimeEventStore — unit tests
// ---------------------------------------------------------------------------

describe("RuntimeEventStore unit tests", () => {
  it("appends events and returns them in insertion order", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore();

    store.append({ eventType: "write:start", level: "info", message: "write:start", timestamp: "2026-01-01T00:00:00.000Z", source: "write" });
    store.append({ eventType: "write:complete", level: "info", message: "write:complete", timestamp: "2026-01-01T00:00:01.000Z", source: "write" });
    store.append({ eventType: "revise:start", level: "info", message: "revise:start", timestamp: "2026-01-01T00:00:02.000Z", source: "revise" });

    const events = store.query();
    expect(events).toHaveLength(3);
    expect(events[0].eventType).toBe("write:start");
    expect(events[1].eventType).toBe("write:complete");
    expect(events[2].eventType).toBe("revise:start");
  });

  it("enforces capacity and evicts oldest entries when full", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore(3);

    for (let i = 0; i < 5; i++) {
      store.append({
        eventType: `evt:${i}`,
        level: "info",
        message: `event ${i}`,
        timestamp: `2026-01-01T00:00:0${i}.000Z`,
        source: "test",
      });
    }

    // capacity is 3 → only the last 3 events should remain
    expect(store.size).toBe(3);
    const events = store.query();
    expect(events).toHaveLength(3);
    expect(events[0].eventType).toBe("evt:2");
    expect(events[1].eventType).toBe("evt:3");
    expect(events[2].eventType).toBe("evt:4");
  });

  it("query filters by bookId", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore();

    store.append({ eventType: "write:start", level: "info", bookId: "book-a", message: "m", timestamp: "2026-01-01T00:00:00.000Z", source: "write" });
    store.append({ eventType: "write:start", level: "info", bookId: "book-b", message: "m", timestamp: "2026-01-01T00:00:01.000Z", source: "write" });
    store.append({ eventType: "write:complete", level: "info", bookId: "book-a", message: "m", timestamp: "2026-01-01T00:00:02.000Z", source: "write" });

    const result = store.query({ bookId: "book-a" });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.bookId === "book-a")).toBe(true);
  });

  it("query filters by eventType", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore();

    store.append({ eventType: "write:start", level: "info", message: "m", timestamp: "2026-01-01T00:00:00.000Z", source: "write" });
    store.append({ eventType: "daemon:started", level: "info", message: "m", timestamp: "2026-01-01T00:00:01.000Z", source: "daemon" });
    store.append({ eventType: "write:start", level: "info", message: "m", timestamp: "2026-01-01T00:00:02.000Z", source: "write" });

    const result = store.query({ eventType: "write:start" });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.eventType === "write:start")).toBe(true);
  });

  it("query respects the limit option (most recent N)", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore();

    for (let i = 0; i < 10; i++) {
      store.append({
        eventType: "log",
        level: "info",
        message: `msg ${i}`,
        timestamp: `2026-01-01T00:00:0${i}.000Z`,
        source: "log",
      });
    }

    const result = store.query({ limit: 3 });
    expect(result).toHaveLength(3);
    expect(result[2].message).toBe("msg 9");
  });

  it("clear removes all events", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore();

    store.append({ eventType: "write:start", level: "info", message: "m", timestamp: "2026-01-01T00:00:00.000Z", source: "write" });
    store.append({ eventType: "write:complete", level: "info", message: "m", timestamp: "2026-01-01T00:00:01.000Z", source: "write" });

    store.clear();

    expect(store.size).toBe(0);
    expect(store.query()).toHaveLength(0);
  });

  it("size reflects the number of stored events up to capacity", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore(5);

    expect(store.size).toBe(0);

    for (let i = 0; i < 8; i++) {
      store.append({ eventType: "ping", level: "info", message: "m", timestamp: new Date().toISOString(), source: "ping" });
    }

    expect(store.size).toBe(5);
  });

  it("RuntimeEvent fields are complete and correctly typed", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    const store = new RuntimeEventStore();

    const event = {
      eventType: "daemon:error",
      level: "error" as const,
      bookId: "book-x",
      chapter: 7,
      message: "Daemon crashed",
      timestamp: "2026-01-01T12:00:00.000Z",
      source: "daemon",
    };

    store.append(event);

    const [stored] = store.query();
    expect(stored.eventType).toBe("daemon:error");
    expect(stored.level).toBe("error");
    expect(stored.bookId).toBe("book-x");
    expect(stored.chapter).toBe(7);
    expect(stored.message).toBe("Daemon crashed");
    expect(stored.timestamp).toBe("2026-01-01T12:00:00.000Z");
    expect(stored.source).toBe("daemon");
  });

  it("RangeError is thrown when capacity < 1", async () => {
    const { RuntimeEventStore } = await import("./lib/runtime-event-store.js");
    expect(() => new RuntimeEventStore(0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// deriveRuntimeEvent — unit tests
// ---------------------------------------------------------------------------

describe("deriveRuntimeEvent", () => {
  it("infers level=error from event name suffix :error", async () => {
    const { deriveRuntimeEvent } = await import("./lib/runtime-event-store.js");
    const event = deriveRuntimeEvent("write:error", { message: "LLM timeout" });
    expect(event.level).toBe("error");
  });

  it("prefers explicit level field from data over inferred level", async () => {
    const { deriveRuntimeEvent } = await import("./lib/runtime-event-store.js");
    const event = deriveRuntimeEvent("log", { level: "warn", message: "low memory" });
    expect(event.level).toBe("warn");
    expect(event.message).toBe("low memory");
  });

  it("falls back to event name as message when data has no message", async () => {
    const { deriveRuntimeEvent } = await import("./lib/runtime-event-store.js");
    const event = deriveRuntimeEvent("daemon:started", {});
    expect(event.message).toBe("daemon:started");
    expect(event.source).toBe("daemon");
  });

  it("extracts bookId and chapter from data", async () => {
    const { deriveRuntimeEvent } = await import("./lib/runtime-event-store.js");
    const event = deriveRuntimeEvent("write:complete", { bookId: "my-book", chapterNumber: 3, message: "done" });
    expect(event.bookId).toBe("my-book");
    expect(event.chapter).toBe(3);
  });

  it("handles non-object data gracefully", async () => {
    const { deriveRuntimeEvent } = await import("./lib/runtime-event-store.js");
    const event = deriveRuntimeEvent("ping", null);
    expect(event.level).toBe("info");
    expect(event.message).toBe("ping");
    expect(event.bookId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: broadcast events land in runtimeEventStore
// ---------------------------------------------------------------------------

describe("runtimeEventStore integration via server broadcast", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-store-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig, null, 2), "utf-8");

    // reset mocks (shared with outer describe)
    schedulerStartMock.mockReset();
    initBookMock.mockReset();
    writeNextChapterMock.mockResolvedValue({ chapterNumber: 1, wordCount: 1200, revised: false, status: "ready-for-review", auditResult: { passed: true, issues: [], summary: "ok" } });
    reviseDraftMock.mockResolvedValue({ chapterNumber: 3, wordCount: 1800, fixedIssues: [], applied: true, status: "ready-for-review" });
    loadProjectConfigMock.mockImplementation(async () => cloneProjectConfig());
    loadChapterIndexMock.mockResolvedValue([]);
    saveChapterIndexMock.mockResolvedValue(undefined);
    rollbackToChapterMock.mockResolvedValue([]);
    planChapterMock.mockResolvedValue({
      bookId: "demo-book",
      chapterNumber: 1,
      intentPath: "chapters/intent/0001_intent.json",
      goal: "主角发现线索",
      conflicts: [],
    });
    createLLMClientMock.mockReturnValue({});
    chatCompletionMock.mockResolvedValue({ content: "pong", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    pipelineConfigs.length = 0;

    // clear the module-level store before each integration test
    const { runtimeEventStore } = await import("./lib/runtime-event-store.js");
    runtimeEventStore.clear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("write-next emits semantic start/success sequence with action payload fields", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 1500 }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(writeNextChapterMock).toHaveBeenCalled());

    const runtimeResponse = await app.request("http://localhost/api/runtime/events?bookId=demo-book&limit=50");
    expect(runtimeResponse.status).toBe(200);
    const runtimeData = await runtimeResponse.json() as {
      entries: Array<{ event: string; data: unknown }>;
    };
    const semanticEvents = runtimeData.entries.filter((entry) =>
      entry.event.startsWith("write-next:") || entry.event.startsWith("compose:")
    );
    expect(semanticEvents.map((entry) => entry.event)).toEqual([
      "write-next:start",
      "compose:start",
      "compose:success",
      "write-next:success",
    ]);
    expect(semanticEvents[0]?.data).toMatchObject({
      action: "write-next",
      chapterNumber: 1,
      briefUsed: false,
      bookId: "demo-book",
    });
    expect(semanticEvents[2]?.data).toMatchObject({
      action: "compose",
      chapterNumber: 1,
      briefUsed: false,
      bookId: "demo-book",
    });
  });

  it("revise emits semantic start/success events with chapter number and brief-used", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "聚焦债务冲突" }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(reviseDraftMock).toHaveBeenCalled());

    await vi.waitFor(async () => {
      const runtimeResponse = await app.request("http://localhost/api/runtime/events?bookId=demo-book&limit=50");
      const runtimeData = await runtimeResponse.json() as {
        entries: Array<{ event: string; data: unknown }>;
      };
      const reviseEvents = runtimeData.entries.filter((entry) => entry.event.startsWith("revise:"));
      expect(reviseEvents.map((entry) => entry.event)).toEqual(["revise:start", "revise:success"]);
      expect(reviseEvents[0]?.data).toMatchObject({
        action: "revise",
        chapterNumber: 3,
        briefUsed: true,
        bookId: "demo-book",
      });
    });
  });

  it("plan and write-next in ai-plan mode emit plan/compose/write-next lifecycle events", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ai-plan", planInput: "聚焦师债", wordCount: 1000 }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(writeNextChapterMock).toHaveBeenCalled());

    const runtimeResponse = await app.request("http://localhost/api/runtime/events?bookId=demo-book&limit=100");
    const runtimeData = await runtimeResponse.json() as {
      entries: Array<{ event: string; data: unknown }>;
    };
    const lifecycle = runtimeData.entries.filter((entry) =>
      entry.event.startsWith("plan:")
      || entry.event.startsWith("compose:")
      || entry.event.startsWith("write-next:")
    );
    expect(lifecycle.map((entry) => entry.event)).toEqual([
      "write-next:start",
      "plan:start",
      "plan:success",
      "compose:start",
      "compose:success",
      "write-next:success",
    ]);
    expect(lifecycle.find((entry) => entry.event === "plan:start")?.data).toMatchObject({
      action: "plan",
      briefUsed: true,
      bookId: "demo-book",
      chapterNumber: 1,
    });
  });

  it("rewrite and resync emit success/fail events without silent failures", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    writeNextChapterMock.mockRejectedValueOnce(new Error("rewrite failed"));
    const rewriteResponse = await app.request("http://localhost/api/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "保持人物弧线" }),
    });
    expect(rewriteResponse.status).toBe(200);
    await vi.waitFor(async () => {
      const runtimeResponse = await app.request("http://localhost/api/runtime/events?bookId=demo-book&limit=100");
      const runtimeData = await runtimeResponse.json() as { entries: Array<{ event: string }> };
      expect(runtimeData.entries.map((entry) => entry.event)).toContain("rewrite:fail");
    });

    const resyncResponse = await app.request("http://localhost/api/books/demo-book/resync/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "同步章节事实" }),
    });
    expect(resyncResponse.status).toBe(200);
    const runtimeResponse = await app.request("http://localhost/api/runtime/events?bookId=demo-book&limit=100");
    const runtimeData = await runtimeResponse.json() as {
      entries: Array<{ event: string; data: unknown }>;
    };
    const resyncEvents = runtimeData.entries.filter((entry) => entry.event.startsWith("resync:"));
    expect(resyncEvents.map((entry) => entry.event)).toEqual(["resync:start", "resync:success"]);
    expect(resyncEvents[0]?.data).toMatchObject({
      action: "resync",
      chapterNumber: 3,
      briefUsed: true,
      bookId: "demo-book",
    });
  });

  it("all stored events have the required fields", async () => {
    const { createStudioServer } = await import("./server.js");
    const { runtimeEventStore } = await import("./lib/runtime-event-store.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    await app.request("http://localhost/api/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordCount: 1000 }),
    });

    await vi.waitFor(() => expect(writeNextChapterMock).toHaveBeenCalled());

    const events = runtimeEventStore.query();
    for (const e of events) {
      expect(typeof e.eventType).toBe("string");
      expect(["info", "warn", "error"]).toContain(e.level);
      expect(typeof e.message).toBe("string");
      expect(typeof e.timestamp).toBe("string");
      expect(typeof e.source).toBe("string");
    }

    const runtimeResponse = await app.request("http://localhost/api/runtime/events?bookId=demo-book&limit=100");
    expect(runtimeResponse.status).toBe(200);
    const runtimeData = await runtimeResponse.json() as {
      entries: Array<{ event: string; data: unknown }>;
    };
    const semanticEntries = runtimeData.entries.filter((entry) =>
      entry.event.startsWith("write-next:")
      || entry.event.startsWith("compose:")
      || entry.event.startsWith("plan:")
      || entry.event.startsWith("revise:")
      || entry.event.startsWith("rewrite:")
      || entry.event.startsWith("resync:")
    );
    for (const entry of semanticEntries) {
      const payload = entry.data as {
        action?: unknown;
        chapterNumber?: unknown;
        briefUsed?: unknown;
      };
      expect(typeof payload.action).toBe("string");
      expect(typeof payload.briefUsed).toBe("boolean");
      if (payload.chapterNumber !== undefined) {
        expect(typeof payload.chapterNumber).toBe("number");
      }
    }
  });

  it("writes and echoes project-level writing governance settings", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const initialResponse = await app.request("http://localhost/api/project/writing-governance");
    expect(initialResponse.status).toBe(200);
    await expect(initialResponse.json()).resolves.toMatchObject({
      settings: {
        styleTemplate: "narrative-balance",
        reviewStrictnessBaseline: "balanced",
        antiAiTraceStrength: "medium",
      },
    });

    const saveResponse = await app.request("http://localhost/api/project/writing-governance", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        styleTemplate: "cinematic",
        reviewStrictnessBaseline: "strict-plus",
        antiAiTraceStrength: "max",
      }),
    });
    expect(saveResponse.status).toBe(200);
    await expect(saveResponse.json()).resolves.toMatchObject({
      ok: true,
      settings: {
        styleTemplate: "cinematic",
        reviewStrictnessBaseline: "strict-plus",
        antiAiTraceStrength: "max",
      },
    });

    const echoResponse = await app.request("http://localhost/api/project/writing-governance");
    expect(echoResponse.status).toBe(200);
    await expect(echoResponse.json()).resolves.toMatchObject({
      settings: {
        styleTemplate: "cinematic",
        reviewStrictnessBaseline: "strict-plus",
        antiAiTraceStrength: "max",
      },
    });
  });
});
