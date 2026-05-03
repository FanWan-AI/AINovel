/**
 * Tests for the P0/P1 NovelOS upgrade:
 * - assistant-artifact-service
 * - intent-router-service
 * - context-resolver-service
 * - plot-critique-service
 * - steering-contract-service (compiler)
 * - contract-verifier-service
 * - write-next-service (sourceArtifactIds + blueprint)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssistantArtifactService,
  type AssistantArtifact,
  type AssistantArtifactSummary,
} from "./assistant-artifact-service.js";
import {
  routeAssistantIntent,
  type IntentRouterInput,
} from "./intent-router-service.js";
import {
  resolveContext,
  type ContextResolverInput,
} from "./context-resolver-service.js";
import {
  generatePlotCritique,
  type PlotCritiqueInput,
} from "./plot-critique-service.js";
import {
  compileSteeringContract,
  type CompileSteeringContractInput,
} from "./steering-contract-service.js";
import {
  verifyContractSatisfaction,
  type VerifyContractInput,
} from "./contract-verifier-service.js";
import { buildWriteNextExternalContext } from "./write-next-service.js";

// ── Fixtures ───────────────────────────────────────────────────────────

function sampleChapters() {
  return [
    {
      number: 1,
      title: "开端",
      content:
        "万凡冷静分析了局势，仔细思考着下一步。他在心里默默记下了林清雪的异样表现。" +
        "他决定暂时先不行动，留待后续再做判断。发现了一些线索，但还需要更多信息才能下结论。",
      wordCount: 80,
    },
    {
      number: 2,
      title: "对峙",
      content:
        "万凡主动找到了林清雪，直接表达了自己的怀疑。两人发生了一场激烈的争执。" +
        "万凡果断出手，验证了自己的猜测。这是一个出乎意料的反转，让局势发生了巨大变化。" +
        "虽然取得了突破，但也付出了暴露行踪的代价。",
      wordCount: 90,
    },
  ];
}

function sampleTruthFiles() {
  return [
    { name: "story_bible", content: "林清雪，25岁，情报人员。万凡，28岁，调查员。" },
    { name: "current_state", content: "林清雪开始怀疑万凡的真实身份。" },
  ];
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Assistant Artifact Service", () => {
  let tempDir: string;
  let svc: AssistantArtifactService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "art-test-"));
    svc = new AssistantArtifactService({
      artifactsRoot: join(tempDir, ".inkos", "assistant-artifacts"),
      booksRoot: join(tempDir, "books"),
      now: () => "2026-05-02T00:00:00.000Z",
    });
  });

  it("creates and retrieves an artifact by session", async () => {
    const art = await svc.create({
      sessionId: "sess-1",
      bookId: "book-1",
      type: "plot_critique",
      title: "剧情分析",
      payload: { strengths: ["有冲突"], weaknesses: ["节奏慢"] },
      summary: "有冲突但节奏慢",
      searchableText: "冲突 节奏",
    });

    expect(art.artifactId).toMatch(/^art_/);
    expect(art.type).toBe("plot_critique");
    expect(art.createdAt).toBe("2026-05-02T00:00:00.000Z");

    const recent = await svc.listRecentSessionArtifacts("sess-1");
    expect(recent).toHaveLength(1);
    expect(recent[0].artifactId).toBe(art.artifactId);
    expect(recent[0].type).toBe("plot_critique");
  });

  it("persisted JSONL is readable", async () => {
    await svc.create({
      sessionId: "sess-2",
      type: "plot_critique",
      title: "测试",
      payload: {},
      summary: "s",
      searchableText: "s",
    });

    const jsonlPath = join(tempDir, ".inkos", "assistant-artifacts", "sess-2.jsonl");
    const raw = await readFile(jsonlPath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.type).toBe("plot_critique");
  });

  it("retrieves by id", async () => {
    const art = await svc.create({
      sessionId: "sess-3",
      type: "chapter_plan",
      title: "计划",
      payload: {},
      summary: "plan",
      searchableText: "plan",
    });

    const found = await svc.getById(art.artifactId, "sess-3");
    expect(found).not.toBeNull();
    expect(found!.artifactId).toBe(art.artifactId);
  });

  it("filters by type", async () => {
    await svc.create({
      sessionId: "sess-4",
      type: "plot_critique",
      title: "A",
      payload: {},
      summary: "a",
      searchableText: "a",
    });
    await svc.create({
      sessionId: "sess-4",
      type: "chapter_plan",
      title: "B",
      payload: {},
      summary: "b",
      searchableText: "b",
    });

    const critiques = await svc.listByType("sess-4", "plot_critique");
    expect(critiques).toHaveLength(1);
    expect(critiques[0].title).toBe("A");
  });
});

describe("Intent Router Service", () => {
  const baseInput: Omit<IntentRouterInput, "userText"> = {
    sessionId: "sess-1",
    selectedBookIds: ["book-1"],
    recentMessages: [],
    recentArtifacts: [],
  };

  it('detects "目前剧情写得如何?" as ask_plot_quality', () => {
    const result = routeAssistantIntent({
      ...baseInput,
      userText: "目前剧情写得如何？",
    });
    expect(result.intentType).toBe("ask_plot_quality");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects "按照你刚才说的优缺点规划下一章" as plan_next_from_previous_analysis when artifact exists', () => {
    const artifacts: AssistantArtifactSummary[] = [
      {
        artifactId: "art_abc123",
        sessionId: "sess-1",
        type: "plot_critique",
        title: "剧情分析",
        createdAt: "2026-05-02T00:00:00.000Z",
        summary: "有冲突但节奏慢",
      },
    ];
    const result = routeAssistantIntent({
      ...baseInput,
      userText: "按照你刚才说的优缺点规划下一章",
      recentArtifacts: artifacts,
    });
    expect(result.intentType).toBe("plan_next_from_previous_analysis");
    expect(result.referencedArtifactIds).toContain("art_abc123");
  });

  it('detects "第2条建议" as plan_next_from_previous_analysis', () => {
    const artifacts: AssistantArtifactSummary[] = [
      {
        artifactId: "art_xyz",
        sessionId: "sess-1",
        type: "plot_critique",
        title: "剧情分析",
        createdAt: "2026-05-02T00:00:00.000Z",
        summary: "分析",
      },
    ];
    const result = routeAssistantIntent({
      ...baseInput,
      userText: "就按第2条建议写",
      recentArtifacts: artifacts,
    });
    expect(result.intentType).toBe("plan_next_from_previous_analysis");
    expect(result.referencedArtifactIds).toContain("art_xyz");
  });

  it('detects "写下一章必须让XXX" as write_next_with_user_plot', () => {
    const result = routeAssistantIntent({
      ...baseInput,
      userText: "下一章必须让林清雪主动找万凡",
    });
    expect(result.intentType).toBe("write_next_with_user_plot");
  });
});

describe("Context Resolver Service", () => {
  const artifacts: AssistantArtifactSummary[] = [
    {
      artifactId: "art_critique_001",
      sessionId: "sess-1",
      type: "plot_critique",
      title: "剧情分析",
      createdAt: "2026-05-02T00:00:00.000Z",
      summary: "分析结果",
    },
  ];

  it('resolves "按你刚才说的" to the most recent artifact', () => {
    const result = resolveContext({
      sessionId: "sess-1",
      userText: "按照你刚才说的优缺点规划下一章",
      recentArtifacts: artifacts,
    });
    expect(result.resolvedReferences).toHaveLength(1);
    expect(result.resolvedReferences[0].artifactId).toBe("art_critique_001");
    expect(result.resolvedReferences[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("extracts mustInclude from explicit requirements", () => {
    const result = resolveContext({
      sessionId: "sess-1",
      userText: "下一章必须让林清雪主动找万凡，并出现一次误判反转，不要让万凡被动等消息",
      recentArtifacts: [],
    });
    expect(result.extractedUserRequirements.mustInclude.length).toBeGreaterThan(0);
    expect(result.extractedUserRequirements.mustAvoid.length).toBeGreaterThan(0);
    // Check that characters are detected
    expect(result.extractedUserRequirements.characterFocus).toContain("林清雪");
    expect(result.extractedUserRequirements.characterFocus).toContain("万凡");
  });
});

describe("Plot Critique Service", () => {
  it("generates critique with strengths, weaknesses, and opportunities", () => {
    const result = generatePlotCritique({
      bookId: "book-1",
      chapterRange: { from: 1, to: 2 },
      chapters: sampleChapters(),
      truthFiles: sampleTruthFiles(),
    });

    expect(result.type).toBe("plot_critique");
    expect(result.bookId).toBe("book-1");
    expect(result.chapterRange).toEqual({ from: 1, to: 2 });
    expect(result.nextChapterOpportunities.length).toBeGreaterThan(0);
    // Chapter 1 has stale patterns, chapter 2 has active patterns
    expect(result.weaknesses.length).toBeGreaterThan(0);
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});

describe("Steering Contract Compiler", () => {
  it("compiles user intent + critique into a steering contract", () => {
    const input: CompileSteeringContractInput = {
      userText: "下一章必须让林清雪主动找万凡，并出现一次误判反转，不要让万凡被动等消息",
      resolvedRequirements: {
        goals: [],
        mustInclude: ["林清雪主动找万凡", "误判反转"],
        mustAvoid: ["万凡被动等消息"],
        desiredTone: [],
        characterFocus: ["林清雪", "万凡"],
        payoffRequests: ["出现一次反转"],
      },
      referencedCritiquePayload: {
        nextChapterOpportunities: [
          {
            title: "主角主动出击",
            why: "近期章节主角被动分析过多",
            mustInclude: ["主角做出主动选择", "面对直接阻力"],
            risk: "强行转折可能显得突兀",
            payoff: "读者期待主角打破被动局面",
          },
        ],
      },
      sourceArtifactIds: ["art_critique_001"],
    };

    const contract = compileSteeringContract(input);
    expect(contract.mustInclude).toContain("林清雪主动找万凡");
    expect(contract.mustInclude).toContain("误判反转");
    expect(contract.mustAvoid).toContain("万凡被动等消息");
    expect(contract.priority).toBe("hard");
    expect(contract.sourceArtifactIds).toContain("art_critique_001");
    expect(contract.sceneBeats.length).toBeGreaterThan(0);
    expect(contract.rawRequest).toBe(input.userText);
  });
});

describe("Contract Verifier Service", () => {
  it("reports satisfied when chapter contains mustInclude items", () => {
    const chapterText =
      "林清雪主动找万凡，直接对万凡发起了试探。" +
      "万凡一开始以为自己看透了全局，却没想到局势出了差错，出现一次误判反转，真正局势才刚刚开始。" +
      "万凡早已布局完毕，一切尽在掌握。";

    const result = verifyContractSatisfaction({
      chapterText,
      mustInclude: ["林清雪主动找万凡", "误判反转"],
      mustAvoid: ["万凡被动等消息"],
      sceneBeats: [],
    });

    expect(result.satisfactionRate).toBeGreaterThanOrEqual(0.7);
    const includeItems = result.items.filter((i) => i.requirement.includes("必须包含"));
    for (const item of includeItems) {
      expect(["satisfied", "partial"]).toContain(item.status);
    }
    const avoidItems = result.items.filter((i) => i.requirement.includes("必须避免"));
    for (const item of avoidItems) {
      expect(item.status).toBe("satisfied");
    }
  });

  it("reports missing when chapter does NOT contain mustInclude items", () => {
    const chapterText = "这一章什么都没发生，万凡继续闲逛。";

    const result = verifyContractSatisfaction({
      chapterText,
      mustInclude: ["林清雪主动找万凡", "误判反转"],
      mustAvoid: ["万凡被动等消息"],
      sceneBeats: [],
    });

    expect(result.satisfactionRate).toBeLessThan(0.7);
    expect(result.shouldRewrite).toBe(true);
    const missingItems = result.items.filter((i) => i.status === "missing");
    expect(missingItems.length).toBeGreaterThan(0);
  });

  it("detects mustAvoid violations", () => {
    const chapterText = "万凡被动等消息，什么都没做。林清雪主动找万凡。误判反转出现了。";

    const result = verifyContractSatisfaction({
      chapterText,
      mustInclude: ["林清雪主动找万凡", "误判反转"],
      mustAvoid: ["万凡被动等消息"],
      sceneBeats: [],
    });

    const avoidItem = result.items.find((i) => i.requirement.includes("万凡被动等消息"));
    expect(avoidItem).toBeDefined();
    expect(avoidItem!.status).toBe("missing"); // "missing" means violation for mustAvoid
  });
});

describe("Write-Next Service — sourceArtifactIds & blueprint", () => {
  it("includes sourceArtifactIds in externalContext", () => {
    const ctx = buildWriteNextExternalContext({
      steeringContract: {
        goal: "林清雪主动找万凡",
        mustInclude: ["林清雪主动找万凡", "误判反转"],
        mustAvoid: ["万凡被动等消息"],
        sceneBeats: ["开场: 林清雪决定行动", "转折: 误判发生"],
        priority: "hard",
      },
      sourceArtifactIds: ["art_critique_001", "art_critique_002"],
    });

    expect(ctx).toBeDefined();
    expect(ctx!).toContain("Steering Contract");
    expect(ctx!).toContain("林清雪主动找万凡");
    expect(ctx!).toContain("误判反转");
    expect(ctx!).toContain("万凡被动等消息");
    expect(ctx!).toContain("Source Artifacts");
    expect(ctx!).toContain("art_critique_001");
    expect(ctx!).toContain("art_critique_002");
  });
});

describe("End-to-end: 切片 1 flow", () => {
  let tempDir: string;
  let svc: AssistantArtifactService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e2e-test-"));
    svc = new AssistantArtifactService({
      artifactsRoot: join(tempDir, ".inkos", "assistant-artifacts"),
      booksRoot: join(tempDir, "books"),
      now: () => "2026-05-02T00:00:00.000Z",
    });
  });

  it("Step 1: User asks plot quality → generates plot_critique artifact", async () => {
    const intent = routeAssistantIntent({
      sessionId: "sess-e2e",
      userText: "目前剧情写得如何？",
      selectedBookIds: ["book-1"],
      recentMessages: [],
      recentArtifacts: [],
    });
    expect(intent.intentType).toBe("ask_plot_quality");

    // Generate critique
    const critique = generatePlotCritique({
      bookId: "book-1",
      chapterRange: { from: 1, to: 2 },
      chapters: sampleChapters(),
      truthFiles: sampleTruthFiles(),
    });

    // Store as artifact
    const art = await svc.create({
      sessionId: "sess-e2e",
      bookId: "book-1",
      type: "plot_critique",
      title: "剧情分析: book-1 章节 1-2",
      payload: critique as unknown as Record<string, unknown>,
      summary: `剧情分析：${critique.strengths.length} 个优势，${critique.weaknesses.length} 个问题`,
      searchableText: JSON.stringify(critique),
    });

    expect(art.artifactId).toMatch(/^art_/);
    expect(art.type).toBe("plot_critique");

    // Verify persistence
    const recent = await svc.listRecentSessionArtifacts("sess-e2e");
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe("plot_critique");
  });

  it("Step 2: User says '按照你刚才说的规划下一章' → references previous artifact", async () => {
    // Step 1: create a critique artifact
    const critique = generatePlotCritique({
      bookId: "book-1",
      chapterRange: { from: 1, to: 2 },
      chapters: sampleChapters(),
      truthFiles: sampleTruthFiles(),
    });
    const art = await svc.create({
      sessionId: "sess-e2e",
      bookId: "book-1",
      type: "plot_critique",
      title: "剧情分析",
      payload: critique as unknown as Record<string, unknown>,
      summary: "分析",
      searchableText: "分析",
    });

    // Step 2: user references it
    const recentSummaries = await svc.listRecentSessionArtifacts("sess-e2e");
    const intent = routeAssistantIntent({
      sessionId: "sess-e2e",
      userText: "按照你刚才说的优缺点规划下一章",
      selectedBookIds: ["book-1"],
      recentMessages: [],
      recentArtifacts: recentSummaries,
    });
    expect(intent.intentType).toBe("plan_next_from_previous_analysis");
    expect(intent.referencedArtifactIds).toContain(art.artifactId);

    // Resolve context
    const resolved = resolveContext({
      sessionId: "sess-e2e",
      userText: "按照你刚才说的优缺点规划下一章",
      recentArtifacts: recentSummaries,
    });
    expect(resolved.resolvedReferences).toHaveLength(1);
    expect(resolved.resolvedReferences[0].artifactId).toBe(art.artifactId);

    // Compile steering contract
    const contract = compileSteeringContract({
      userText: "按照你刚才说的优缺点规划下一章",
      resolvedRequirements: resolved.extractedUserRequirements,
      referencedCritiquePayload: critique as {
        nextChapterOpportunities?: ReadonlyArray<{
          title: string;
          why: string;
          mustInclude: ReadonlyArray<string>;
          risk: string;
          payoff: string;
        }>;
        weaknesses?: ReadonlyArray<string>;
      },
      sourceArtifactIds: intent.referencedArtifactIds,
    });
    expect(contract.sourceArtifactIds).toContain(art.artifactId);
    expect(contract.sceneBeats.length).toBeGreaterThan(0);
  });

  it("Step 3: User gives explicit mustInclude/mustAvoid → contract and verifier work", () => {
    const userText = "下一章必须让林清雪主动找万凡，并出现一次误判反转，不要让万凡被动等消息";

    // Resolve context
    const resolved = resolveContext({
      sessionId: "sess-e2e",
      userText,
      recentArtifacts: [],
    });

    expect(resolved.extractedUserRequirements.mustInclude.length).toBeGreaterThan(0);
    expect(resolved.extractedUserRequirements.mustAvoid.length).toBeGreaterThan(0);

    // Compile contract
    const contract = compileSteeringContract({
      userText,
      resolvedRequirements: resolved.extractedUserRequirements,
      sourceArtifactIds: [],
    });

    expect(contract.mustInclude).toContain("林清雪主动找万凡");
    expect(contract.mustInclude.some((s: string) => s.includes("误判反转"))).toBe(true);
    expect(contract.mustAvoid).toContain("万凡被动等消息");
    expect(contract.priority).toBe("hard");

    // Write-next external context
    const externalContext = buildWriteNextExternalContext({
      steeringContract: {
        goal: contract.goal,
        mustInclude: [...contract.mustInclude],
        mustAvoid: [...contract.mustAvoid],
        sceneBeats: [...contract.sceneBeats],
        priority: contract.priority,
      },
      sourceArtifactIds: [...contract.sourceArtifactIds],
    });

    expect(externalContext).toBeDefined();
    expect(externalContext!).toContain("林清雪主动找万凡");
    expect(externalContext!).toContain("误判反转");
    expect(externalContext!).toContain("万凡被动等消息");

    // Simulate chapter with correct content
    const goodChapter =
      "林清雪主动找万凡，直接对万凡发起了试探。" +
      "万凡一开始以为自己看透了全局，却没想到局势出了差错，出现一次误判反转，真正局势才刚刚开始。" +
      "万凡早已布局完毕，一切尽在掌握。";

    const verification = verifyContractSatisfaction({
      chapterText: goodChapter,
      mustInclude: [...contract.mustInclude],
      mustAvoid: [...contract.mustAvoid],
      sceneBeats: [...contract.sceneBeats],
    });

    expect(verification.satisfactionRate).toBeGreaterThanOrEqual(0.7);
    expect(verification.items.every((i) => i.status !== "missing")).toBe(true);

    // Simulate chapter with wrong content
    const badChapter = "万凡继续等消息，什么都没发生。";

    const badVerification = verifyContractSatisfaction({
      chapterText: badChapter,
      mustInclude: [...contract.mustInclude],
      mustAvoid: [...contract.mustAvoid],
      sceneBeats: [...contract.sceneBeats],
    });

    expect(badVerification.satisfactionRate).toBeLessThan(0.5);
    expect(badVerification.shouldRewrite).toBe(true);
    const missingItems = badVerification.items.filter((i) => i.status === "missing");
    expect(missingItems.length).toBeGreaterThan(0);
  });
});
