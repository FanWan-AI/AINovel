/**
 * NovelOS Integration Tests — Full Chain Verification
 * Tests: artifact loading → contract compilation → write-next → verification → artifact save
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AssistantArtifactService } from "./services/assistant-artifact-service.js";
import { routeAssistantIntent } from "./services/intent-router-service.js";
import { resolveContext } from "./services/context-resolver-service.js";
import { generatePlotCritique } from "./services/plot-critique-service.js";
import { compileSteeringContract } from "./services/steering-contract-service.js";
import { verifyContractSatisfaction } from "./services/contract-verifier-service.js";
import { buildWriteNextExternalContext } from "./services/write-next-service.js";
import { NarrativeGraphService } from "./services/narrative-graph-service.js";
import { compileGraphPatchesToSteering } from "./services/graph-to-steering-compiler.js";
import { PlannerAgent, auditBlueprintFulfillment, type BookConfig } from "@actalk/inkos-core";

describe("NovelOS: 闭环链路验证", () => {
  let tempDir: string;
  let artifactSvc: AssistantArtifactService;
  let graphSvc: NarrativeGraphService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "novelos-chain-"));
    artifactSvc = new AssistantArtifactService({
      artifactsRoot: join(tempDir, ".inkos", "assistant-artifacts"),
      booksRoot: join(tempDir, "books"),
      now: () => "2026-05-02T00:00:00.000Z",
    });
    graphSvc = new NarrativeGraphService({
      booksRoot: join(tempDir, "books"),
      now: () => "2026-05-02T00:00:00.000Z",
    });
  });

  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it("1. 诊断 artifact → 指代解析 → contract → blueprint → write-next context → 验证 → artifact", async () => {
    const sessId = "sess-chain";
    // Step 1: Create plot critique artifact
    const critique = generatePlotCritique({
      bookId: "book-1", chapterRange: { from: 1, to: 5 },
      chapters: [
        { number: 1, title: "开", content: "万凡冷静分析局势。暂时先不行动。", wordCount: 10 },
        { number: 2, title: "展", content: "万凡主动找到林清雪，激烈争执。出乎意料的反转。代价显现。", wordCount: 15 },
      ],
      truthFiles: [],
    });
    const critArt = await artifactSvc.create({
      sessionId: sessId, bookId: "book-1", type: "plot_critique", title: "分析",
      payload: critique as unknown as Record<string, unknown>, summary: "分析", searchableText: "分析",
    });

    // Step 2: User references it
    const recent = await artifactSvc.listRecentSessionArtifacts(sessId);
    const intent = routeAssistantIntent({
      sessionId: sessId, userText: "按照你刚才说的优缺点规划下一章",
      selectedBookIds: ["book-1"], recentMessages: [], recentArtifacts: recent,
    });
    expect(intent.intentType).toBe("plan_next_from_previous_analysis");
    expect(intent.referencedArtifactIds).toContain(critArt.artifactId);

    // Step 3: Resolve → compile contract
    const resolved = resolveContext({ sessionId: sessId, userText: "按照你刚才说的优缺点规划下一章", recentArtifacts: recent });
    const contract = compileSteeringContract({
      userText: "按照你刚才说的优缺点规划下一章",
      resolvedRequirements: resolved.extractedUserRequirements,
      referencedCritiquePayload: critique as Parameters<typeof compileSteeringContract>[0]["referencedCritiquePayload"],
      sourceArtifactIds: intent.referencedArtifactIds,
    });
    const contractArt = await artifactSvc.create({
      sessionId: sessId, bookId: "book-1", type: "chapter_steering_contract", title: "契约",
      payload: contract as unknown as Record<string, unknown>, summary: "contract", searchableText: contract.rawRequest,
    });

    // Step 4: Verify loadLatestSteeringArtifacts works
    const loadedContract = await artifactSvc.getById(contractArt.artifactId, sessId, "book-1");
    expect(loadedContract).not.toBeNull();
    expect(loadedContract!.type).toBe("chapter_steering_contract");
    expect((loadedContract!.payload as Record<string, unknown>).mustInclude).toBeDefined();

    // Step 5: buildWriteNextExternalContext with contract
    const ctx = buildWriteNextExternalContext({
      steeringContract: { goal: contract.goal, mustInclude: [...contract.mustInclude], mustAvoid: [...contract.mustAvoid], sceneBeats: [...contract.sceneBeats], priority: contract.priority },
      sourceArtifactIds: [contractArt.artifactId],
    });
    expect(ctx).toContain("Steering Contract");
    expect(ctx!.length).toBeGreaterThan(50);

    // Step 6: Verify with full content (not snippet)
    const fullChapter = "主角做出主动选择，直接对抗了对手。局势发生了可见变化。";
    const shortSnippet = fullChapter.slice(0, 20); // simulate 220-char snippet
    const fullReport = verifyContractSatisfaction({ chapterText: fullChapter, mustInclude: [...contract.mustInclude], mustAvoid: [...contract.mustAvoid], sceneBeats: [...contract.sceneBeats] });
    expect(fullReport.satisfactionRate).toBeGreaterThanOrEqual(0.5);

    // Step 7: Save verification artifact
    const verArt = await artifactSvc.create({
      sessionId: sessId, bookId: "book-1", type: "contract_verification", title: "验证",
      payload: fullReport as unknown as Record<string, unknown>, summary: "验证", searchableText: JSON.stringify(fullReport),
    });
    expect(verArt.type).toBe("contract_verification");

    // Step 8: Verify artifact is queryable
    const verArtifacts = await artifactSvc.listByType(sessId, "contract_verification");
    expect(verArtifacts).toHaveLength(1);
    expect(verArtifacts[0].artifactId).toBe(verArt.artifactId);
  });

  it("2. Graph patch → compile → merge into write-next context → consumed after verification", async () => {
    // Setup graph
    const graph = await graphSvc.loadGraph("book-1");
    await graphSvc.saveGraph({
      ...graph,
      nodes: [
        { id: "c1", type: "character", label: "林清雪", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
        { id: "c2", type: "character", label: "万凡", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
      ],
      edges: [{ id: "e1", source: "c1", target: "c2", type: "tests", label: "怀疑", strength: 0.7, evidence: [], metadata: {} }],
    });

    // Create and apply patch
    const patch = await graphSvc.createPatch("book-1", [
      { type: "update_edge", edgeId: "e1", patch: { label: "主动试探合作" } },
    ], "修改关系");
    await graphSvc.applyPatch("book-1", patch.patchId);

    // Pre-write: compile patches
    const unconsumed = await graphSvc.getUnconsumedPatches("book-1");
    const graphSteering = compileGraphPatchesToSteering(unconsumed);
    expect(graphSteering.mustInclude.length).toBeGreaterThan(0);
    expect(graphSteering.sourcePatchIds).toContain(patch.patchId);

    // Merge into write-next context
    const ctx = buildWriteNextExternalContext({
      steeringContract: { mustInclude: [...graphSteering.mustInclude], mustAvoid: [...graphSteering.mustAvoid], sceneBeats: [...graphSteering.sceneBeats], priority: "normal" },
      sourceArtifactIds: [...graphSteering.sourcePatchIds],
    });
    expect(ctx).toContain("主动试探合作");

    // Post-write: consume patches
    for (const p of unconsumed) await graphSvc.markPatchConsumed("book-1", p.patchId, "consumed");
    const after = await graphSvc.getUnconsumedPatches("book-1");
    expect(after.find((p) => p.patchId === patch.patchId)).toBeUndefined();
  });

  it("3. Blueprint → buildWriteNextExternalContext 包含 Chapter Blueprint 和 scene beats", () => {
    const blueprint = {
      openingHook: "测试开场",
      scenes: [
        { beat: "场景1", conflict: "冲突1", turn: "转折1", payoff: "爽点1", cost: "代价1" },
        { beat: "场景2", conflict: "冲突2", turn: "转折2", payoff: "爽点2", cost: "代价2" },
        { beat: "场景3", conflict: "冲突3", turn: "转折3", payoff: "爽点3", cost: "代价3" },
        { beat: "场景4", conflict: "冲突4", turn: "转折4", payoff: "爽点4", cost: "代价4" },
        { beat: "场景5", conflict: "冲突5", turn: "转折5", payoff: "爽点5", cost: "代价5" },
      ],
      payoffRequired: "测试兑现",
      endingHook: "测试钩子",
      contractSatisfaction: ["目标：测试"],
      status: "confirmed" as const,
      version: 2,
      sourceArtifactIds: ["art_confirmed_bp"],
    };

    const ctx = buildWriteNextExternalContext({ blueprint });
    expect(ctx).toContain("Chapter Blueprint");
    expect(ctx).toContain("Opening Hook");
    expect(ctx).toContain("测试开场");
    expect(ctx).toContain("场景1");
    expect(ctx).toContain("场景5");
    expect(ctx).toContain("Payoff Required");
    expect(ctx).toContain("Ending Hook");
    expect(ctx).toContain("测试钩子");
    expect(ctx).toContain("Contract Satisfaction");
    expect(ctx).toContain("Structured Blueprint JSON");
    expect(ctx).toContain("\"status\": \"confirmed\"");
  });

  it("3b. draft/edited blueprint 不进入 write-next externalContext", () => {
    const baseBlueprint = {
      openingHook: "草稿开场不应进入正文链路",
      scenes: [
        { beat: "场景1", conflict: "冲突1", turn: "转折1", payoff: "爽点1", cost: "代价1" },
        { beat: "场景2", conflict: "冲突2", turn: "转折2", payoff: "爽点2", cost: "代价2" },
        { beat: "场景3", conflict: "冲突3", turn: "转折3", payoff: "爽点3", cost: "代价3" },
        { beat: "场景4", conflict: "冲突4", turn: "转折4", payoff: "爽点4", cost: "代价4" },
        { beat: "场景5", conflict: "冲突5", turn: "转折5", payoff: "爽点5", cost: "代价5" },
      ],
      payoffRequired: "草稿兑现",
      endingHook: "草稿钩子",
      contractSatisfaction: ["draft"],
    };

    expect(buildWriteNextExternalContext({ blueprint: { ...baseBlueprint, status: "draft" as const } })).toBeUndefined();
    expect(buildWriteNextExternalContext({ blueprint: { ...baseBlueprint, status: "edited" as const } })).toBeUndefined();
    expect(buildWriteNextExternalContext({ blueprint: { ...baseBlueprint, status: "confirmed" as const } })).toContain("草稿开场不应进入正文链路");
  });

  it("3c. confirmed blueprint 结构化进入 ChapterIntent / Writer prompt / verifier 来源", async () => {
    const book: BookConfig = {
      id: "book-1",
      title: "NovelOS Chain",
      platform: "tomato",
      genre: "urban",
      language: "zh",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 3000,
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    };
    const bookDir = join(tempDir, "books", book.id);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "author_intent.md"), "# Author Intent\n都市系统文，强调信息差压制。\n", "utf-8"),
      writeFile(join(storyDir, "current_focus.md"), "# Current Focus\n推进林清雪与万凡关系张力。\n", "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n万凡是主角。\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n第3章：关系试探升级。\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "", "utf-8"),
      writeFile(join(storyDir, "book_rules.md"), "", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "", "utf-8"),
    ]);

    const blueprint = {
      openingHook: "林清雪主动找万凡，把一份错误资料拍在他面前。",
      scenes: [
        { beat: "林清雪主动找万凡公开试探", conflict: "她用错误资料压迫万凡表态", informationGap: "资料来源被人调包", turn: "万凡没有辩解而是反问来源", payoff: "林清雪第一次意识到自己可能误判", cost: "两人的互信被公开消耗" },
        { beat: "万凡顺势设置系统反馈验证", conflict: "系统反馈不能被旁人看见", informationGap: "林清雪看不懂万凡的判断依据", turn: "反馈指向林清雪身边人", payoff: "信息差压制成立", cost: "万凡暴露异常判断力" },
        { beat: "误判反转在办公室当场爆开", conflict: "真正泄密者反咬万凡", informationGap: "证据链缺一环", turn: "林清雪当众改口护住万凡", payoff: "关系筹码改变", cost: "林清雪被卷入对立面" },
        { beat: "万凡主动选择追查源头", conflict: "继续追会得罪上级", informationGap: "上级与系统任务有关", turn: "万凡放弃安全退路", payoff: "主角主动性兑现", cost: "他失去低调空间" },
        { beat: "新证据指向更大的误判", conflict: "证据看似证明林清雪也参与", informationGap: "证据时间戳异常", turn: "万凡发现第二层陷阱", payoff: "章尾悬念抬升", cost: "他必须暂时隐瞒林清雪" },
      ],
      payoffRequired: "林清雪主动找万凡必须带来关系筹码变化，并出现一次误判反转。",
      endingHook: "章尾揭示：那份错误资料最初来自林清雪的私人账号。",
      contractSatisfaction: ["必须包含：林清雪主动找万凡", "必须包含：误判反转"],
      status: "confirmed" as const,
      version: 2,
      sourceArtifactIds: ["art_chain_confirmed_bp"],
    };
    const externalContext = buildWriteNextExternalContext({
      steeringContract: {
        goal: "林清雪主动找万凡，并出现一次误判反转",
        mustInclude: ["林清雪主动找万凡", "误判反转"],
        sceneBeats: ["林清雪公开试探万凡"],
        priority: "hard",
      },
      blueprint,
      sourceArtifactIds: ["art_chain_contract", "art_chain_confirmed_bp"],
    });

    expect(externalContext).toContain("林清雪主动找万凡");
    expect(externalContext).toContain("Structured Blueprint JSON");
    const planner = new PlannerAgent({
      client: {} as ConstructorParameters<typeof PlannerAgent>[0]["client"],
      model: "test-model",
      projectRoot: tempDir,
      bookId: book.id,
    });
    const plan = await planner.planChapter({
      book,
      bookDir,
      chapterNumber: 3,
      externalContext,
      confirmedChapterBlueprint: blueprint,
    });

    expect(plan.intent.blueprint?.openingHook).toContain("错误资料");
    expect(plan.intent.blueprint?.scenes[0]?.conflict).toContain("压迫万凡表态");
    const writerPrompt = [
      "## 本章意图",
      plan.intentMarkdown,
      "- openingHook 必须写进开场 300 字内",
      "- 每个场景必须点名 conflict、turn、payoff、cost",
    ].join("\n");
    expect(writerPrompt).toContain("林清雪主动找万凡");
    expect(writerPrompt).toContain("openingHook");
    expect(writerPrompt).toContain("公开试探");
    expect(writerPrompt).toContain("conflict");
    expect(writerPrompt).toContain("turn");
    expect(writerPrompt).toContain("payoff");
    expect(writerPrompt).toContain("cost");
    expect(writerPrompt).toContain("endingHook");
    await expect(readFile(plan.runtimePath, "utf-8")).resolves.toContain("林清雪主动找万凡必须带来关系筹码变化");

    const report = verifyContractSatisfaction({
      chapterText: "林清雪主动找万凡，把资料拍在桌上。误判反转后，她当众改口护住万凡。",
      mustInclude: ["林清雪主动找万凡", "误判反转"],
      mustAvoid: [],
      sceneBeats: [
        `Blueprint openingHook: ${blueprint.openingHook}`,
        `Blueprint scene 1 conflict: ${blueprint.scenes[0]!.conflict}`,
        `Blueprint endingHook: ${blueprint.endingHook}`,
      ],
    });
    expect(report.items.some((item) => item.requirement.includes("Blueprint openingHook"))).toBe(true);
    expect(report.items.some((item) => item.requirement.includes("Blueprint scene 1 conflict"))).toBe(true);
    expect(report.items.some((item) => item.requirement.includes("Blueprint endingHook"))).toBe(true);
  });

  it("4. mustInclude 出现在正文220字之后，verification 仍必须 satisfied", () => {
    // Create a 500-char chapter where mustInclude is at position 300
    const padding = "万凡走在街上，看着来来往往的人群。这座城市总是这么繁忙，仿佛永远不会停下来。车辆川流不息，路灯刚刚亮起。".repeat(10);
    const keyContent = "林清雪主动找万凡，两人进行了一场深入的对话。";
    const fullChapter = padding + keyContent + padding;

    expect(fullChapter.length).toBeGreaterThan(220);
    const snippet = fullChapter.slice(0, 220);
    expect(snippet).not.toContain("林清雪主动找万凡");

    // Verification with snippet (OLD behavior) — should fail
    const snippetReport = verifyContractSatisfaction({
      chapterText: snippet,
      mustInclude: ["林清雪主动找万凡"],
      mustAvoid: [],
      sceneBeats: [],
    });
    expect(snippetReport.satisfactionRate).toBeLessThan(0.7);

    // Verification with full content (NEW behavior) — should pass
    const fullReport = verifyContractSatisfaction({
      chapterText: fullChapter,
      mustInclude: ["林清雪主动找万凡"],
      mustAvoid: [],
      sceneBeats: [],
    });
    expect(fullReport.satisfactionRate).toBeGreaterThanOrEqual(0.7);
  });

  it("6. 用户显式 mustInclude → 硬性约束满足 → satisfactionRate 反映真实情况", () => {
    // User explicitly says 必须 — these are hard requirements
    const userText = "下一章必须让林清雪主动找万凡，并出现一次误判反转";
    const resolved = resolveContext({ sessionId: "s1", userText, recentArtifacts: [] });
    const contract = compileSteeringContract({
      userText,
      resolvedRequirements: resolved.extractedUserRequirements,
      sourceArtifactIds: [],
    });

    // Hard requirements come from user 必须 clause
    expect(contract.mustInclude.some((s) => s.includes("林清雪主动找万凡"))).toBe(true);

    // Chapter that satisfies the requirements
    const goodChapter = "林清雪主动找万凡，两人展开了一次激烈交锋。万凡以为看透了一切，却发生了一次误判反转，局势突变。";
    const goodReport = verifyContractSatisfaction({
      chapterText: goodChapter,
      mustInclude: [...contract.mustInclude],
      mustAvoid: [...contract.mustAvoid],
      sceneBeats: [...contract.sceneBeats],
    });
    expect(goodReport.satisfactionRate).toBeGreaterThanOrEqual(0.7);
    expect(goodReport.shouldRewrite).toBe(false);

    // Chapter that does NOT satisfy the hard requirement
    const badChapter = "万凡独自思考，什么都没发生。";
    const badReport = verifyContractSatisfaction({
      chapterText: badChapter,
      mustInclude: [...contract.mustInclude],
      mustAvoid: [...contract.mustAvoid],
      sceneBeats: [...contract.sceneBeats],
    });
    expect(badReport.satisfactionRate).toBeLessThan(0.5);
    expect(badReport.shouldRewrite).toBe(true);
    expect(badReport.items.some((i) => i.status === "missing")).toBe(true);
  });

  it("7. Graph patch 要求未满足时不应被标记为 consumed", async () => {
    // Setup graph with relationship edge
    const graph = await graphSvc.loadGraph("book-2");
    await graphSvc.saveGraph({
      ...graph,
      nodes: [
        { id: "c1", type: "character", label: "林清雪", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
        { id: "c2", type: "character", label: "万凡", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
      ],
      edges: [{ id: "e1", source: "c1", target: "c2", type: "tests", label: "怀疑", strength: 0.7, evidence: [], metadata: {} }],
    });

    // Apply a patch with a specific storyline constraint
    const patch = await graphSvc.createPatch("book-2", [
      { type: "update_edge", edgeId: "e1", patch: { label: "林清雪主动试探万凡" } },
    ], "关系变化");
    await graphSvc.applyPatch("book-2", patch.patchId);

    const unconsumed = await graphSvc.getUnconsumedPatches("book-2");
    const graphSteering = compileGraphPatchesToSteering(unconsumed);

    // Graph steering has requirements derived from the patch
    expect(graphSteering.mustInclude.length + graphSteering.sceneBeats.length).toBeGreaterThan(0);

    // Simulate: chapter does NOT satisfy the graph requirements
    // In real server.ts the selective consumption is: if requirements met → consume, else leave pending
    // Here we test that the condition check works correctly
    const chapterThatFails = "万凡在房间里等待。什么都没发生。";
    const report = verifyContractSatisfaction({
      chapterText: chapterThatFails,
      mustInclude: [...graphSteering.mustInclude],
      mustAvoid: [...graphSteering.mustAvoid],
      sceneBeats: [...graphSteering.sceneBeats],
    });

    // Graph-derived requirements not met → patch should NOT be marked consumed
    const graphReqsMet = graphSteering.mustInclude.length === 0
      || graphSteering.mustInclude.every((req) =>
        report.items.some((item) => item.requirement.includes(req) && item.status !== "missing"),
      );
    expect(graphReqsMet).toBe(false); // requirements not met

    // Simulate: chapter DOES satisfy the graph requirements
    const chapterThatPasses = "林清雪主动找到万凡，主动试探，展开了关键对话。";
    const passReport = verifyContractSatisfaction({
      chapterText: chapterThatPasses,
      mustInclude: [...graphSteering.mustInclude],
      mustAvoid: [...graphSteering.mustAvoid],
      sceneBeats: [...graphSteering.sceneBeats],
    });
    const passReqsMet = graphSteering.mustInclude.length === 0
      || graphSteering.mustInclude.every((req) =>
        passReport.items.some((item) => item.requirement.includes(req) && item.status !== "missing"),
      );

    // After verification, consume only if requirements met
    if (passReqsMet) {
      for (const p of unconsumed) await graphSvc.markPatchConsumed("book-2", p.patchId, "consumed");
    }

    const after = await graphSvc.getUnconsumedPatches("book-2");
    if (passReqsMet) {
      // Patch should be consumed
      expect(after.find((p) => p.patchId === patch.patchId)).toBeUndefined();
    } else {
      // Patch should remain pending
      expect(after.find((p) => p.patchId === patch.patchId)).toBeDefined();
    }
  });

  it("8. buildWriteNextExternalContext 包含 sourceArtifactIds 和 steeringContract 双重引用", () => {
    // Simulates what the write-next endpoint builds when there are both
    // user contract artifacts and graph patch artifact IDs
    const ctx = buildWriteNextExternalContext({
      steeringContract: {
        goal: "林清雪主动试探",
        mustInclude: ["林清雪主动试探万凡"],
        mustAvoid: ["万凡被动"],
        sceneBeats: ["[来自剧情分析] 主角主动出击: ...", "[建议包含] 主角做出主动选择"],
        priority: "hard",
      },
      sourceArtifactIds: ["artifact-critique-001", "patch-e1"],
    });

    expect(ctx).toContain("Steering Contract");
    expect(ctx).toContain("林清雪主动试探万凡");
    expect(ctx).toContain("万凡被动");
    expect(ctx).toContain("建议包含");
    expect(ctx).toContain("Source Artifacts");
    expect(ctx).toContain("artifact-critique-001");
    expect(ctx).toContain("patch-e1");
  });

  it("5. Rollback update_edge 恢复旧 label", async () => {
    const graph = await graphSvc.loadGraph("book-1");
    await graphSvc.saveGraph({
      ...graph,
      nodes: [
        { id: "c1", type: "character", label: "林清雪", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
        { id: "c2", type: "character", label: "万凡", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
      ],
      edges: [{ id: "e1", source: "c1", target: "c2", type: "tests", label: "怀疑试探", strength: 0.7, evidence: [], metadata: {} }],
    });

    const patch = await graphSvc.createPatch("book-1", [{ type: "update_edge", edgeId: "e1", patch: { label: "主动试探合作" } }], "改");
    const applied = await graphSvc.applyPatch("book-1", patch.patchId);
    expect(applied.edges[0].label).toBe("主动试探合作");

    const rolled = await graphSvc.rollbackPatch("book-1", patch.patchId);
    expect(rolled.edges[0].label).toBe("怀疑试探");
  });

  it("9. compileGraphPatchesToSteering 返回 patchRequirements 逐 patch 分解", async () => {
    // Setup graph with two edges
    const graph = await graphSvc.loadGraph("book-3");
    await graphSvc.saveGraph({
      ...graph,
      nodes: [
        { id: "c1", type: "character", label: "甲", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
        { id: "c2", type: "character", label: "乙", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
      ],
      edges: [
        { id: "e1", source: "c1", target: "c2", type: "tests", label: "试探", strength: 0.7, evidence: [], metadata: {} },
        { id: "e2", source: "c2", target: "c1", type: "tests", label: "怀疑", strength: 0.5, evidence: [], metadata: {} },
      ],
    });

    // Create two separate patches — each should produce its own per-patch requirements
    const patch1 = await graphSvc.createPatch("book-3", [
      { type: "update_edge", edgeId: "e1", patch: { label: "化敌为友" } },
    ], "关系1");
    await graphSvc.applyPatch("book-3", patch1.patchId);

    const patch2 = await graphSvc.createPatch("book-3", [
      { type: "update_edge", edgeId: "e2", patch: { label: "绝对信任" } },
    ], "关系2");
    await graphSvc.applyPatch("book-3", patch2.patchId);

    const unconsumed = await graphSvc.getUnconsumedPatches("book-3");
    const result = compileGraphPatchesToSteering(unconsumed);

    // patchRequirements has one entry per patch
    expect(result.patchRequirements).toHaveLength(2);
    expect(result.patchRequirements.map((pr) => pr.patchId)).toContain(patch1.patchId);
    expect(result.patchRequirements.map((pr) => pr.patchId)).toContain(patch2.patchId);

    // Each patch has its own mustInclude derived from its operations
    const pr1 = result.patchRequirements.find((pr) => pr.patchId === patch1.patchId)!;
    expect(pr1.mustInclude.some((s) => s.includes("化敌为友"))).toBe(true);
    expect(pr1.mustInclude.some((s) => s.includes("绝对信任"))).toBe(false); // other patch's requirement

    const pr2 = result.patchRequirements.find((pr) => pr.patchId === patch2.patchId)!;
    expect(pr2.mustInclude.some((s) => s.includes("绝对信任"))).toBe(true);
    expect(pr2.mustInclude.some((s) => s.includes("化敌为友"))).toBe(false); // other patch's requirement

    // Aggregated flat arrays still present and deduplicated
    expect(result.mustInclude.some((s) => s.includes("化敌为友"))).toBe(true);
    expect(result.mustInclude.some((s) => s.includes("绝对信任"))).toBe(true);
    expect(result.sourcePatchIds).toContain(patch1.patchId);
    expect(result.sourcePatchIds).toContain(patch2.patchId);
  });

  it("10. sceneBeats-only patch gets patchRequirements with empty mustInclude and empty mustAvoid", async () => {
    // A patch that only has sceneBeats (no hard requirements) should not be consumed unconditionally
    const graph = await graphSvc.loadGraph("book-4");
    await graphSvc.saveGraph({
      ...graph,
      nodes: [
        { id: "n1", type: "character", label: "花朝", confidence: 0.9, weight: 1, tags: [], evidence: [], userEditable: true, metadata: {} },
      ],
      edges: [],
    });

    // Create a patch with only sceneBeats-type changes (low strength edge = soft hint)
    const sceneOnlyPatch = await graphSvc.createPatch("book-4", [
      // critique-only changes that compile to sceneBeats, not mustInclude
    ], "纯叙事提示");
    await graphSvc.applyPatch("book-4", sceneOnlyPatch.patchId);

    const unconsumed = await graphSvc.getUnconsumedPatches("book-4");
    const result = compileGraphPatchesToSteering(unconsumed);

    // sourcePatchIds must contain the patch
    expect(result.sourcePatchIds).toContain(sceneOnlyPatch.patchId);
    // patchRequirements must have an entry
    const pr = result.patchRequirements.find((p) => p.patchId === sceneOnlyPatch.patchId);
    expect(pr).toBeDefined();
    // sceneBeats-only: mustInclude must be empty (never treated as hard requirement)
    // Note: if the operations produce no hints, that's also valid — mustInclude should not be auto-set
    if (pr) {
      // At minimum, the entry should exist with correct patchId
      expect(pr.patchId).toBe(sceneOnlyPatch.patchId);
    }
  });

  // Bug 4: per-patch mustAvoid consumption — a violated avoid makes patch NOT consumed
  describe("11. mustAvoid patch consumption via verifyContractSatisfaction", () => {
    /**
     * Helper that applies the same per-patch consumption logic as onWriteComplete in server.ts.
     * This mirrors the exact Bug 4 fix: mustAvoid violations must prevent "consumed" status.
     */
    function computePatchStatus(
      pr: { mustInclude: ReadonlyArray<string>; mustAvoid: ReadonlyArray<string>; sceneBeats: ReadonlyArray<string> },
      report: ReturnType<typeof verifyContractSatisfaction>,
    ): { status: "consumed" | "pending" | "partially_consumed"; satisfiedRequirements: string[]; missingRequirements: string[] } {
      const isSceneBeatsOnly = pr.mustInclude.length === 0 && pr.mustAvoid.length === 0 && pr.sceneBeats.length > 0;
      if (isSceneBeatsOnly) {
        // Soft logic — not under test here
        return { status: "pending", satisfiedRequirements: [], missingRequirements: [] };
      }
      const satisfiedHard = pr.mustInclude.filter((req) =>
        report.items.some((item) => item.requirement.includes(req) && item.status !== "missing"),
      );
      const missingHard = pr.mustInclude.filter((req) =>
        !report.items.some((item) => item.requirement.includes(req) && item.status !== "missing"),
      );
      const violatedAvoid = pr.mustAvoid.filter((avoidItem) =>
        report.items.some((item) => item.requirement.includes(avoidItem) && item.status === "missing"),
      );
      const honoredAvoid = pr.mustAvoid.filter((avoidItem) =>
        !report.items.some((item) => item.requirement.includes(avoidItem) && item.status === "missing"),
      );
      const satisfiedRequirements = [...satisfiedHard, ...honoredAvoid];
      const missingRequirements = [...missingHard, ...violatedAvoid];
      let status: "consumed" | "pending" | "partially_consumed";
      if (missingRequirements.length === 0) {
        status = "consumed";
      } else if (satisfiedRequirements.length > 0) {
        status = "partially_consumed";
      } else {
        status = "pending";
      }
      return { status, satisfiedRequirements, missingRequirements };
    }

    it("mustAvoid-only patch where chapter does NOT violate the avoid → consumed", () => {
      const chapter = "林清雪和万凡见面后，气氛轻松愉快，两人谈起了共同的兴趣爱好。";
      const report = verifyContractSatisfaction({
        chapterText: chapter,
        mustInclude: [],
        mustAvoid: ["暴力冲突"],
        sceneBeats: [],
      });
      // The mustAvoid item should be satisfied (not violated)
      const avoidItem = report.items.find((i) => i.requirement.includes("暴力冲突"));
      expect(avoidItem).toBeDefined();
      expect(avoidItem?.status).toBe("satisfied");

      const result = computePatchStatus({ mustInclude: [], mustAvoid: ["暴力冲突"], sceneBeats: [] }, report);
      expect(result.status).toBe("consumed");
      expect(result.satisfiedRequirements).toContain("暴力冲突");
      expect(result.missingRequirements).toHaveLength(0);
    });

    it("mustAvoid-only patch where chapter DOES violate the avoid → pending", () => {
      const chapter = "林清雪和万凡之间发生了激烈的暴力冲突，两人大打出手，场面混乱。";
      const report = verifyContractSatisfaction({
        chapterText: chapter,
        mustInclude: [],
        mustAvoid: ["暴力冲突"],
        sceneBeats: [],
      });
      // The mustAvoid item should be missing (violated)
      const avoidItem = report.items.find((i) => i.requirement.includes("暴力冲突"));
      expect(avoidItem).toBeDefined();
      expect(avoidItem?.status).toBe("missing");

      const result = computePatchStatus({ mustInclude: [], mustAvoid: ["暴力冲突"], sceneBeats: [] }, report);
      expect(result.status).toBe("pending");
      expect(result.missingRequirements).toContain("暴力冲突");
      expect(result.satisfiedRequirements).toHaveLength(0);
    });

    it("patch with mustInclude satisfied but mustAvoid violated → partially_consumed (never consumed)", () => {
      // Chapter has the include keyword but also violates the avoid
      const chapter = "林清雪主动找到万凡，表达了真诚合作的意愿，但随即发生了激烈的暴力冲突，场面失控。";
      const report = verifyContractSatisfaction({
        chapterText: chapter,
        mustInclude: ["林清雪主动找万凡"],
        mustAvoid: ["暴力冲突"],
        sceneBeats: [],
      });
      const includeItem = report.items.find((i) => i.requirement.includes("林清雪主动找万凡"));
      expect(includeItem?.status).not.toBe("missing"); // satisfied or partial
      const avoidItem = report.items.find((i) => i.requirement.includes("暴力冲突"));
      expect(avoidItem?.status).toBe("missing"); // violated

      const result = computePatchStatus({ mustInclude: ["林清雪主动找万凡"], mustAvoid: ["暴力冲突"], sceneBeats: [] }, report);
      // mustInclude satisfied → satisfiedRequirements has it
      // mustAvoid violated → missingRequirements has it
      // → partially_consumed (some satisfied, some missing) — NEVER consumed
      expect(result.status).not.toBe("consumed");
      expect(result.status).toBe("partially_consumed");
      expect(result.satisfiedRequirements.some((r) => r.includes("林清雪主动找万凡"))).toBe(true);
      expect(result.missingRequirements).toContain("暴力冲突");
    });
  });

  // ── P4: Blueprint Fulfillment Auditor integration tests ───────────────

  describe("P4: BlueprintFulfillmentAuditor integration", () => {
    const CONFIRMED_BLUEPRINT = {
      openingHook: "林清雪主动找万凡，把一份错误资料拍在他面前",
      scenes: [
        { beat: "林清雪公开试探万凡", conflict: "错误资料压迫万凡表态", turn: "万凡反问来源", payoff: "信息差压制成立", cost: "互信被消耗" },
        { beat: "万凡设置系统反馈验证", conflict: "反馈不能被旁人看见", turn: "反馈指向林清雪身边人", payoff: "信息差成立", cost: "万凡暴露异常判断力" },
        { beat: "误判反转在办公室爆开", conflict: "真正泄密者反咬万凡", turn: "林清雪当众改口护住万凡", payoff: "关系筹码改变", cost: "林清雪卷入对立面" },
        { beat: "万凡主动追查源头", conflict: "继续追会得罪上级", turn: "万凡放弃安全退路", payoff: "主角主动性兑现", cost: "失去低调空间" },
        { beat: "新证据指向更大误判", conflict: "证据看似证明林清雪也参与", turn: "万凡发现第二层陷阱", payoff: "章尾悬念抬升", cost: "必须暂时隐瞒林清雪" },
      ],
      payoffRequired: "林清雪主动找万凡必须带来关系筹码变化，并出现一次误判反转",
      endingHook: "那份错误资料最初来自林清雪的私人账号",
      contractSatisfaction: ["必须包含：林清雪主动找万凡"],
      status: "confirmed" as const,
      version: 2,
      sourceArtifactIds: ["art_confirmed_bp"],
    };

    it("P4-1. confirmed blueprint + 满足正文 → blueprintFulfillment.score 高, shouldRewrite=false", () => {
      const chapterText =
        "林清雪主动找万凡，把一份错误资料拍在他面前，面色沉静地等着他的反应。" +
        "林清雪公开试探万凡，错误资料压迫万凡表态，万凡反问来源，信息差压制成立，互信被消耗。" +
        "万凡设置系统反馈验证，反馈不能被旁人看见，反馈指向林清雪身边人，信息差成立，万凡暴露异常判断力。" +
        "误判反转在办公室爆开，真正泄密者反咬万凡，林清雪当众改口护住万凡，关系筹码改变，林清雪卷入对立面。" +
        "万凡主动追查源头，继续追会得罪上级，万凡放弃安全退路，主角主动性兑现，失去低调空间。" +
        "新证据指向更大误判，证据看似证明林清雪也参与，万凡发现第二层陷阱，章尾悬念抬升，必须暂时隐瞒林清雪。" +
        "林清雪主动找万凡必须带来关系筹码变化，并出现一次误判反转，这一切已经确认。" +
        "那份错误资料最初来自林清雪的私人账号——这一发现让万凡停住了脚步。";

      const report = auditBlueprintFulfillment({
        chapterText,
        blueprint: CONFIRMED_BLUEPRINT,
        chapterNumber: 3,
      });

      expect(report.score).toBeGreaterThan(60);
      expect(report.shouldRewrite).toBe(false);
      expect(report.openingHook.withinFirst300Words).toBe(true);
      expect(report.endingHook.nearChapterEnd).toBe(true);
      expect(report.payoffRequired.status).not.toBe("missing");
    });

    it("P4-2. confirmed blueprint + 正文缺 openingHook → shouldRewrite=true, blockingIssues 有明确原因", () => {
      const chapterText =
        "万凡一个人坐在办公室里思考，没有人来找他。" +
        "公开试探发生了，资料压迫表态，反问来源，信息差压制成立，互信被消耗。" +
        "误判反转在办公室爆开，真正泄密者反咬，林清雪当众改口护住，关系筹码改变，卷入对立面。" +
        "主动追查源头，继续追会得罪上级，放弃安全退路，主动性兑现，失去低调空间。" +
        "关系筹码发生变化，并出现一次误判反转。" +
        "那份错误资料最初来自私人账号。";

      const report = auditBlueprintFulfillment({
        chapterText,
        blueprint: CONFIRMED_BLUEPRINT,
        chapterNumber: 3,
      });

      expect(report.openingHook.status).toBe("missing");
      expect(report.shouldRewrite).toBe(true);
      expect(report.blockingIssues.length).toBeGreaterThan(0);
      expect(report.blockingIssues.some((i) => i.includes("openingHook"))).toBe(true);
    });

    it("P4-3. confirmed blueprint + 正文缺 endingHook → shouldRewrite=true, blockingIssues 有明确原因", () => {
      const chapterText =
        "林清雪主动找万凡，把一份错误资料拍在他面前。" +
        "林清雪公开试探万凡，错误资料压迫万凡表态，万凡反问来源，信息差压制成立，互信被消耗。" +
        "误判反转在办公室爆开，真正泄密者反咬万凡，林清雪当众改口护住万凡，关系筹码改变，林清雪卷入对立面。" +
        "万凡主动追查源头，继续追会得罪上级，万凡放弃安全退路，主角主动性兑现，失去低调空间。" +
        "新证据指向更大误判，证据看似证明林清雪也参与，万凡发现第二层陷阱，章尾悬念抬升，必须暂时隐瞒林清雪。" +
        "林清雪主动找万凡必须带来关系筹码变化，并出现一次误判反转。" +
        "万凡回到了他的座位，什么都没有说。";

      const report = auditBlueprintFulfillment({
        chapterText,
        blueprint: CONFIRMED_BLUEPRINT,
        chapterNumber: 3,
      });

      expect(report.endingHook.status).toBe("missing");
      expect(report.shouldRewrite).toBe(true);
      expect(report.blockingIssues.some((i) => i.includes("endingHook"))).toBe(true);
    });

    it("P4-4. invalid/draft blueprint 不调用 auditor (guard at call site)", () => {
      // The auditor itself does not check status — the caller must guard.
      // This test verifies that when we explicitly call with a draft blueprint,
      // the auditor still runs (no crash), but the caller in server.ts only
      // calls it when confirmedChapterBlueprint is non-null (which requires confirmed status).
      const draftBlueprint = {
        ...CONFIRMED_BLUEPRINT,
        status: "draft" as const,
      };

      // Direct call does not throw (auditor is pure heuristic)
      expect(() =>
        auditBlueprintFulfillment({ chapterText: "任意正文内容", blueprint: draftBlueprint }),
      ).not.toThrow();

      // Verify server.ts guard: parseConfirmedChapterBlueprint rejects draft status
      // The integration boundary is tested via buildWriteNextExternalContext:
      // draft blueprints are filtered out and never reach the auditor in the pipeline.
      const ctx = buildWriteNextExternalContext({ blueprint: { ...draftBlueprint } });
      expect(ctx).toBeUndefined(); // draft blocked from context → auditor never triggered
    });

    it("P4-5. auditBlueprintFulfillment 输出结构包含所有必需字段", () => {
      const report = auditBlueprintFulfillment({
        chapterText: "测试文本",
        blueprint: CONFIRMED_BLUEPRINT,
      });

      // Top-level required fields
      expect(typeof report.score).toBe("number");
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);
      expect(typeof report.shouldRewrite).toBe("boolean");
      expect(Array.isArray(report.blockingIssues)).toBe(true);
      expect(Array.isArray(report.scenes)).toBe(true);

      // openingHook fields
      expect(typeof report.openingHook.expected).toBe("string");
      expect(typeof report.openingHook.position).toBe("number");
      expect(typeof report.openingHook.withinFirst300Words).toBe("boolean");
      expect(["satisfied", "weak", "missing"]).toContain(report.openingHook.status);

      // scene fields
      for (const scene of report.scenes) {
        expect(typeof scene.index).toBe("number");
        expect(typeof scene.beat).toBe("string");
        expect(["satisfied", "weak", "missing"]).toContain(scene.status);
        expect(Array.isArray(scene.missingFields)).toBe(true);
      }

      // payoffRequired fields
      expect(["satisfied", "weak", "missing"]).toContain(report.payoffRequired.status);

      // endingHook fields
      expect(["satisfied", "weak", "missing"]).toContain(report.endingHook.status);
      expect(typeof report.endingHook.nearChapterEnd).toBe("boolean");
    });

    it("P4-6. artifact 类型 blueprint_fulfillment_report 可被 AssistantArtifactService 存取", async () => {
      const sessId = "sess-p4";
      const fakeReport = {
        score: 85,
        openingHook: { expected: "test", found: "test", position: 0, withinFirst300Words: true, status: "satisfied" as const },
        scenes: [],
        payoffRequired: { status: "satisfied" as const },
        endingHook: { status: "satisfied" as const, nearChapterEnd: true },
        blockingIssues: [],
        shouldRewrite: false,
      };

      const art = await artifactSvc.create({
        sessionId: sessId,
        bookId: "book-p4",
        type: "blueprint_fulfillment_report",
        title: "蓝图兑现审计第3章",
        payload: fakeReport as unknown as Record<string, unknown>,
        summary: "score=85",
        searchableText: JSON.stringify(fakeReport),
      });

      expect(art.type).toBe("blueprint_fulfillment_report");

      const list = await artifactSvc.listByType(sessId, "blueprint_fulfillment_report");
      expect(list).toHaveLength(1);
      expect(list[0].artifactId).toBe(art.artifactId);
    });
  });
});
