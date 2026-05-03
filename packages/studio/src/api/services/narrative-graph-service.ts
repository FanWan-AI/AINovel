/**
 * Narrative Graph Service — manages graph snapshots, patches, impact analysis,
 * and patch lifecycle (draft → impact_analyzed → approved → applied → consumed).
 *
 * Robust implementation: handles missing edges/nodes, proper inverse rollback,
 * and generates meaningful steering hints from operations.
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  NarrativeGraph,
  NarrativeGraphNode,
  NarrativeGraphEdge,
  NarrativeGraphPatch,
  NarrativeGraphPatchStatus,
  NarrativeGraphOperation,
  NarrativeGraphImpactAnalysis,
} from "../schemas/narrative-graph-schema.js";

// ── Helpers ────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const hex = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${prefix}_${hex}`;
}

// ── Inverse operations for rollback ────────────────────────────────────

function inverseOperation(
  graph: NarrativeGraph,
  op: NarrativeGraphOperation,
): NarrativeGraphOperation | null {
  switch (op.type) {
    case "add_node":
      return { type: "remove_node", nodeId: op.node.id };
    case "remove_node": {
      const node = graph.nodes.find((n) => n.id === op.nodeId);
      return node ? { type: "add_node", node } : null;
    }
    case "update_node": {
      const node = graph.nodes.find((n) => n.id === op.nodeId);
      if (!node) return null;
      // Build inverse: restore original fields from current graph state
      const originalFields: Partial<NarrativeGraphNode> = {};
      for (const key of Object.keys(op.patch) as (keyof NarrativeGraphNode)[]) {
        (originalFields as Record<string, unknown>)[key] = node[key];
      }
      return { type: "update_node", nodeId: op.nodeId, patch: originalFields };
    }
    case "add_edge":
      return { type: "remove_edge", edgeId: op.edge.id };
    case "remove_edge": {
      const edge = graph.edges.find((e) => e.id === op.edgeId);
      return edge ? { type: "add_edge", edge } : null;
    }
    case "update_edge": {
      const edge = graph.edges.find((e) => e.id === op.edgeId);
      if (!edge) return null;
      const originalFields: Partial<NarrativeGraphEdge> = {};
      for (const key of Object.keys(op.patch) as (keyof NarrativeGraphEdge)[]) {
        (originalFields as Record<string, unknown>)[key] = edge[key];
      }
      return { type: "update_edge", edgeId: op.edgeId, patch: originalFields };
    }
  }
}

// ── Impact Analysis Engine ─────────────────────────────────────────────

const HIGH_RISK_EDGE_TYPES = new Set(["betrays", "contradicts", "hides"]);
const RELATIONSHIP_EDGE_TYPES = new Set(["loves", "hates", "tests", "misjudges", "betrays", "helps", "blocks", "protects", "owes"]);

function analyzeImpact(
  graph: NarrativeGraph,
  operations: ReadonlyArray<NarrativeGraphOperation>,
): NarrativeGraphImpactAnalysis {
  const affectedCharacters = new Set<string>();
  const affectedHooks = new Set<string>();
  const affectedRules = new Set<string>();
  const affectedChapters = new Set<number>();
  const contradictions: Array<{ description: string; evidence: string; severity: "low" | "medium" | "high" }> = [];
  const mustInclude: string[] = [];
  const mustAvoid: string[] = [];
  const sceneBeats: string[] = [];

  let maxRisk: "low" | "medium" | "high" | "critical" = "low";

  function escalateRisk(level: "low" | "medium" | "high" | "critical") {
    const order = ["low", "medium", "high", "critical"] as const;
    if (order.indexOf(level) > order.indexOf(maxRisk)) maxRisk = level;
  }

  function resolveNode(nodeId: string): NarrativeGraphNode | undefined {
    return graph.nodes.find((n) => n.id === nodeId);
  }

  function resolveEdge(edgeId: string): NarrativeGraphEdge | undefined {
    return graph.edges.find((e) => e.id === edgeId);
  }

  for (const op of operations) {
    switch (op.type) {
      case "add_node": {
        if (op.node.type === "character") {
          affectedCharacters.add(op.node.label);
          mustInclude.push(`新人物${op.node.label}登场或被提及`);
          escalateRisk("medium");
        }
        if (op.node.type === "hook") {
          affectedHooks.add(op.node.label);
          sceneBeats.push(`引入新悬念：${op.node.label}`);
        }
        if (op.node.type === "conflict") {
          mustInclude.push(`新冲突：${op.node.label}`);
          sceneBeats.push(`冲突${op.node.label}需要在后续章节展开`);
          escalateRisk("medium");
        }
        if (op.node.type === "rule") {
          affectedRules.add(op.node.label);
          escalateRisk("high");
        }
        break;
      }

      case "update_node": {
        const node = resolveNode(op.nodeId);
        const label = node?.label ?? op.nodeId;
        if (node?.type === "character" || op.patch.label) {
          affectedCharacters.add(label);
          mustInclude.push(`人物${label}状态更新`);
        }
        if (node?.type === "hook") {
          affectedHooks.add(label);
        }
        escalateRisk("medium");
        break;
      }

      case "remove_node": {
        const node = resolveNode(op.nodeId);
        if (node?.type === "rule") {
          affectedRules.add(node.label);
          contradictions.push({
            description: `删除规则「${node.label}」可能导致故事设定矛盾`,
            evidence: `规则 ${node.label} 被移除`,
            severity: "high",
          });
          escalateRisk("critical");
        }
        if (node?.type === "character") {
          affectedCharacters.add(node.label);
          escalateRisk("high");
        }
        break;
      }

      case "add_edge": {
        const srcNode = resolveNode(op.edge.source);
        const tgtNode = resolveNode(op.edge.target);
        const srcLabel = srcNode?.label ?? op.edge.source;
        const tgtLabel = tgtNode?.label ?? op.edge.target;

        if (op.edge.type === "foreshadows") {
          affectedHooks.add(op.edge.label);
          mustInclude.push(`伏笔铺设：${op.edge.label}`);
          sceneBeats.push(`暗示${op.edge.label}的伏笔线索`);
        }
        if (RELATIONSHIP_EDGE_TYPES.has(op.edge.type)) {
          if (srcNode?.type === "character") affectedCharacters.add(srcLabel);
          if (tgtNode?.type === "character") affectedCharacters.add(tgtLabel);
          mustInclude.push(`${srcLabel}与${tgtLabel}的${op.edge.label}关系需要体现`);
          sceneBeats.push(`${srcLabel}对${tgtLabel}展现${op.edge.label}态度`);
        }
        if (HIGH_RISK_EDGE_TYPES.has(op.edge.type)) {
          escalateRisk("high");
          contradictions.push({
            description: `新增${op.edge.type}边「${op.edge.label}」可能与现有剧情矛盾`,
            evidence: `${srcLabel} → ${tgtLabel}: ${op.edge.label}`,
            severity: "high",
          });
        }
        break;
      }

      case "update_edge": {
        // Resolve from graph first, then from operation patch
        const edge = resolveEdge(op.edgeId);
        const newLabel = typeof op.patch.label === "string" ? op.patch.label : edge?.label ?? op.edgeId;
        const edgeType = edge?.type ?? "relationship";

        if (edge) {
          const srcNode = resolveNode(edge.source);
          const tgtNode = resolveNode(edge.target);
          const srcLabel = srcNode?.label ?? edge.source;
          const tgtLabel = tgtNode?.label ?? edge.target;

          if (srcNode?.type === "character") affectedCharacters.add(srcLabel);
          if (tgtNode?.type === "character") affectedCharacters.add(tgtLabel);

          if (RELATIONSHIP_EDGE_TYPES.has(edgeType)) {
            mustInclude.push(`${srcLabel}与${tgtLabel}关系变化为「${newLabel}」`);
            sceneBeats.push(`${srcLabel}对${tgtLabel}展现${newLabel}态度`);
            mustAvoid.push(`${srcLabel}对${tgtLabel}维持旧关系`);
          }
        } else {
          // Edge not in graph — use operation data directly
          mustInclude.push(`关系边更新为「${newLabel}」需在下一章体现`);
          sceneBeats.push(`体现关系变化：${newLabel}`);
        }

        escalateRisk("medium");
        break;
      }

      case "remove_edge": {
        const edge = resolveEdge(op.edgeId);
        if (edge) {
          const srcNode = resolveNode(edge.source);
          const tgtNode = resolveNode(edge.target);
          if (srcNode?.type === "character") affectedCharacters.add(srcNode.label);
          if (tgtNode?.type === "character") affectedCharacters.add(tgtNode.label);
          if (edge.type === "foreshadows") {
            mustAvoid.push(`兑现已被删除的伏笔：${edge.label}`);
          }
        }
        escalateRisk("medium");
        break;
      }
    }
  }

  let recommendation: NarrativeGraphImpactAnalysis["recommendation"];
  if (maxRisk === "low") recommendation = "safe_to_apply";
  else if (maxRisk === "medium") recommendation = "apply_with_warning";
  else if (maxRisk === "high") recommendation = "requires_rewrite_plan";
  else recommendation = "reject";

  return {
    riskLevel: maxRisk,
    affectedCharacters: [...affectedCharacters],
    affectedHooks: [...affectedHooks],
    affectedRules: [...affectedRules],
    affectedChapters: [...affectedChapters],
    contradictions,
    requiredStoryPatches: [],
    nextChapterSteeringHints: {
      mustInclude: [...new Set(mustInclude)],
      mustAvoid: [...new Set(mustAvoid)],
      sceneBeats: [...new Set(sceneBeats)],
    },
    recommendation,
  };
}

// ── Apply operations to graph ──────────────────────────────────────────

function applyOperations(
  graph: NarrativeGraph,
  operations: ReadonlyArray<NarrativeGraphOperation>,
): NarrativeGraph {
  let nodes = [...graph.nodes];
  let edges = [...graph.edges];

  for (const op of operations) {
    switch (op.type) {
      case "add_node":
        if (!nodes.some((n) => n.id === op.node.id)) nodes = [...nodes, op.node];
        break;
      case "update_node":
        nodes = nodes.map((n) => n.id === op.nodeId ? { ...n, ...op.patch } as NarrativeGraphNode : n);
        break;
      case "remove_node":
        nodes = nodes.filter((n) => n.id !== op.nodeId);
        edges = edges.filter((e) => e.source !== op.nodeId && e.target !== op.nodeId);
        break;
      case "add_edge":
        if (!edges.some((e) => e.id === op.edge.id)) edges = [...edges, op.edge];
        break;
      case "update_edge":
        edges = edges.map((e) => e.id === op.edgeId ? { ...e, ...op.patch } as NarrativeGraphEdge : e);
        break;
      case "remove_edge":
        edges = edges.filter((e) => e.id !== op.edgeId);
        break;
    }
  }

  return { ...graph, nodes, edges, updatedAt: graph.updatedAt, version: graph.version };
}

// ── Public API ─────────────────────────────────────────────────────────

export interface NarrativeGraphServiceOptions {
  readonly booksRoot: string;
  readonly now?: () => string;
}

export class NarrativeGraphService {
  private readonly booksRoot: string;
  private readonly now: () => string;

  constructor(opts: NarrativeGraphServiceOptions) {
    this.booksRoot = opts.booksRoot;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  private graphPath(bookId: string): string {
    return join(this.booksRoot, bookId, "story", "narrative_graph.json");
  }

  private patchesPath(bookId: string): string {
    return join(this.booksRoot, bookId, "runtime", "narrative_graph_patches.jsonl");
  }

  async loadGraph(bookId: string): Promise<NarrativeGraph> {
    try {
      const raw = await readFile(this.graphPath(bookId), "utf-8");
      return JSON.parse(raw) as NarrativeGraph;
    } catch {
      return { bookId, nodes: [], edges: [], updatedAt: this.now(), version: 0 };
    }
  }

  async saveGraph(graph: NarrativeGraph): Promise<void> {
    const dir = join(this.booksRoot, graph.bookId, "story");
    await mkdir(dir, { recursive: true });
    await writeFile(this.graphPath(graph.bookId), JSON.stringify(graph, null, 2), "utf-8");
  }

  async createPatch(
    bookId: string,
    operations: ReadonlyArray<NarrativeGraphOperation>,
    reason: string,
    createdBy: "user" | "assistant" = "user",
  ): Promise<NarrativeGraphPatch> {
    const graph = await this.loadGraph(bookId);
    const impact = analyzeImpact(graph, operations);

    const patch: NarrativeGraphPatch = {
      patchId: generateId("patch"),
      bookId,
      createdAt: this.now(),
      createdBy,
      status: "impact_analyzed",
      reason,
      operations: [...operations],
      impactAnalysis: impact,
    };

    const patchesDir = join(this.booksRoot, bookId, "runtime");
    await mkdir(patchesDir, { recursive: true });
    await appendFile(this.patchesPath(bookId), JSON.stringify(patch) + "\n", "utf-8");
    return patch;
  }

  async applyPatch(bookId: string, patchId: string): Promise<NarrativeGraph> {
    const graph = await this.loadGraph(bookId);
    const patches = await this.listPatches(bookId);
    const patch = patches.find((p) => p.patchId === patchId);
    if (!patch) throw new Error(`Patch ${patchId} not found`);
    if (patch.status !== "approved" && patch.status !== "impact_analyzed") {
      throw new Error(`Patch ${patchId} is in status "${patch.status}", cannot apply`);
    }

    const updatedGraph = applyOperations(graph, patch.operations);
    const saved = { ...updatedGraph, updatedAt: this.now(), version: graph.version + 1 };
    await this.saveGraph(saved);

    // Save before snapshot in the applied entry for rollback
    const patchesDir = join(this.booksRoot, bookId, "runtime");
    await mkdir(patchesDir, { recursive: true });
    await appendFile(this.patchesPath(bookId), JSON.stringify({
      ...patch,
      status: "applied",
      appliedAt: this.now(),
      metadata: { bookId: graph.bookId, nodes: graph.nodes, edges: graph.edges, version: graph.version, updatedAt: graph.updatedAt },
    }) + "\n", "utf-8");
    return saved;
  }

  async listPatches(bookId: string): Promise<NarrativeGraphPatch[]> {
    try {
      const raw = await readFile(this.patchesPath(bookId), "utf-8");
      const lines = raw.trim().split("\n").filter((l) => l.length > 0);
      const patches = lines.map((l) => JSON.parse(l) as NarrativeGraphPatch);
      const latest = new Map<string, NarrativeGraphPatch>();
      for (const p of patches) latest.set(p.patchId, p);
      return [...latest.values()].reverse();
    } catch { return []; }
  }

  async getUnconsumedPatches(bookId: string): Promise<NarrativeGraphPatch[]> {
    const patches = await this.listPatches(bookId);
    return patches.filter((p) => p.status === "applied" || p.status === "impact_analyzed" || p.status === "approved");
  }

  async markPatchConsumed(bookId: string, patchId: string, status: "consumed" | "partially_consumed"): Promise<void> {
    const patchesDir = join(this.booksRoot, bookId, "runtime");
    await mkdir(patchesDir, { recursive: true });
    await appendFile(this.patchesPath(bookId), JSON.stringify({
      patchId, bookId, createdAt: this.now(), createdBy: "assistant" as const,
      status, reason: `Marked as ${status} after write-next`, operations: [],
    }) + "\n", "utf-8");
  }

  async rollbackPatch(bookId: string, patchId: string): Promise<NarrativeGraph> {
    const patches = await this.listPatches(bookId);
    const targetPatch = patches.find((p) => p.patchId === patchId);
    if (!targetPatch) throw new Error(`Patch ${patchId} not found`);

    // Find the before snapshot saved during applyPatch
    const allPatchEntries = await this.readAllPatchEntries(bookId);
    const applyEntry = allPatchEntries.find(
      (p) => p.patchId === patchId && p.status === "applied"
    );
    const beforeSnapshot = applyEntry?.metadata as NarrativeGraph | undefined;

    let restoredGraph: NarrativeGraph;
    if (beforeSnapshot && beforeSnapshot.nodes) {
      // Restore from saved before snapshot
      restoredGraph = { ...beforeSnapshot, updatedAt: this.now(), version: beforeSnapshot.version + 1 };
    } else {
      // Fallback: recompute by re-applying all patches except the target
      const currentGraph = await this.loadGraph(bookId);
      const appliedPatches = allPatchEntries.filter(
        (p) => p.status === "applied" && p.patchId !== patchId
      );
      restoredGraph = { bookId, nodes: [], edges: [], updatedAt: this.now(), version: 0 };
      for (const p of appliedPatches.reverse()) {
        restoredGraph = applyOperations(restoredGraph, p.operations);
      }
      restoredGraph = { ...restoredGraph, updatedAt: this.now(), version: currentGraph.version + 1 };
    }

    await this.saveGraph(restoredGraph);

    // Record rollback entry
    const patchesDir = join(this.booksRoot, bookId, "runtime");
    await mkdir(patchesDir, { recursive: true });
    await appendFile(this.patchesPath(bookId), JSON.stringify({
      patchId: generateId("rollback"),
      bookId, createdAt: this.now(), createdBy: "user" as const,
      status: "rolled_back" as const,
      reason: `Rollback of ${patchId}`,
      operations: [],
      rollbackOf: patchId,
    }) + "\n", "utf-8");

    return restoredGraph;
  }

  private async readAllPatchEntries(bookId: string): Promise<Array<NarrativeGraphPatch & { metadata?: Record<string, unknown> }>> {
    try {
      const raw = await readFile(this.patchesPath(bookId), "utf-8");
      return raw.trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    } catch { return []; }
  }
}
