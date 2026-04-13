/**
 * Brief normalization service.
 * Converts raw natural-language creative input into a structured brief.
 */

import type { NormalizeBriefInput } from "../schemas/brief-schema.js";
import type { CreativeBrief, NormalizeBriefResponse } from "../../shared/contracts.js";

/** Generates a stable, unique briefId based on current time + title. */
function generateBriefId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .slice(0, 24);
  const ts = Date.now().toString(36);
  return `brief_${slug}_${ts}`;
}

/**
 * Normalize a raw creative input into a structured CreativeBrief.
 * In the current implementation the normalization is a best-effort parse
 * of the rawInput without calling an external LLM, keeping the route
 * synchronous and testable without network access.
 *
 * Future iterations can replace the body of this function with an LLM call
 * while keeping the same contract.
 */
export function normalizeBrief(input: NormalizeBriefInput): NormalizeBriefResponse {
  const briefId = generateBriefId(input.title);

  const normalizedBrief: CreativeBrief = {
    title: input.title,
    coreGenres: extractGenres(input.rawInput),
    positioning: extractPositioning(input.rawInput),
    worldSetting: extractWorldSetting(input.rawInput),
    protagonist: extractProtagonist(input.rawInput),
    mainConflict: extractMainConflict(input.rawInput),
    endingDirection: undefined,
    styleRules: extractStyleRules(input.rawInput),
    forbiddenPatterns: [],
    targetAudience: undefined,
    platformIntent: input.platform,
  };

  return { briefId, normalizedBrief };
}

// --- Extraction helpers (heuristic, LLM-agnostic) ---

const PENDING = "待定";

const GENRE_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ["科幻", "科幻"],
  ["玄幻", "玄幻"],
  ["仙侠", "仙侠"],
  ["悬疑", "悬疑"],
  ["言情", "言情"],
  ["历史", "历史"],
  ["都市", "都市"],
  ["奇幻", "奇幻"],
  ["sci-fi", "科幻"],
  ["fantasy", "奇幻"],
  ["mystery", "悬疑"],
  ["romance", "言情"],
].map(([kw, genre]) => [kw.toLowerCase(), genre] as const);

function extractGenres(rawInput: string): string[] {
  const found: string[] = [];
  const lower = rawInput.toLowerCase();
  for (const [keyword, genre] of GENRE_KEYWORDS) {
    if (lower.includes(keyword) && !found.includes(genre)) {
      found.push(genre);
    }
  }
  return found.length > 0 ? found : [PENDING];
}

function extractPositioning(rawInput: string): string {
  // Use the first sentence as positioning summary, capped at 200 chars
  const firstSentence = rawInput.split(/[。！？.!?]/)[0] ?? rawInput;
  return firstSentence.trim().slice(0, 200);
}

function extractWorldSetting(rawInput: string): string {
  // Return the raw input truncated as a placeholder world-setting
  return rawInput.trim().slice(0, 300);
}

function extractProtagonist(rawInput: string): string {
  // Simple heuristic: look for "主角" or "主人公" patterns
  const match = /(?:主角|主人公|男主|女主)[是：:为]?([^，。,.\n]{1,50})/u.exec(rawInput);
  return match ? match[1]!.trim() : PENDING;
}

function extractMainConflict(rawInput: string): string {
  // Heuristic: look for conflict-related keywords
  const match = /(?:冲突|矛盾|对抗|反派|危机)[是：:为]?([^，。,.\n]{1,100})/u.exec(rawInput);
  return match ? match[1]!.trim() : rawInput.trim().slice(0, 150);
}

function extractStyleRules(rawInput: string): string[] {
  const styleKeywords = ["克制", "幽默", "慢热", "快节奏", "热血", "阴暗", "唯美", "写实", "诙谐"];
  return styleKeywords.filter((kw) => rawInput.includes(kw));
}
