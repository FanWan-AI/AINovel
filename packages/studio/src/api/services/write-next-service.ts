/**
 * WriteNext service — builds the externalContext string injected into
 * PipelineRunner for POST /api/books/:id/write-next steering parameters.
 */

import type { WriteNextInput } from "../schemas/write-next-schema.js";

const PACE_LABELS: Record<string, string> = {
  slow: "slow (lyrical, detailed)",
  balanced: "balanced",
  fast: "fast (action-driven, concise)",
};

/**
 * Converts the optional steering fields from the write-next payload into a
 * single `externalContext` string that PipelineRunner can consume.
 *
 * Returns `undefined` when no steering fields are present so that the pipeline
 * falls back to its default behaviour (backward-compatible with legacy calls
 * that only pass `wordCount`).
 */
export function buildWriteNextExternalContext(input: WriteNextInput): string | undefined {
  const sections: string[] = [];

  if (input.brief) {
    sections.push(`## Author Brief\n${input.brief.trim()}`);
  }

  if (input.chapterGoal) {
    sections.push(`## Chapter Goal\n${input.chapterGoal.trim()}`);
  }

  if (input.mustInclude && input.mustInclude.length > 0) {
    const items = input.mustInclude.map((s) => `- ${s}`).join("\n");
    sections.push(`## Must Include\n${items}`);
  }

  if (input.mustAvoid && input.mustAvoid.length > 0) {
    const items = input.mustAvoid.map((s) => `- ${s}`).join("\n");
    sections.push(`## Must Avoid\n${items}`);
  }

  if (input.pace) {
    sections.push(`## Pace\n${PACE_LABELS[input.pace] ?? input.pace}`);
  }

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

/**
 * Builds an `externalContext` string from an AI-generated plan result.
 * Used when `mode="ai-plan"` to pass the planned goal and conflicts to the
 * compose step, optionally augmented with manual overrides from the request.
 */
export function buildWriteNextContextFromPlan(
  plan: { readonly goal: string; readonly conflicts: ReadonlyArray<string> },
  input: Pick<WriteNextInput, "mustInclude" | "mustAvoid" | "pace">,
): string {
  const sections: string[] = [];

  sections.push(`## Chapter Goal\n${plan.goal.trim()}`);

  if (plan.conflicts.length > 0) {
    const items = plan.conflicts.map((c) => `- ${c}`).join("\n");
    sections.push(`## Key Conflicts\n${items}`);
  }

  if (input.mustInclude && input.mustInclude.length > 0) {
    const items = input.mustInclude.map((s) => `- ${s}`).join("\n");
    sections.push(`## Must Include\n${items}`);
  }

  if (input.mustAvoid && input.mustAvoid.length > 0) {
    const items = input.mustAvoid.map((s) => `- ${s}`).join("\n");
    sections.push(`## Must Avoid\n${items}`);
  }

  if (input.pace) {
    sections.push(`## Pace\n${PACE_LABELS[input.pace] ?? input.pace}`);
  }

  return sections.join("\n\n");
}
