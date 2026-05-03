/**
 * Plot Critique Service — generates structured PlotCritiqueArtifact
 * by analyzing chapter content and truth files.
 *
 * P0: pure heuristic analysis.  P2+ can swap in LLM agent.
 */

import type { AssistantArtifactType } from "./assistant-artifact-service.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface PlotCritiqueInput {
  readonly bookId: string;
  readonly chapterRange: { from: number; to: number };
  readonly chapters: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly content: string;
    readonly wordCount: number;
  }>;
  readonly truthFiles: ReadonlyArray<{ name: string; content: string }>;
  readonly focus?: string;
}

export interface NextChapterOpportunity {
  readonly title: string;
  readonly why: string;
  readonly mustInclude: ReadonlyArray<string>;
  readonly risk: string;
  readonly payoff: string;
}

export interface PlotCritiquePayload {
  readonly artifactId: string;
  readonly type: "plot_critique";
  readonly bookId: string;
  readonly chapterRange: { from: number; to: number };
  readonly strengths: ReadonlyArray<string>;
  readonly weaknesses: ReadonlyArray<string>;
  readonly stalePatterns: ReadonlyArray<string>;
  readonly readerPromises: ReadonlyArray<string>;
  readonly missedPayoffs: ReadonlyArray<string>;
  readonly nextChapterOpportunities: ReadonlyArray<NextChapterOpportunity>;
  readonly evidence: ReadonlyArray<{ source: string; excerpt: string; reason: string }>;
}

// ── Heuristic analysis ────────────────────────────────────────────────

const STALE_PATTERNS = [
  { pattern: /(?:冷静分析|仔细思考|在心里)/g, label: "过度内心分析" },
  { pattern: /(?:发现线索|察觉异常|注意到)/g, label: "被动发现线索" },
  { pattern: /(?:暂时先|暂且|稍后再说)/g, label: "推延行动" },
  { pattern: /(?:记录下来|记住|备注)/g, label: "记录而非行动" },
  { pattern: /(?:留待后续|以后再说|改天)/g, label: "留待后续处理" },
];

const ACTIVE_PATTERNS = [
  { pattern: /(?:直接|主动|毅然|果断)/g, label: "主动行为" },
  { pattern: /(?:冲突|对抗|争执|对峙)/g, label: "冲突场面" },
  { pattern: /(?:反转|意外|出乎意料|转折)/g, label: "反转/意外" },
  { pattern: /(?:爽|痛快|解气|大快人心)/g, label: "爽点兑现" },
  { pattern: /(?:代价|牺牲|损失|代价)/g, label: "代价/代价意识" },
];

function countMatches(text: string, patterns: ReadonlyArray<{ pattern: RegExp; label: string }>): Array<{ label: string; count: number }> {
  const results: Array<{ label: string; count: number }> = [];
  for (const { pattern, label } of patterns) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      results.push({ label, count: matches.length });
    }
  }
  return results;
}

function analyzeChapter(chapter: PlotCritiqueInput["chapters"][number]): {
  stale: Array<{ label: string; count: number }>;
  active: Array<{ label: string; count: number }>;
} {
  const stale = countMatches(chapter.content, STALE_PATTERNS);
  const active = countMatches(chapter.content, ACTIVE_PATTERNS);
  return { stale, active };
}

// ── Public API ─────────────────────────────────────────────────────────

export function generatePlotCritique(input: PlotCritiqueInput): PlotCritiquePayload {
  const chapterAnalyses = input.chapters.map((ch) => ({
    chapter: ch.number,
    ...analyzeChapter(ch),
  }));

  // Aggregate stale patterns
  const staleLabels = new Map<string, number>();
  for (const analysis of chapterAnalyses) {
    for (const { label, count } of analysis.stale) {
      staleLabels.set(label, (staleLabels.get(label) ?? 0) + count);
    }
  }

  // Aggregate active patterns (strengths)
  const activeLabels = new Map<string, number>();
  for (const analysis of chapterAnalyses) {
    for (const { label, count } of analysis.active) {
      activeLabels.set(label, (activeLabels.get(label) ?? 0) + count);
    }
  }

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  // Build strengths from active patterns
  for (const [label, count] of activeLabels) {
    if (count > 0) {
      strengths.push(`有 ${count} 处「${label}」表现`);
    }
  }

  // Build weaknesses from stale patterns
  const stalePatterns: string[] = [];
  for (const [label, count] of staleLabels) {
    if (count > 0) {
      weaknesses.push(`出现 ${count} 处「${label}」，影响节奏`);
      stalePatterns.push(label);
    }
  }

  // Check for passive protagonist
  const passiveCount = chapterAnalyses.reduce(
    (sum, a) => sum + a.stale.reduce((s, x) => s + x.count, 0),
    0,
  );
  const activeCount = chapterAnalyses.reduce(
    (sum, a) => sum + a.active.reduce((s, x) => s + x.count, 0),
    0,
  );
  if (passiveCount > activeCount * 2) {
    weaknesses.push("主角主动性不足，分析/推延多于行动/对抗");
  }

  // Generate next chapter opportunities
  const opportunities: NextChapterOpportunity[] = [];

  if (passiveCount > 0) {
    opportunities.push({
      title: "主角主动出击",
      why: "近期章节主角被动分析过多，需要一次主动选择或对抗来打破节奏",
      mustInclude: ["主角做出主动选择", "面对直接阻力"],
      risk: "强行转折可能显得突兀",
      payoff: "读者期待主角打破被动局面，产生爽感",
    });
  }

  if (staleLabels.has("推延行动")) {
    opportunities.push({
      title: "兑现延迟的承诺",
      why: "多处剧情被推延，读者期待逐渐消退",
      mustInclude: ["至少兑现一个此前搁置的剧情承诺"],
      risk: "同时兑现太多会显得赶进度",
      payoff: "满足读者期待，建立信任",
    });
  }

  if (opportunities.length === 0) {
    opportunities.push({
      title: "增加戏剧张力",
      why: "当前分析未发现严重问题，可增加主动冲突和反转来提升戏剧性",
      mustInclude: ["新的信息差或冲突"],
      risk: "增加元素可能导致章内信息过载",
      payoff: "保持读者注意力和兴趣",
    });
  }

  // Evidence
  const evidence = input.chapters.slice(-3).map((ch) => ({
    source: `章节 ${ch.number}: ${ch.title}`,
    excerpt: ch.content.slice(0, 200),
    reason: "最近章节片段用于分析",
  }));

  const summary = strengths.length > 0 || weaknesses.length > 0
    ? `剧情分析：${strengths.length} 个优势，${weaknesses.length} 个问题。${opportunities.length} 个下一章机会。`
    : "剧情分析：数据不足，需要更多章节内容。";

  return {
    artifactId: "", // will be assigned by artifact service
    type: "plot_critique",
    bookId: input.bookId,
    chapterRange: input.chapterRange,
    strengths: strengths.length > 0 ? strengths : ["暂无明显优势或数据不足"],
    weaknesses: weaknesses.length > 0 ? weaknesses : ["暂无明显问题"],
    stalePatterns,
    readerPromises: [],
    missedPayoffs: [],
    nextChapterOpportunities: opportunities,
    evidence,
  };
}
