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

const GLOBAL_PLAN_PATTERNS: ReadonlyArray<RegExp> = [
  /总体规划/i,
  /总规划/i,
  /全书/i,
  /共\s*\d+\s*章/i,
  /第.{0,3}卷/i,
  /长期/i,
  /阶段性/i,
];

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
  return "推进本章核心事件，并让主角做出一个带代价的关键选择。";
}

function sanitizeConflicts(rawConflicts: ReadonlyArray<string>): string[] {
  const cleaned = rawConflicts
    .flatMap((item) => splitToLines(item))
    .filter((line) => !isGlobalPlanningLine(line));

  if (cleaned.length > 0) {
    return [...new Set(cleaned)];
  }
  return ["请补充本章冲突：主角想达成什么、被谁阻拦、失败代价是什么。"];
}

/**
 * Runs the plan stage for the next chapter of a book and returns a
 * structured preview without triggering compose/write steps.
 */
export async function previewNextPlan(
  bookId: string,
  input: NextPlanInput,
  deps: NextPlanServiceDeps,
): Promise<NextPlanResult> {
  const result = await deps.planChapter(bookId, input.brief);
  return {
    goal: sanitizeGoal(result.goal),
    conflicts: sanitizeConflicts(result.conflicts),
    chapterNumber: result.chapterNumber,
  };
}
