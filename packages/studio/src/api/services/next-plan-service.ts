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
    goal: result.goal,
    conflicts: result.conflicts,
    chapterNumber: result.chapterNumber,
  };
}
