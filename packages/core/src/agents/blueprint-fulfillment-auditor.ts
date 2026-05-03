/**
 * BlueprintFulfillmentAuditor — heuristic auditor that checks whether a
 * written chapter actually fulfils the confirmed ChapterBlueprint.
 *
 * P4: keyword / n-gram heuristic only. P5 can swap in LLM analysis.
 *
 * Key invariant (inherited from P2.5/P3):
 *   Only a blueprint whose status === "confirmed" should ever be passed here.
 *   Callers must validate this before calling auditBlueprintFulfillment.
 */

import type { ChapterBlueprint, ChapterBlueprintScene } from "../models/input-governance.js";

// ── Internal text-matching helpers ────────────────────────────────────

function extractKeywords(phrase: string): string[] {
  const tokens = phrase
    .replace(/[，。；,.！!?？\s、（）()【】「」『』]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
  if (tokens.length > 1) return tokens;
  const source = tokens[0] ?? phrase;
  if (source.length <= 3) return [source];
  const grams: string[] = [source];
  for (let len = 2; len <= 4 && len < source.length; len++) {
    for (let i = 0; i <= source.length - len; i++) {
      grams.push(source.slice(i, i + len));
    }
  }
  return [...new Set(grams)].filter((g) => g.length >= 2);
}

interface PresenceResult {
  found: boolean;
  coverage: number;
  evidence?: string;
  /** Character offset of the best match in the original text (-1 if not found). */
  offset: number;
}

function checkPresence(text: string, phrase: string): PresenceResult {
  const exactIdx = text.indexOf(phrase);
  if (exactIdx !== -1) {
    const start = Math.max(0, exactIdx - 20);
    const end = Math.min(text.length, exactIdx + phrase.length + 40);
    return { found: true, coverage: 1, evidence: text.slice(start, end), offset: exactIdx };
  }

  const keywords = extractKeywords(phrase);
  const lower = text.toLowerCase();
  let foundCount = 0;
  let bestOffset = -1;
  const snippets: string[] = [];

  for (const kw of keywords) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx !== -1) {
      foundCount++;
      if (bestOffset === -1 || idx < bestOffset) bestOffset = idx;
      const s = Math.max(0, idx - 20);
      const e = Math.min(text.length, idx + kw.length + 40);
      snippets.push(text.slice(s, e));
    }
  }

  const coverage = keywords.length > 0 ? foundCount / keywords.length : 0;
  return {
    found: coverage >= 0.3,
    coverage,
    evidence: snippets[0],
    offset: bestOffset,
  };
}

// ── Public types ───────────────────────────────────────────────────────

export type SceneFulfillmentStatus = "satisfied" | "weak" | "missing";

export interface SceneFulfillmentResult {
  readonly index: number;
  /** Original beat text from the blueprint */
  readonly beat: string;
  readonly conflict: string;
  readonly turn: string;
  readonly payoff: string;
  readonly cost: string;
  readonly status: SceneFulfillmentStatus;
  readonly evidence?: string;
  /** Fields whose keywords were not found in the chapter text */
  readonly missingFields: ReadonlyArray<string>;
}

export interface HookFulfillmentResult {
  readonly status: "satisfied" | "weak" | "missing";
  readonly evidence?: string;
}

export interface OpeningHookFulfillmentResult extends HookFulfillmentResult {
  /** The openingHook text from the blueprint */
  readonly expected: string;
  /** Best matching evidence fragment found */
  readonly found?: string;
  /** Character position of the match (-1 if not found) */
  readonly position: number;
  /** Whether the evidence appeared within the first 300 characters */
  readonly withinFirst300Words: boolean;
}

export interface EndingHookFulfillmentResult extends HookFulfillmentResult {
  /** Whether the evidence appeared in the last 15-20% of the text or last 500 chars */
  readonly nearChapterEnd: boolean;
}

export interface BlueprintFulfillmentReport {
  /** 0-100 composite score */
  readonly score: number;
  readonly openingHook: OpeningHookFulfillmentResult;
  readonly scenes: ReadonlyArray<SceneFulfillmentResult>;
  readonly payoffRequired: HookFulfillmentResult;
  readonly endingHook: EndingHookFulfillmentResult;
  /** Human-readable list of structural blockers */
  readonly blockingIssues: ReadonlyArray<string>;
  /** True when the chapter should be regenerated */
  readonly shouldRewrite: boolean;
}

export interface AuditBlueprintFulfillmentInput {
  readonly chapterText: string;
  /** Must be a confirmed ChapterBlueprint (status === "confirmed"). */
  readonly blueprint: ChapterBlueprint;
  readonly chapterNumber?: number;
  readonly language?: string;
}

// ── Scene analysis ─────────────────────────────────────────────────────

function auditScene(text: string, scene: ChapterBlueprintScene, index: number): SceneFulfillmentResult {
  const fields: Array<{ name: string; value: string }> = [
    { name: "beat", value: scene.beat },
    { name: "conflict", value: scene.conflict },
    { name: "turn", value: scene.turn },
    { name: "payoff", value: scene.payoff },
    { name: "cost", value: scene.cost },
  ];

  const missingFields: string[] = [];
  let evidenceFragment: string | undefined;
  let satisfiedCount = 0;

  for (const { name, value } of fields) {
    const result = checkPresence(text, value);
    if (result.found) {
      satisfiedCount++;
      if (!evidenceFragment && result.evidence) {
        evidenceFragment = result.evidence;
      }
    } else {
      missingFields.push(name);
    }
  }

  let status: SceneFulfillmentStatus;
  if (satisfiedCount === fields.length) {
    status = "satisfied";
  } else if (satisfiedCount >= Math.ceil(fields.length / 2)) {
    status = "weak";
  } else {
    status = "missing";
  }

  return {
    index,
    beat: scene.beat,
    conflict: scene.conflict,
    turn: scene.turn,
    payoff: scene.payoff,
    cost: scene.cost,
    status,
    evidence: evidenceFragment,
    missingFields,
  };
}

// ── Main auditor ───────────────────────────────────────────────────────

/**
 * Audit whether a written chapter fulfils a confirmed ChapterBlueprint.
 *
 * Important: callers must ensure `input.blueprint.status === "confirmed"`.
 * This function does NOT re-validate the blueprint schema — that is the
 * responsibility of the pipeline / server layer (P2.5/P3).
 */
export function auditBlueprintFulfillment(
  input: AuditBlueprintFulfillmentInput,
): BlueprintFulfillmentReport {
  const { chapterText, blueprint } = input;
  const textLen = chapterText.length;

  // ── Opening hook ──────────────────────────────────────────────────
  const openingResult = checkPresence(chapterText, blueprint.openingHook);
  // For Chinese text 300 "words" ≈ 300 characters.
  const OPENING_WINDOW = 300;
  const withinFirst300 = openingResult.offset !== -1 && openingResult.offset < OPENING_WINDOW;
  let openingStatus: "satisfied" | "weak" | "missing";
  if (!openingResult.found) {
    openingStatus = "missing";
  } else if (withinFirst300) {
    openingStatus = "satisfied";
  } else {
    openingStatus = "weak";
  }
  const openingHook: OpeningHookFulfillmentResult = {
    expected: blueprint.openingHook,
    found: openingResult.evidence,
    position: openingResult.offset,
    withinFirst300Words: withinFirst300,
    status: openingStatus,
    evidence: openingResult.evidence,
  };

  // ── Scenes ────────────────────────────────────────────────────────
  const scenes: SceneFulfillmentResult[] = blueprint.scenes.map((scene, i) =>
    auditScene(chapterText, scene, i),
  );

  // ── Payoff required ───────────────────────────────────────────────
  const payoffResult = checkPresence(chapterText, blueprint.payoffRequired);
  const payoffRequired: HookFulfillmentResult = {
    status: payoffResult.found ? (payoffResult.coverage >= 0.6 ? "satisfied" : "weak") : "missing",
    evidence: payoffResult.evidence,
  };

  // ── Ending hook ───────────────────────────────────────────────────
  const endingResult = checkPresence(chapterText, blueprint.endingHook);
  // Treat the ending hook as chapter-tail material: use the last 20% of the
  // text, capped at 500 characters so short chapters do not mark mid-chapter
  // hooks as "near the end".
  const ENDING_WINDOW = Math.max(1, Math.min(500, Math.ceil(textLen * 0.2)));
  const endingOffset = endingResult.offset;
  const nearChapterEnd = endingOffset !== -1 && endingOffset >= textLen - ENDING_WINDOW;
  let endingStatus: "satisfied" | "weak" | "missing";
  if (!endingResult.found) {
    endingStatus = "missing";
  } else if (nearChapterEnd) {
    endingStatus = "satisfied";
  } else {
    endingStatus = "weak";
  }
  const endingHook: EndingHookFulfillmentResult = {
    status: endingStatus,
    evidence: endingResult.evidence,
    nearChapterEnd,
  };

  // ── Blocking issues & shouldRewrite ──────────────────────────────
  const blockingIssues: string[] = [];
  const missingSceneCount = scenes.filter((s) => s.status === "missing").length;

  if (openingHook.status === "missing") {
    blockingIssues.push(`openingHook 未出现在正文中（期望："${blueprint.openingHook.slice(0, 40)}…"）`);
  } else if (openingHook.status === "weak") {
    blockingIssues.push(`openingHook 出现但不在前 300 字内（位置: ${openingHook.position}）`);
  }

  if (payoffRequired.status === "missing") {
    blockingIssues.push(`payoffRequired 未在正文中体现（期望："${blueprint.payoffRequired.slice(0, 40)}…"）`);
  }

  if (endingHook.status === "missing") {
    blockingIssues.push(`endingHook 未出现在正文中（期望："${blueprint.endingHook.slice(0, 40)}…"）`);
  } else if (endingHook.status === "weak") {
    blockingIssues.push(`endingHook 出现但不在章节末尾区间（应在末尾 ${ENDING_WINDOW} 字内）`);
  }

  if (missingSceneCount > 0) {
    const missingIndices = scenes.filter((s) => s.status === "missing").map((s) => s.index + 1);
    blockingIssues.push(`${missingSceneCount} 个场景 beat 缺失（scenes: ${missingIndices.join(", ")}）`);
  }

  const shouldRewrite =
    openingHook.status !== "satisfied" ||
    payoffRequired.status === "missing" ||
    endingHook.status !== "satisfied" ||
    missingSceneCount >= 3;

  // ── Score (0-100) ─────────────────────────────────────────────────
  // Weights: openingHook 20, each scene 40/N (satisfied=1, weak=0.5, missing=0),
  //          payoffRequired 20, endingHook 20
  const sceneWeight = 40;
  const sceneUnitWeight = scenes.length > 0 ? sceneWeight / scenes.length : 0;
  const sceneScore = scenes.reduce((acc, s) => {
    if (s.status === "satisfied") return acc + sceneUnitWeight;
    if (s.status === "weak") return acc + sceneUnitWeight * 0.5;
    return acc;
  }, 0);

  const openingScore = openingHook.status === "satisfied" ? 20 : openingHook.status === "weak" ? 10 : 0;
  const payoffScore = payoffRequired.status === "satisfied" ? 20 : payoffRequired.status === "weak" ? 10 : 0;
  const endingScore = endingHook.status === "satisfied" ? 20 : endingHook.status === "weak" ? 10 : 0;

  const rawScore = openingScore + sceneScore + payoffScore + endingScore;
  const score = Math.min(100, Math.round(rawScore));

  return {
    score,
    openingHook,
    scenes,
    payoffRequired,
    endingHook,
    blockingIssues,
    shouldRewrite,
  };
}
