/**
 * Service for the next-plan preview API.
 * POST /api/books/:id/next-plan
 *
 * Calls planChapter on the pipeline runner to preview the next chapter's
 * intent (goal + conflicts) without composing or writing any chapter content.
 */

import type { NextPlanInput, NextPlanResult } from "../schemas/next-plan-schema.js";

export interface NextPlanServiceDeps {
  readonly planChapter: (bookId: string, context?: string) => Promise<{
    readonly chapterNumber: number;
    readonly goal: string;
    readonly conflicts: ReadonlyArray<string>;
  }>;
}

/**
 * Thrown when the AI plan output fails quality checks even after one retry.
 * The server converts this into a 409 PLAN_LOW_CONFIDENCE response.
 */
export class PlanLowConfidenceError extends Error {
  constructor() {
    super("建议质量不足，请补充关键冲突后再试。");
    this.name = "PlanLowConfidenceError";
  }
}

const GLOBAL_PLAN_PATTERNS: ReadonlyArray<RegExp> = [
  /总体规划/i,
  /总规划/i,
  /全书/i,
  /共\s*\d+\s*章/i,
  /第.{0,3}卷/i,
  /长期/i,
  /阶段性/i,
];

// Placeholder strings returned by sanitizeGoal / sanitizeConflicts when the AI
// output contains no usable content.  A plan that still contains these after
// sanitisation is considered low-confidence.
const GOAL_FALLBACK = "推进本章核心事件，并让主角做出一个带代价的关键选择。";
const CONFLICT_FALLBACK_FRAGMENT = "请补充本章冲突";

function stripMarkdown(value: string): string {
  return value
    .replace(/[`*_#>]/g, "")
    .replace(/^\s*[-+]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitToLines(value: string): string[] {
  return value
    .split(/\r?\n|；|;/)
    .map((line) => stripMarkdown(line))
    .filter((line) => line.length > 0);
}

function isGlobalPlanningLine(line: string): boolean {
  return GLOBAL_PLAN_PATTERNS.some((pattern) => pattern.test(line));
}

function sanitizeGoal(rawGoal: string): string {
  const candidates = splitToLines(rawGoal).filter((line) => !isGlobalPlanningLine(line));
  if (candidates.length > 0) {
    return candidates[0];
  }
  return GOAL_FALLBACK;
}

function sanitizeConflicts(rawConflicts: ReadonlyArray<string>): string[] {
  const cleaned = rawConflicts
    .flatMap((item) => splitToLines(item))
    .filter((line) => !isGlobalPlanningLine(line));

  if (cleaned.length > 0) {
    return [...new Set(cleaned)];
  }
  return [`${CONFLICT_FALLBACK_FRAGMENT}：主角想达成什么、被谁阻拦、失败代价是什么。`];
}

/**
 * Returns true when the plan output is a low-quality generic placeholder
 * rather than specific, actionable guidance.
 *
 * Quality criteria (must BOTH pass):
 *  - goal is non-empty and is not the generic fallback string
 *  - conflicts contains at least one entry that is not a fallback prompt
 */
export function isPlanLowQuality(plan: NextPlanResult): boolean {
  const goalIsPlaceholder =
    plan.goal.trim().length === 0 || plan.goal === GOAL_FALLBACK;
  const conflictsArePlaceholder =
    plan.conflicts.length === 0 ||
    plan.conflicts.every((c) => c.includes(CONFLICT_FALLBACK_FRAGMENT));
  return goalIsPlaceholder || conflictsArePlaceholder;
}

/**
 * Runs the plan stage for the next chapter of a book and returns a
 * structured preview without triggering compose/write steps.
 *
 * Quality gate: if the first attempt produces a low-confidence plan the
 * service automatically retries once.  If the retry also fails the quality
 * check a PlanLowConfidenceError is thrown.
 */
export async function previewNextPlan(
  bookId: string,
  input: NextPlanInput,
  deps: NextPlanServiceDeps,
): Promise<NextPlanResult> {
  const attempt = async (): Promise<NextPlanResult> => {
    const result = await deps.planChapter(bookId, input.brief);
    return {
      goal: sanitizeGoal(result.goal),
      conflicts: sanitizeConflicts(result.conflicts),
      chapterNumber: result.chapterNumber,
    };
  };

  const plan = await attempt();
  if (!isPlanLowQuality(plan)) {
    return plan;
  }

  // First attempt was low quality — retry once.
  const retried = await attempt();
  if (!isPlanLowQuality(retried)) {
    return retried;
  }

  throw new PlanLowConfidenceError();
}
