/**
 * Brief normalization service.
 * Converts raw natural-language creative input into a structured brief.
 */

import type { NormalizeBriefInput } from "../schemas/brief-schema.js";
import { normalizeBriefText } from "../schemas/brief-schema.js";
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

  // rawInput has already been normalized by validateNormalizeBriefInput.
  // Apply normalizeBriefText to the title as well to ensure consistent output.
  const normalizedTitle = normalizeBriefText(input.title);

  const parsed = parseStructuredInput(input.rawInput);

  const normalizedBrief: CreativeBrief = {
    title: normalizedTitle,
    coreGenres: extractGenres(parsed),
    positioning: extractPositioning(parsed),
    worldSetting: extractWorldSetting(parsed),
    protagonist: extractProtagonist(parsed),
    mainConflict: extractMainConflict(parsed),
    endingDirection: undefined,
    styleRules: extractStyleRules(parsed),
    forbiddenPatterns: [],
    targetAudience: parsed.targetAudience || undefined,
    platformIntent: input.platform ?? parsed.platformIntent ?? undefined,
  };

  return { briefId, normalizedBrief };
}

// --- Extraction helpers (heuristic, LLM-agnostic) ---

const PENDING = "待定";

interface ParsedStructuredInput {
  readonly seedText: string;
  readonly genreHint: string;
  readonly positioning: string;
  readonly worldSetting: string;
  readonly protagonist: string;
  readonly mainConflict: string;
  readonly targetAudience: string;
  readonly styleHint: string;
  readonly platformIntent: string;
}

function parseStructuredInput(rawInput: string): ParsedStructuredInput {
  const lines = rawInput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const seedParts: string[] = [];
  let genreHint = "";
  let positioning = "";
  let worldSetting = "";
  let protagonist = "";
  let mainConflict = "";
  let targetAudience = "";
  let styleHint = "";
  let platformIntent = "";

  for (const line of lines) {
    const match = /^([^:]{1,20}):\s*(.+)$/u.exec(line);
    if (!match) {
      seedParts.push(line);
      continue;
    }

    const label = match[1]!.replace(/\s+/g, "");
    const value = match[2]!.trim();
    if (!value) continue;

    if (/(核心题材|题材|类型|创意描述)/u.test(label)) {
      if (!genreHint) genreHint = value;
      continue;
    }
    if (/(一句话定位|故事定位|定位)/u.test(label)) {
      if (!positioning) positioning = value;
      continue;
    }
    if (/(世界观|背景)/u.test(label)) {
      if (!worldSetting) worldSetting = value;
      continue;
    }
    if (/(主角|主人公|男主|女主)/u.test(label)) {
      if (!protagonist) protagonist = value;
      continue;
    }
    if (/(主冲突|冲突|矛盾)/u.test(label)) {
      if (!mainConflict) mainConflict = value;
      continue;
    }
    if (/(目标读者|受众)/u.test(label)) {
      if (!targetAudience) targetAudience = value;
      continue;
    }
    if (/(风格偏好|文风|风格)/u.test(label)) {
      if (!styleHint) styleHint = value;
      continue;
    }
    if (/(目标平台|平台)/u.test(label)) {
      if (!platformIntent) platformIntent = value;
      continue;
    }

    seedParts.push(line);
  }

  const seedText = seedParts.join("\n").trim();
  return {
    seedText,
    genreHint,
    positioning,
    worldSetting,
    protagonist,
    mainConflict,
    targetAudience,
    styleHint,
    platformIntent,
  };
}

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

function looksLikeTagList(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const commaCount = (clean.match(/[，,、]/g) ?? []).length;
  const hasSentencePunc = /[。！？.!?]/u.test(clean);
  return commaCount >= 2 && !hasSentencePunc && clean.length <= 80;
}

function summarizeSentence(text: string, max = 200): string {
  const first = text.split(/[。！？.!?]/u)[0] ?? text;
  return first.trim().slice(0, max);
}

function extractGenres(input: ParsedStructuredInput): string[] {
  const found: string[] = [];
  const source = [input.genreHint, input.seedText, input.positioning].filter(Boolean).join("\n");
  const lower = source.toLowerCase();
  for (const [keyword, genre] of GENRE_KEYWORDS) {
    if (lower.includes(keyword) && !found.includes(genre)) {
      found.push(genre);
    }
  }
  return found.length > 0 ? found : [PENDING];
}

function extractPositioning(input: ParsedStructuredInput): string {
  if (input.positioning) return input.positioning.slice(0, 260);
  if (input.seedText) return summarizeSentence(input.seedText, 200);
  if (input.genreHint) return input.genreHint.slice(0, 160);
  return PENDING;
}

function extractWorldSetting(input: ParsedStructuredInput): string {
  if (input.worldSetting) return input.worldSetting.slice(0, 300);
  if (!input.seedText) return PENDING;
  if (looksLikeTagList(input.seedText)) {
    return input.positioning ? input.positioning.slice(0, 220) : PENDING;
  }
  return input.seedText.slice(0, 300);
}

function extractProtagonist(input: ParsedStructuredInput): string {
  if (input.protagonist) return input.protagonist.slice(0, 80);
  const rawInput = [input.seedText, input.positioning].filter(Boolean).join("\n");
  // Simple heuristic: look for "主角" or "主人公" patterns
  const match = /(?:主角|主人公|男主|女主)[是：:为]?([^，。,.\n]{1,50})/u.exec(rawInput);
  return match ? match[1]!.trim() : PENDING;
}

function extractMainConflict(input: ParsedStructuredInput): string {
  if (input.mainConflict) return input.mainConflict.slice(0, 180);
  const rawInput = [input.seedText, input.positioning].filter(Boolean).join("\n");
  // Heuristic: look for conflict-related keywords
  const match = /(?:冲突|矛盾|对抗|反派|危机)[是：:为]?([^，。,.\n]{1,100})/u.exec(rawInput);
  if (match) return match[1]!.trim();
  if (looksLikeTagList(rawInput)) return PENDING;
  return summarizeSentence(rawInput, 160) || PENDING;
}

function extractStyleRules(input: ParsedStructuredInput): string[] {
  const styleKeywords = ["克制", "幽默", "慢热", "快节奏", "热血", "阴暗", "唯美", "写实", "诙谐"];
  const fromHint = input.styleHint
    .split(/[，,、；;。]/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 20);
  const fromKeywords = styleKeywords.filter((kw) =>
    [input.seedText, input.positioning, input.styleHint].some((txt) => txt.includes(kw)),
  );
  const merged = [...fromHint, ...fromKeywords];
  return [...new Set(merged)].slice(0, 8);
}
