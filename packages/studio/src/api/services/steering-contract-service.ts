/**
 * Steering Contract Compiler — merges user intent, critique artifact
 * recommendations, and graph changes into a ChapterSteeringContract.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface CompileSteeringContractInput {
  readonly userText: string;
  readonly resolvedRequirements: {
    readonly goals: ReadonlyArray<string>;
    readonly mustInclude: ReadonlyArray<string>;
    readonly mustAvoid: ReadonlyArray<string>;
    readonly desiredTone: ReadonlyArray<string>;
    readonly characterFocus: ReadonlyArray<string>;
    readonly payoffRequests: ReadonlyArray<string>;
  };
  readonly referencedCritiquePayload?: {
    readonly nextChapterOpportunities?: ReadonlyArray<{
      readonly title: string;
      readonly why: string;
      readonly mustInclude: ReadonlyArray<string>;
      readonly risk: string;
      readonly payoff: string;
    }>;
    readonly weaknesses?: ReadonlyArray<string>;
  };
  readonly sourceArtifactIds: ReadonlyArray<string>;
}

export interface CompiledSteeringContract {
  readonly goal?: string;
  readonly mustInclude: ReadonlyArray<string>;
  readonly mustAvoid: ReadonlyArray<string>;
  readonly sceneBeats: ReadonlyArray<string>;
  readonly payoffRequired?: string;
  readonly endingHook?: string;
  readonly priority: "soft" | "normal" | "hard";
  readonly sourceArtifactIds: ReadonlyArray<string>;
  readonly rawRequest: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function unique(arr: ReadonlyArray<string>): string[] {
  return [...new Set(arr.filter((s) => s.trim().length > 0))];
}

function detectPriority(text: string): "soft" | "normal" | "hard" {
  if (/必须|一定|强制|不能|不要/.test(text)) return "hard";
  if (/建议|最好|可以考虑|参考/.test(text)) return "soft";
  return "normal";
}

// ── Public API ─────────────────────────────────────────────────────────

export function compileSteeringContract(input: CompileSteeringContractInput): CompiledSteeringContract {
  const mustInclude: string[] = [...input.resolvedRequirements.mustInclude];
  const mustAvoid: string[] = [...input.resolvedRequirements.mustAvoid];
  const sceneBeats: string[] = [];

  // Merge critique opportunities into sceneBeats (NOT hard mustInclude).
  // Design principle: LLM critique suggestions are soft guidance — only user-explicit
  // "必须/一定要" statements become hard mustInclude requirements.
  if (input.referencedCritiquePayload?.nextChapterOpportunities) {
    for (const opp of input.referencedCritiquePayload.nextChapterOpportunities.slice(0, 3)) {
      sceneBeats.push(`[来自剧情分析] ${opp.title}: ${opp.why}`);
      // Critique-derived sub-items go to sceneBeats as soft beats
      for (const item of opp.mustInclude) {
        sceneBeats.push(`[建议包含] ${item}`);
      }
    }
  }

  // Add payoff requests
  if (input.resolvedRequirements.payoffRequests.length > 0) {
    for (const req of input.resolvedRequirements.payoffRequests) {
      sceneBeats.push(`兑现: ${req}`);
    }
  }

  // Build goal from user text
  const goalMatch = input.userText.match(/(?:让|要|写)(.{5,50}?)(?:[，。；,.]|$)/);
  const goal = goalMatch
    ? goalMatch[1].trim()
    : input.resolvedRequirements.goals.length > 0
      ? input.resolvedRequirements.goals[0]
      : undefined;

  return {
    ...(goal ? { goal } : {}),
    mustInclude: unique(mustInclude),
    mustAvoid: unique(mustAvoid),
    sceneBeats: unique(sceneBeats),
    payoffRequired: input.resolvedRequirements.payoffRequests.length > 0
      ? input.resolvedRequirements.payoffRequests[0]
      : undefined,
    priority: detectPriority(input.userText),
    sourceArtifactIds: [...input.sourceArtifactIds],
    rawRequest: input.userText,
  };
}
