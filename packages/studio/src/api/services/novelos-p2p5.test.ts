/**
 * Tests for P2-P5 NovelOS upgrade:
 * - P2: Narrative Graph Service (patches, impact, apply, rollback)
 * - P3: Graph-to-Steering Compiler
 * - P4: (API endpoints tested via typecheck)
 * - P5: Developmental Editor
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NarrativeGraphService } from "./narrative-graph-service.js";
import { compileGraphPatchesToSteering, enrichSteeringInputWithGraphPatches } from "./graph-to-steering-compiler.js";
import { evaluateChapterDrama, type DevelopmentalEditorInput } from "./developmental-editor-service.js";
import { compileSteeringContract } from "./steering-contract-service.js";
import type {
  NarrativeGraphOperation,
  NarrativeGraphPatch,
} from "../schemas/narrative-graph-schema.js";

// ── P2: Narrative Graph Service ────────────────────────────────────────

describe("P2: Narrative Graph Service", () => {
  let tempDir: string;
  let svc: NarrativeGraphService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "graph-test-"));
    svc = new NarrativeGraphService({
      booksRoot: join(tempDir, "books"),
      now: () => "2026-05-02T00:00:00.000Z",
    });
  });

  it("loads empty graph for new book", async () => {
    const graph = await svc.loadGraph("new-book");
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.version).toBe(0);
  });

  it("creates patch with impact analysis", async () => {
    // Save graph with an existing edge
    const graph = await svc.loadGraph("book-1");
    await svc.saveGraph({
      ...graph,
      edges: [{ id: "edge-1", source: "c1", target: "c2", type: "tests", label: "试探", strength: 0.5, evidence: [], metadata: {} }],
    });

    const operations: NarrativeGraphOperation[] = [
      {
        type: "update_edge",
        edgeId: "edge-1",
        patch: { label: "主动试探合作", status: "active" },
      },
    ];

    const patch = await svc.createPatch("book-1", operations, "用户修改关系");
    expect(patch.patchId).toMatch(/^patch_/);
    expect(patch.status).toBe("impact_analyzed");
    expect(patch.impactAnalysis).toBeDefined();
    expect(patch.impactAnalysis!.riskLevel).toBe("medium");
    expect(patch.impactAnalysis!.recommendation).toBe("apply_with_warning");
  });

  it("persists patches to JSONL", async () => {
    const operations: NarrativeGraphOperation[] = [
      {
        type: "add_edge",
        edge: {
          id: "edge-new",
          source: "char-1",
          target: "char-2",
          type: "foreshadows",
          label: "隐藏身份伏笔",
          strength: 0.8,
          status: "planned",
          evidence: [],
          metadata: {},
        },
      },
    ];

    await svc.createPatch("book-2", operations, "新增伏笔");

    const patches = await svc.listPatches("book-2");
    expect(patches).toHaveLength(1);
    expect(patches[0].reason).toBe("新增伏笔");
  });

  it("applies patch to graph", async () => {
    // First add a node to the graph
    const graph = await svc.loadGraph("book-3");
    const updatedGraph = {
      ...graph,
      nodes: [
        {
          id: "char-1",
          type: "character" as const,
          label: "林清雪",
          confidence: 0.9,
          weight: 1,
          tags: ["女主"],
          evidence: [],
          userEditable: true,
          metadata: {},
        },
      ],
    };
    await svc.saveGraph(updatedGraph);

    // Create and approve a patch
    const operations: NarrativeGraphOperation[] = [
      {
        type: "update_node",
        nodeId: "char-1",
        patch: { summary: "开始主动试探万凡的真实身份" },
      },
    ];
    const patch = await svc.createPatch("book-3", operations, "更新人物状态");

    // Apply it
    const result = await svc.applyPatch("book-3", patch.patchId);
    expect(result.version).toBe(1);
    expect(result.nodes[0].summary).toBe("开始主动试探万凡的真实身份");
  });

  it("marks patch as consumed", async () => {
    await svc.markPatchConsumed("book-4", "patch-test", "consumed");
    const patches = await svc.listPatches("book-4");
    expect(patches[0].status).toBe("consumed");
  });

  it("filters unconsumed patches", async () => {
    const ops: NarrativeGraphOperation[] = [{
      type: "add_node",
      node: { id: "n1", type: "hook", label: "悬念", confidence: 0.8, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
    }];
    const patch = await svc.createPatch("book-5", ops, "test");

    // Apply it
    await svc.applyPatch("book-5", patch.patchId);

    const unconsumed = await svc.getUnconsumedPatches("book-5");
    expect(unconsumed.length).toBeGreaterThan(0);
    expect(unconsumed[0].patchId).toBe(patch.patchId);
  });
});

// ── P3: Graph-to-Steering Compiler ─────────────────────────────────────

describe("P3: Graph-to-Steering Compiler", () => {
  it("compiles patches into steering hints", () => {
    const patches: NarrativeGraphPatch[] = [
      {
        patchId: "patch-1",
        bookId: "book-1",
        createdAt: "2026-05-02T00:00:00.000Z",
        createdBy: "user",
        status: "impact_analyzed",
        reason: "修改关系",
        operations: [
          {
            type: "update_edge",
            edgeId: "edge-1",
            patch: { label: "主动试探合作", status: "active" },
          },
        ],
        impactAnalysis: {
          riskLevel: "medium",
          affectedCharacters: ["林清雪", "万凡"],
          affectedHooks: [],
          affectedRules: [],
          affectedChapters: [],
          contradictions: [],
          requiredStoryPatches: [],
          nextChapterSteeringHints: {
            mustInclude: ["林清雪主动找万凡"],
            mustAvoid: ["林清雪无理由完全信任万凡"],
            sceneBeats: ["林清雪展现对万凡的主动试探合作态度"],
          },
          recommendation: "apply_with_warning",
        },
      },
    ];

    const result = compileGraphPatchesToSteering(patches);
    expect(result.mustInclude).toContain("林清雪主动找万凡");
    expect(result.mustAvoid).toContain("林清雪无理由完全信任万凡");
    expect(result.sceneBeats.length).toBeGreaterThan(0);
    expect(result.sourcePatchIds).toContain("patch-1");
  });

  it("enriches steering input with graph patches", () => {
    const base = {
      userText: "写下一章",
      resolvedRequirements: { goals: [], mustInclude: ["原有要求"], mustAvoid: [], desiredTone: [], characterFocus: [], payoffRequests: [] },
      sourceArtifactIds: [],
    };

    const graphResult = {
      mustInclude: ["图谱要求1"],
      mustAvoid: ["图谱避免1"],
      sceneBeats: [],
      sourcePatchIds: ["patch-1"],
      patchRequirements: [],
    };

    const enriched = enrichSteeringInputWithGraphPatches(base, graphResult);
    expect(enriched.resolvedRequirements.mustInclude).toContain("原有要求");
    expect(enriched.resolvedRequirements.mustInclude).toContain("图谱要求1");
    expect(enriched.resolvedRequirements.mustAvoid).toContain("图谱避免1");
    expect(enriched.sourceArtifactIds).toContain("patch-1");
  });
});

// ── P5: Developmental Editor ───────────────────────────────────────────

describe("P5: Developmental Editor", () => {
  it("scores a well-written chapter highly", () => {
    const chapterText =
      "林清雪主动找万凡，直接质问他的真实身份。" +
      "万凡果断做出选择，决定部分坦白。" +
      "这是一个出乎意料的反转，让林清雪震惊不已。" +
      "虽然获得了信任，但也暴露了关键信息。" +
      "万凡知道，真正的代价才刚刚开始。";

    const report = evaluateChapterDrama({ chapterText, chapterNumber: 1 });

    expect(report.overallScore).toBeGreaterThan(4);
    expect(report.dimensions.conflict).toBeGreaterThanOrEqual(3);
    expect(report.dimensions.agency).toBeGreaterThan(3);
    expect(report.dimensions.payoff).toBeGreaterThan(3);
  });

  it("scores a passive chapter poorly", () => {
    const chapterText =
      "万凡冷静分析了局势，仔细思考着下一步。" +
      "他在心里默默记下了一切。" +
      "暂时先不行动，留待后续再做判断。" +
      "他观察着周围的一切，默默等待时机。";

    const report = evaluateChapterDrama({ chapterText, chapterNumber: 2 });

    expect(report.dimensions.agency).toBeLessThan(5);
    expect(report.rewriteAdvice.length).toBeGreaterThan(0);
  });

  it("detects AI tell words", () => {
    const chapterText =
      "她的眼睛像湖水般深邃，仿佛能看穿一切。" +
      "宛如寒潭中的墨玉，似乎藏着无尽秘密。" +
      "他的身影像一座山，仿佛永远不会动摇。";

    const report = evaluateChapterDrama({ chapterText, chapterNumber: 1 });
    expect(report.dimensions.proseFreshness).toBeLessThan(7);
  });

  it("checks contract satisfaction", () => {
    const chapterText = "林清雪主动找万凡。万凡果断回应。";

    const report = evaluateChapterDrama({
      chapterText,
      chapterNumber: 1,
      steeringContract: {
        mustInclude: ["林清雪主动找万凡"],
        mustAvoid: ["万凡被动等消息"],
      },
    });

    expect(report.dimensions.contractSatisfaction).toBe(10);
    expect(report.blockingIssues).toHaveLength(0);
  });

  it("reports blocking issues for unsatisfied contract", () => {
    const chapterText = "万凡闲逛了一天。";

    const report = evaluateChapterDrama({
      chapterText,
      chapterNumber: 1,
      steeringContract: {
        mustInclude: ["林清雪主动找万凡", "误判反转"],
        mustAvoid: ["万凡被动等消息"],
      },
    });

    expect(report.blockingIssues.length).toBeGreaterThan(0);
    expect(report.dimensions.contractSatisfaction).toBeLessThan(10);
  });
});
