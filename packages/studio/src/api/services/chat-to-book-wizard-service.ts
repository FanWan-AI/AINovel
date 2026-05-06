/**
 * Chat-to-Book Wizard Service
 *
 * Multi-turn dialogue that helps users create a new book from scratch.
 * The LLM drives the design; the user only approves/refines.
 *
 * Flow:
 *   Turn 1  (no prior draft) — gather intent, generate complete draft
 *   Turn N  (prior draft)    — apply user refinements to specific fields
 *   Final   (confirm signal) — mark stage as "confirmed", ready for creation
 */

import type { BookCreationDraftPayload } from "./assistant-artifact-service.js";

// ── Constants ──────────────────────────────────────────────────────────

/** Positive confirmation patterns — no LLM needed. */
const CONFIRM_PATTERN =
  /^[\s]*(?:确认|确认创建|好的|就这样|没问题|可以|行|就这个|就这本|好|创建|开始|ok|yes|确定|同意|执行|就按这个)[\s!！。]*$/iu;

/** Cancellation patterns. */
const CANCEL_PATTERN = /取消|算了|不要了|重来|重新|不写了|cancel/iu;

/** Whether the user confirmed creation. */
export function detectConfirmation(text: string): "confirm" | "cancel" | "refine" {
  if (CONFIRM_PATTERN.test(text.trim())) return "confirm";
  if (CANCEL_PATTERN.test(text.trim())) return "cancel";
  return "refine";
}

// ── System prompts ─────────────────────────────────────────────────────

function buildGatheringPrompt(
  userText: string,
  recentMessages?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string {
  const contextBlock = recentMessages && recentMessages.length > 0
    ? `\n\n【近期对话记录（重要参考，请从中提取真实的书籍意图）】\n${recentMessages.map((m) => `${m.role === "assistant" ? "助手" : "用户"}：${m.content.slice(0, 1200)}`).join("\n\n")}\n`
    : "";

  return `你是一个网文策划专家，擅长中文网络小说（男频爽文、都市、修仙、玄幻、系统流、成人向/H小说等各类型）。
用户想创建一本新书。${contextBlock}

你的任务：
1. 【最重要】综合以上"近期对话记录"和用户当前指令，准确还原用户的真实意图（书名、题材、风格、是否成人向等）
2. 如果对话历史中已有详细策划方案，直接从中提取关键信息填充 JSON，不要重新发明、不要凭空编造与用户意图无关的内容
3. 最多只问一个追加问题（如果确实无法判断某个关键信息）
4. 直接输出一个完整的书籍设定 JSON 对象，格式如下：

\`\`\`json
{
  "title": "书名（吸引人、符合类型，若对话中已提及则直接使用）",
  "genre": "都市爽文",
  "audience": "男频",
  "platform": "qidian",
  "protagonist": "一句话描述主角身份和初始状态",
  "coreConflict": "核心爽点/主要矛盾（打脸/系统/逆袭等）",
  "femaleLeads": "女主搭配（各一句话描述）",
  "firstVolumePlan": "第一卷主线（100字以内）",
  "styleRules": ["节奏快", "爽点密集", "对话口语化"],
  "chapterWordCount": 3000,
  "targetChapters": 100
}
\`\`\`

【平台判断规则（必须严格遵守）】
- 若用户或对话中提及：H题材 / 成人向 / 18+ / 老色批 / 情欲 / 后宫 / 涩文 / 开车 / 露骨 → genre 填"成人向"，audience 填"成人男频"，platform 填"adult"，styleRules 中加入"情欲描写露骨直白"
- 若用户或对话中提到具体章节数（如"50章""100章左右""打算写200章"），将其提取为 targetChapters；若未提及则填 100
- 否则 platform 填"qidian"（起点）

5. JSON 之后，用2-3句自然语言向用户展示这个方案，问他有没有要改的。
6. 语气轻松、专业，像一个经验丰富的编辑在帮作者策划。

用户当前指令：${userText}`;
}

function buildRefinePrompt(
  userText: string,
  previousDraft: BookCreationDraftPayload,
): string {
  return `你是一个网文策划专家，正在帮用户完善一本新书的设定。

当前书籍草案：
\`\`\`json
${JSON.stringify(previousDraft, null, 2)}
\`\`\`

用户想修改：${userText}

你的任务：
1. 根据用户意见，只修改用户提到的字段（其他字段保持不变）
2. 输出更新后的完整草案 JSON（格式与原来相同）
3. JSON 之后用1-2句话告知用户改了哪里，并确认是否还有其他要改的

注意：输出的 JSON 必须包含所有原有字段。`;
}

// ── JSON extraction ────────────────────────────────────────────────────

function extractJsonFromResponse(text: string): Record<string, unknown> | null {
  // Try fenced code block first
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  // Try bare JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  return null;
}

function extractNarrativeText(llmResponse: string): string {
  // Remove the JSON block and return the surrounding text
  return llmResponse
    .replace(/```(?:json)?\s*[\s\S]*?```/g, "")
    .replace(/\{[\s\S]*\}/g, "")
    .trim();
}

function parseDraftFromJson(
  raw: Record<string, unknown>,
  previousDraft: BookCreationDraftPayload | null | undefined,
  userText: string,
): BookCreationDraftPayload {
  const prevRefinements = previousDraft?.userRefinements ?? [];
  return {
    stage: "draft_ready",
    title: (typeof raw.title === "string" ? raw.title : previousDraft?.title) ?? "（待定）",
    genre: (typeof raw.genre === "string" ? raw.genre : previousDraft?.genre) ?? "都市爽文",
    audience: (typeof raw.audience === "string" ? raw.audience : previousDraft?.audience) ?? "男频",
    ...(typeof raw.platform === "string"
      ? { platform: raw.platform }
      : previousDraft?.platform !== undefined
        ? { platform: previousDraft.platform }
        : {}),
    protagonist: (typeof raw.protagonist === "string" ? raw.protagonist : previousDraft?.protagonist) ?? "",
    coreConflict: (typeof raw.coreConflict === "string" ? raw.coreConflict : previousDraft?.coreConflict) ?? "",
    ...(typeof raw.femaleLeads === "string"
      ? { femaleLeads: raw.femaleLeads }
      : previousDraft?.femaleLeads !== undefined
        ? { femaleLeads: previousDraft.femaleLeads }
        : {}),
    ...(typeof raw.firstVolumePlan === "string"
      ? { firstVolumePlan: raw.firstVolumePlan }
      : previousDraft?.firstVolumePlan !== undefined
        ? { firstVolumePlan: previousDraft.firstVolumePlan }
        : {}),
    ...(Array.isArray(raw.styleRules)
      ? { styleRules: (raw.styleRules as unknown[]).map(String) }
      : previousDraft?.styleRules !== undefined
        ? { styleRules: previousDraft.styleRules }
        : {}),
    ...(typeof raw.chapterWordCount === "number"
      ? { chapterWordCount: raw.chapterWordCount }
      : previousDraft?.chapterWordCount !== undefined
        ? { chapterWordCount: previousDraft.chapterWordCount }
        : {}),
    ...(typeof raw.targetChapters === "number"
      ? { targetChapters: raw.targetChapters }
      : previousDraft?.targetChapters !== undefined
        ? { targetChapters: previousDraft.targetChapters }
        : {}),
    userRefinements: previousDraft
      ? [...prevRefinements, userText]
      : [],
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export interface WizardTurnInput {
  readonly sessionId: string;
  readonly userText: string;
  readonly previousDraft?: BookCreationDraftPayload | null;
  /** Recent conversation turns (up to 4) for context when generating the first draft. */
  readonly recentMessages?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  /** Injected dependency — call the project's LLM. */
  readonly llmCall: (systemPrompt: string) => Promise<string>;
}

export interface WizardTurnOutput {
  readonly responseText: string;
  readonly updatedDraft: BookCreationDraftPayload;
  readonly readyToConfirm: boolean;
}

/**
 * Process one wizard turn.
 * - First turn (no previousDraft): generate a complete draft from scratch.
 * - Subsequent turns: apply user refinements.
 * - If LLM fails to produce a parseable JSON, returns a graceful fallback.
 */
export async function processWizardTurn(
  input: WizardTurnInput,
): Promise<WizardTurnOutput> {
  const { userText, previousDraft, recentMessages, llmCall } = input;

  const systemPrompt = previousDraft
    ? buildRefinePrompt(userText, previousDraft)
    : buildGatheringPrompt(userText, recentMessages);

  let llmResponse = "";
  try {
    llmResponse = await llmCall(systemPrompt);
  } catch (err) {
    // LLM failure — return minimal draft so the wizard can recover gracefully
    const fallbackDraft: BookCreationDraftPayload = previousDraft ?? {
      stage: "gathering",
      title: "（AI 暂时无法响应，请稍后重试）",
      genre: "都市爽文",
      audience: "男频",
      protagonist: "",
      coreConflict: "",
      userRefinements: [],
    };
    return {
      responseText: `AI 策划时出现了问题（${err instanceof Error ? err.message : String(err)}），请稍后重试或换个描述方式。`,
      updatedDraft: fallbackDraft,
      readyToConfirm: false,
    };
  }

  const rawJson = extractJsonFromResponse(llmResponse);
  const narrativeText = extractNarrativeText(llmResponse);

  if (!rawJson) {
    // LLM returned text without a parseable JSON block — treat the whole response as narrative
    const fallbackDraft: BookCreationDraftPayload = previousDraft ?? {
      stage: "gathering",
      title: "（待定）",
      genre: "都市爽文",
      audience: "男频",
      protagonist: "",
      coreConflict: "",
      userRefinements: [],
    };
    return {
      responseText: llmResponse.trim() || "请告诉我更多关于这本书的想法，我来帮你策划。",
      updatedDraft: fallbackDraft,
      readyToConfirm: false,
    };
  }

  const updatedDraft = parseDraftFromJson(rawJson, previousDraft, userText);

  const responseText = narrativeText.length > 0
    ? narrativeText
    : `书籍草案已${previousDraft ? "更新" : "生成"}。你可以说"改书名"/"换女主"等来微调，或直接说"确认创建"。`;

  return {
    responseText,
    updatedDraft,
    readyToConfirm: true,
  };
}

/**
 * Build the ConfirmCreateRequest from a confirmed draft.
 * Maps BookCreationDraftPayload fields to the create-flow schema.
 */
export function draftToConfirmRequest(draft: BookCreationDraftPayload): {
  bookConfig: {
    title: string;
    genre: string;
    platform: string;
    language: "zh";
    chapterWordCount: number;
    targetChapters?: number;
  };
  brief: {
    title: string;
    coreGenres: string[];
    positioning: string;
    protagonist: string;
    mainConflict: string;
    femaleLeads?: string;
    firstVolumePlan?: string;
    styleRules?: string[];
  };
} {
  const isAdult = draft.platform === "adult"
    || draft.genre === "成人向"
    || /成人|adult|H题材|老色批/iu.test(draft.audience ?? "");
  return {
    bookConfig: {
      title: draft.title,
      genre: draft.genre,
      platform: isAdult ? "adult" : (draft.platform ?? "qidian"),
      language: "zh",
      chapterWordCount: draft.chapterWordCount ?? 3000,
      ...(draft.targetChapters !== undefined ? { targetChapters: draft.targetChapters } : {}),
    },
    brief: {
      title: draft.title,
      coreGenres: [draft.genre],
      positioning: draft.audience,
      protagonist: draft.protagonist,
      mainConflict: draft.coreConflict,
      ...(draft.femaleLeads ? { femaleLeads: draft.femaleLeads } : {}),
      ...(draft.firstVolumePlan ? { firstVolumePlan: draft.firstVolumePlan } : {}),
      ...(draft.styleRules ? { styleRules: [...draft.styleRules] } : {}),
    },
  };
}
