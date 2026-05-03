/**
 * Graph-to-Steering Compiler (P3) — converts unconsumed narrative graph patches
 * into ChapterSteeringContract hints for write-next.
 */

import type { NarrativeGraphPatch } from "../schemas/narrative-graph-schema.js";
import type { CompileSteeringContractInput } from "./steering-contract-service.js";

export interface PatchRequirements {
  readonly patchId: string;
  readonly mustInclude: ReadonlyArray<string>;
  readonly mustAvoid: ReadonlyArray<string>;
  readonly sceneBeats: ReadonlyArray<string>;
}

export interface GraphSteeringResult {
  readonly mustInclude: ReadonlyArray<string>;
  readonly mustAvoid: ReadonlyArray<string>;
  readonly sceneBeats: ReadonlyArray<string>;
  readonly payoffRequired?: string;
  readonly endingHook?: string;
  readonly sourcePatchIds: ReadonlyArray<string>;
  /** Per-patch requirements breakdown for granular consumption decisions. */
  readonly patchRequirements: ReadonlyArray<PatchRequirements>;
}

/**
 * Compile unconsumed graph patches into steering hints.
 */
export function compileGraphPatchesToSteering(
  patches: ReadonlyArray<NarrativeGraphPatch>,
): GraphSteeringResult {
  const mustInclude: string[] = [];
  const mustAvoid: string[] = [];
  const sceneBeats: string[] = [];
  const sourcePatchIds: string[] = [];
  const patchRequirements: PatchRequirements[] = [];

  for (const patch of patches) {
    if (patch.status !== "applied" && patch.status !== "impact_analyzed" && patch.status !== "approved") {
      continue;
    }

    sourcePatchIds.push(patch.patchId);

    const patchMustInclude: string[] = [];
    const patchMustAvoid: string[] = [];
    const patchSceneBeats: string[] = [];

    // From impact analysis
    if (patch.impactAnalysis) {
      const hints = patch.impactAnalysis.nextChapterSteeringHints;
      mustInclude.push(...hints.mustInclude);
      mustAvoid.push(...hints.mustAvoid);
      sceneBeats.push(...hints.sceneBeats);
      patchMustInclude.push(...hints.mustInclude);
      patchMustAvoid.push(...hints.mustAvoid);
      patchSceneBeats.push(...hints.sceneBeats);
    }

    // From operations
    for (const op of patch.operations) {
      if (op.type === "update_edge") {
        if (op.patch.label) {
          const req = `体现关系变化：${op.patch.label}`;
          mustInclude.push(req);
          patchMustInclude.push(req);
        }
        if (op.patch.status === "active") {
          const beat = `展现状态变更的影响`;
          sceneBeats.push(beat);
          patchSceneBeats.push(beat);
        }
      }
      if (op.type === "add_edge" && op.edge.type === "foreshadows") {
        const req = `伏笔兑现：${op.edge.label}`;
        mustInclude.push(req);
        patchMustInclude.push(req);
      }
      if (op.type === "add_node" && op.node.type === "hook") {
        const beat = `引入新悬念：${op.node.label}`;
        sceneBeats.push(beat);
        patchSceneBeats.push(beat);
      }
    }

    patchRequirements.push({
      patchId: patch.patchId,
      mustInclude: [...new Set(patchMustInclude)],
      mustAvoid: [...new Set(patchMustAvoid)],
      sceneBeats: [...new Set(patchSceneBeats)],
    });
  }

  return {
    mustInclude: [...new Set(mustInclude)],
    mustAvoid: [...new Set(mustAvoid)],
    sceneBeats: [...new Set(sceneBeats)],
    sourcePatchIds,
    patchRequirements,
  };
}

/**
 * Build a CompileSteeringContractInput enriched with graph patch hints.
 */
export function enrichSteeringInputWithGraphPatches(
  base: CompileSteeringContractInput,
  graphResult: GraphSteeringResult,
): CompileSteeringContractInput {
  return {
    ...base,
    resolvedRequirements: {
      ...base.resolvedRequirements,
      mustInclude: [...base.resolvedRequirements.mustInclude, ...graphResult.mustInclude],
      mustAvoid: [...base.resolvedRequirements.mustAvoid, ...graphResult.mustAvoid],
    },
    sourceArtifactIds: [...base.sourceArtifactIds, ...graphResult.sourcePatchIds],
  };
}
