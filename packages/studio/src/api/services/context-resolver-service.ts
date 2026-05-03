/**
 * Context Resolver — resolves artifact references (指代) in user text.
 * Handles: "按你刚才说的", "按第二条建议", "用刚才那个方案", etc.
 */

import type { AssistantArtifact, AssistantArtifactSummary } from "./assistant-artifact-service.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface ResolvedReference {
  readonly phrase: string;
  readonly artifactId: string;
  readonly fieldPath?: string;
  readonly confidence: number;
}

export interface ExtractedUserRequirements {
  readonly goals: ReadonlyArray<string>;
  readonly mustInclude: ReadonlyArray<string>;
  readonly mustAvoid: ReadonlyArray<string>;
  readonly desiredTone: ReadonlyArray<string>;
  readonly desiredPace?: string;
  readonly characterFocus: ReadonlyArray<string>;
  readonly payoffRequests: ReadonlyArray<string>;
  readonly endingHookRequests: ReadonlyArray<string>;
}

export interface ResolvedAssistantContext {
  readonly resolvedReferences: ReadonlyArray<ResolvedReference>;
  readonly extractedUserRequirements: ExtractedUserRequirements;
  readonly missingInformation: ReadonlyArray<string>;
}

export interface ContextResolverInput {
  readonly sessionId: string;
  readonly userText: string;
  readonly recentArtifacts: ReadonlyArray<AssistantArtifactSummary>;
  readonly bookId?: string;
}

// ── Reference detection ────────────────────────────────────────────────

const DIRECT_REFERENCE_PATTERNS: Array<{ pattern: RegExp; extractField?: string }> = [
  { pattern: /按[照]?你(?:刚才|之前|上次).{0,6}(?:说|给)/ },
  { pattern: /按(?:你|刚才|之前|上面).{0,6}(?:说|给|提).{0,6}(?:建议|方案|意见)/ },
  { pattern: /就按?你.{0,6}说/ },
  { pattern: /照(?:这个|那个|刚才).{0,6}(?:方向|方案|思路)/ },
  { pattern: /用(?:刚才|那个|上面).{0,6}(?:方案|计划|建议)/ },
  { pattern: /based on.{0,10}(what you|previous|above|last)/i },
];

const ORDINAL_REFERENCE_PATTERNS: Array<{ pattern: RegExp; index: number }> = [
  { pattern: /第[一二三四五六七八九十]条/, index: -1 }, // will be resolved
  { pattern: /第1条/, index: 0 },
  { pattern: /第2条/, index: 1 },
  { pattern: /第3条/, index: 2 },
  { pattern: /第4条/, index: 3 },
  { pattern: /第5条/, index: 4 },
  { pattern: /(?:第|the )?first/i, index: 0 },
  { pattern: /(?:第|the )?second/i, index: 1 },
  { pattern: /(?:第|the )?third/i, index: 2 },
];

const CHINESE_ORDINALS: Record<string, number> = {
  "一": 0, "二": 1, "三": 2, "四": 3, "五": 4,
  "六": 5, "七": 6, "八": 7, "九": 8, "十": 9,
};

function detectDirectReference(text: string): boolean {
  return DIRECT_REFERENCE_PATTERNS.some((p) => p.pattern.test(text));
}

function detectOrdinalReference(text: string): { matched: boolean; index?: number; phrase?: string } {
  const m = text.match(/第([一二三四五六七八九十])条/);
  if (m) {
    const idx = CHINESE_ORDINALS[m[1]];
    if (idx !== undefined) {
      return { matched: true, index: idx, phrase: m[0] };
    }
  }
  for (const { pattern, index } of ORDINAL_REFERENCE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { matched: true, index, phrase: match[0] };
    }
  }
  return { matched: false };
}

// ── Requirement extraction ─────────────────────────────────────────────

function extractMustInclude(text: string): string[] {
  const items: string[] = [];
  // First try: match from 必须 to sentence-ending punctuation
  const mustRe = /(?:必须|一定要)(?:让|要)?(.+?)(?:[。！!?？])/gu;
  let match;
  while ((match = mustRe.exec(text)) !== null) {
    const clause = match[1].trim();
    const parts = clause.split(/[，,；;、]+/).map(p => p.trim()).filter(p => p.length > 1);
    for (const part of parts) {
      const cleaned = part.replace(/^[并还且和又]+/, "").trim();
      if (cleaned.length > 1 && !items.includes(cleaned) && !/^(?:不要|不能|别|避免|禁止)/.test(cleaned)) {
        items.push(cleaned);
      }
    }
  }
  // Fallback: no sentence-ending punctuation — match to 不要/不能 boundary or end
  if (items.length === 0) {
    const fallbackRe = /(?:必须|一定要)(?:让|要)?(.+?)(?=(?:不要|不能|别|避免|禁止)|$)/gu;
    while ((match = fallbackRe.exec(text)) !== null) {
      const clause = match[1].trim();
      const parts = clause.split(/[，,；;、]+/).map(p => p.trim()).filter(p => p.length > 1);
      for (const part of parts) {
        const cleaned = part.replace(/^[并还且和又]+/, "").trim();
        if (cleaned.length > 1 && !items.includes(cleaned)) items.push(cleaned);
      }
    }
  }
  return items.slice(0, 8);
}

function extractMustAvoid(text: string): string[] {
  const items: string[] = [];
  const avoidRe = /(?:不要|不能|别|避免|禁止)(?:让|写)?(.{2,40}?)(?:[，。；,.]|$)/gu;
  let match;
  while ((match = avoidRe.exec(text)) !== null) {
    const item = match[1].trim();
    if (item.length > 1) items.push(item);
  }
  return items.slice(0, 5);
}

function extractCharacterFocus(text: string): string[] {
  const names: string[] = [];
  // Match name after 让/要让 — use non-greedy capture
  const re = /(?:要?让)([\u4e00-\u9fa5]{2,4}?)(?:主动|去找|找到|出现|登场|参与|直接|发起|被动|发起了)/gu;
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = match[1];
    if (name.length >= 2 && !names.includes(name)) names.push(name);
  }
  return names;
}

function extractPayoffRequests(text: string): string[] {
  const payoffRe = /(?:出现|来一个|来一次|要有).{0,4}(?:反转|爽点|高潮|揭秘|突破|反转)/gu;
  const items: string[] = [];
  let match;
  while ((match = payoffRe.exec(text)) !== null) {
    items.push(match[0].trim());
  }
  return items.slice(0, 3);
}

function extractDesiredTone(text: string): string[] {
  const toneRe = /(?:写得|风格|节奏|氛围).{0,4}(?:紧张|轻松|压抑|激烈|温暖|悲壮|幽默|快节奏|慢节奏)/gu;
  const items: string[] = [];
  let match;
  while ((match = toneRe.exec(text)) !== null) {
    items.push(match[0].trim());
  }
  return items.slice(0, 3);
}

// ── Public API ─────────────────────────────────────────────────────────

export function resolveContext(input: ContextResolverInput): ResolvedAssistantContext {
  const resolvedReferences: ResolvedReference[] = [];
  const recentArtifacts = input.recentArtifacts;

  // Detect direct references to previous analysis
  if (detectDirectReference(input.userText)) {
    // Find the most recent artifact
    const mostRecent = recentArtifacts.length > 0 ? recentArtifacts[0] : undefined;
    if (mostRecent) {
      resolvedReferences.push({
        phrase: "按你刚才说的",
        artifactId: mostRecent.artifactId,
        confidence: 0.85,
      });
    }
  }

  // Detect ordinal references (第二条建议, etc.)
  const ordinal = detectOrdinalReference(input.userText);
  if (ordinal.matched && ordinal.index !== undefined) {
    const mostRecent = recentArtifacts.length > 0 ? recentArtifacts[0] : undefined;
    if (mostRecent) {
      resolvedReferences.push({
        phrase: ordinal.phrase ?? "第N条",
        artifactId: mostRecent.artifactId,
        fieldPath: `nextChapterOpportunities[${ordinal.index}]`,
        confidence: 0.8,
      });
    }
  }

  // Extract user requirements
  const mustInclude = extractMustInclude(input.userText);
  const mustAvoid = extractMustAvoid(input.userText);
  const characterFocus = extractCharacterFocus(input.userText);
  const payoffRequests = extractPayoffRequests(input.userText);
  const desiredTone = extractDesiredTone(input.userText);

  const missingInfo: string[] = [];
  if (mustInclude.length === 0 && !detectDirectReference(input.userText)) {
    missingInfo.push("用户未明确指定 mustInclude");
  }

  return {
    resolvedReferences,
    extractedUserRequirements: {
      goals: [],
      mustInclude,
      mustAvoid,
      desiredTone,
      characterFocus,
      payoffRequests,
      endingHookRequests: [],
    },
    missingInformation: missingInfo,
  };
}
