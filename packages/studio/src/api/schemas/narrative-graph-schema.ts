/**
 * Narrative Graph Schema — data types for the Narrative Knowledge Graph.
 */

export type NarrativeNodeType =
  | "book" | "volume" | "chapter" | "scene" | "character"
  | "desire" | "fear" | "secret" | "relationship" | "conflict"
  | "hook" | "promise" | "payoff" | "rule" | "resource"
  | "timeline_event" | "scene_beat" | "theme" | "constraint";

export interface NarrativeGraphNode {
  readonly id: string;
  readonly type: NarrativeNodeType;
  readonly label: string;
  readonly summary?: string;
  readonly status?: "active" | "resolved" | "dormant" | "deprecated";
  readonly confidence: number;
  readonly weight: number;
  readonly tags: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<{ readonly source: string; readonly excerpt: string; readonly locator?: string }>;
  readonly userEditable: boolean;
  readonly locked?: boolean;
  readonly metadata: Record<string, unknown>;
}

export type NarrativeEdgeType =
  | "contains" | "appears_in" | "wants" | "fears" | "hides" | "knows"
  | "blocks" | "helps" | "protects" | "betrays" | "owes" | "loves" | "hates"
  | "tests" | "misjudges" | "foreshadows" | "pays_off" | "contradicts"
  | "causes" | "depends_on" | "transforms_into" | "raises_stakes_for";

export interface NarrativeGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: NarrativeEdgeType;
  readonly label: string;
  readonly strength: number;
  readonly status?: "active" | "resolved" | "planned" | "deprecated";
  readonly evidence: ReadonlyArray<{ readonly source: string; readonly excerpt: string; readonly locator?: string }>;
  readonly metadata: Record<string, unknown>;
}

export type NarrativeGraphOperation =
  | { readonly type: "add_node"; readonly node: NarrativeGraphNode }
  | { readonly type: "update_node"; readonly nodeId: string; readonly patch: Partial<NarrativeGraphNode> }
  | { readonly type: "remove_node"; readonly nodeId: string }
  | { readonly type: "add_edge"; readonly edge: NarrativeGraphEdge }
  | { readonly type: "update_edge"; readonly edgeId: string; readonly patch: Partial<NarrativeGraphEdge> }
  | { readonly type: "remove_edge"; readonly edgeId: string };

export interface NextChapterSteeringHints {
  readonly mustInclude: ReadonlyArray<string>;
  readonly mustAvoid: ReadonlyArray<string>;
  readonly sceneBeats: ReadonlyArray<string>;
  readonly payoffRequired?: string;
  readonly endingHook?: string;
}

export interface NarrativeGraphImpactAnalysis {
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly affectedCharacters: ReadonlyArray<string>;
  readonly affectedHooks: ReadonlyArray<string>;
  readonly affectedRules: ReadonlyArray<string>;
  readonly affectedChapters: ReadonlyArray<number>;
  readonly contradictions: ReadonlyArray<{ readonly description: string; readonly evidence: string; readonly severity: "low" | "medium" | "high" }>;
  readonly requiredStoryPatches: ReadonlyArray<string>;
  readonly nextChapterSteeringHints: NextChapterSteeringHints;
  readonly recommendation: "safe_to_apply" | "apply_with_warning" | "requires_rewrite_plan" | "reject";
}

export type NarrativeGraphPatchStatus =
  | "draft" | "impact_analyzed" | "approved" | "applied" | "rejected" | "rolled_back" | "consumed" | "partially_consumed";

export interface NarrativeGraphPatch {
  readonly patchId: string;
  readonly bookId: string;
  readonly createdAt: string;
  readonly createdBy: "user" | "assistant";
  readonly status: NarrativeGraphPatchStatus;
  readonly reason: string;
  readonly operations: ReadonlyArray<NarrativeGraphOperation>;
  readonly impactAnalysis?: NarrativeGraphImpactAnalysis;
  readonly appliedAt?: string;
  readonly rollbackOf?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface NarrativeGraph {
  readonly bookId: string;
  readonly nodes: ReadonlyArray<NarrativeGraphNode>;
  readonly edges: ReadonlyArray<NarrativeGraphEdge>;
  readonly updatedAt: string;
  readonly version: number;
}
