/**
 * Blueprint normalization and validation utilities.
 * Handles backward-compatible parsing of ChapterBlueprint payloads
 * that may be missing the newer optional fields (status, version, etc.).
 */

import { ChapterBlueprintSchema, type ChapterBlueprintStatus } from "../models/input-governance.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface NormalizedBlueprintScene {
  readonly beat: string;
  readonly conflict: string;
  readonly informationGap?: string;
  readonly turn: string;
  readonly payoff: string;
  readonly cost: string;
  readonly mustIncludeRefs?: ReadonlyArray<string>;
  readonly graphPatchRefs?: ReadonlyArray<string>;
}

export interface NormalizedBlueprint {
  readonly openingHook: string;
  readonly scenes: ReadonlyArray<NormalizedBlueprintScene>;
  readonly payoffRequired: string;
  readonly endingHook: string;
  readonly contractSatisfaction: ReadonlyArray<string>;
  readonly status: ChapterBlueprintStatus;
  readonly version: number;
  readonly sourceArtifactIds: ReadonlyArray<string>;
}

export interface BlueprintValidationResult {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly blueprint?: NormalizedBlueprint;
}

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeScene(raw: unknown): NormalizedBlueprintScene | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  return {
    beat: typeof s.beat === "string" && s.beat.trim() ? s.beat.trim() : "（未命名场景）",
    conflict: typeof s.conflict === "string" && s.conflict.trim() ? s.conflict.trim() : "（无冲突描述）",
    informationGap: typeof s.informationGap === "string" && s.informationGap.trim() ? s.informationGap.trim() : undefined,
    turn: typeof s.turn === "string" && s.turn.trim() ? s.turn.trim() : "（无转折）",
    payoff: typeof s.payoff === "string" && s.payoff.trim() ? s.payoff.trim() : "（无爽点）",
    cost: typeof s.cost === "string" && s.cost.trim() ? s.cost.trim() : "（无代价）",
    mustIncludeRefs: Array.isArray(s.mustIncludeRefs) ? s.mustIncludeRefs.filter((x: unknown): x is string => typeof x === "string") : undefined,
    graphPatchRefs: Array.isArray(s.graphPatchRefs) ? s.graphPatchRefs.filter((x: unknown): x is string => typeof x === "string") : undefined,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Normalize a raw unknown value into a NormalizedBlueprint.
 * Returns null if the value is not a recognizable blueprint object.
 * Fills in sensible defaults for missing optional fields.
 */
export function normalizeBlueprint(raw: unknown): NormalizedBlueprint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const bp = raw as Record<string, unknown>;

  const openingHook = typeof bp.openingHook === "string" && bp.openingHook.trim() ? bp.openingHook.trim() : null;
  if (!openingHook) return null;

  const rawScenes = Array.isArray(bp.scenes) ? bp.scenes : [];
  const scenes = rawScenes.map(normalizeScene).filter((s): s is NormalizedBlueprintScene => s !== null);

  return {
    openingHook,
    scenes,
    payoffRequired: typeof bp.payoffRequired === "string" && bp.payoffRequired.trim() ? bp.payoffRequired.trim() : "（未指定兑现要求）",
    endingHook: typeof bp.endingHook === "string" && bp.endingHook.trim() ? bp.endingHook.trim() : "（未指定章尾钩子）",
    contractSatisfaction: Array.isArray(bp.contractSatisfaction) ? bp.contractSatisfaction.filter((x: unknown): x is string => typeof x === "string") : [],
    status: (bp.status === "draft" || bp.status === "confirmed" || bp.status === "edited") ? bp.status : "draft",
    version: typeof bp.version === "number" && Number.isInteger(bp.version) && bp.version > 0 ? bp.version : 1,
    sourceArtifactIds: Array.isArray(bp.sourceArtifactIds) ? bp.sourceArtifactIds.filter((x: unknown): x is string => typeof x === "string") : [],
  };
}

/**
 * Validate a blueprint value using the Zod schema (strict validation)
 * and then normalize it.  Returns errors if validation fails.
 */
export function validateBlueprint(raw: unknown): BlueprintValidationResult {
  const parseResult = ChapterBlueprintSchema.safeParse(raw);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return { ok: false, errors };
  }
  const normalized = normalizeBlueprint(parseResult.data);
  if (!normalized) {
    return { ok: false, errors: ["blueprint object could not be normalized — openingHook may be missing"] };
  }
  return { ok: true, errors: [], blueprint: normalized };
}
