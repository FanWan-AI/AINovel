/**
 * Intent Router — classifies user input into structured intents for
 * the assistant pipeline.  Replaces the regex-only approach.
 *
 * P0: pure heuristic (no LLM call).  P2+ can swap in an LLM agent.
 */

import type { AssistantArtifactSummary } from "./assistant-artifact-service.js";

// ── Types ──────────────────────────────────────────────────────────────

export type AssistantIntentType =
  | "ask_plot_quality"
  | "plan_next_from_previous_analysis"
  | "write_next_with_user_plot"
  | "write_next_from_graph_change"
  | "critique_and_rewrite"
  | "query_story_graph"
  | "edit_story_graph"
  | "audit_chapter"
  | "revise_chapter"
  | "read_story_facts"
  | "clarify";

export interface IntentRouterInput {
  readonly sessionId: string;
  readonly userText: string;
  readonly selectedBookIds: ReadonlyArray<string>;
  readonly activeBookId?: string;
  readonly recentMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  readonly recentArtifacts: ReadonlyArray<AssistantArtifactSummary>;
  readonly currentPage?: string;
}

export interface IntentRouterOutput {
  readonly intentType: AssistantIntentType;
  readonly confidence: number;
  readonly referencedArtifactIds: ReadonlyArray<string>;
  readonly targetBookIds: ReadonlyArray<string>;
  readonly riskLevel: "low" | "medium" | "high";
  readonly clarificationQuestion?: string;
  readonly rationale: string;
}

// ── Keyword patterns ───────────────────────────────────────────────────

const PLOT_QUALITY_PATTERNS = [
  /剧情写?得.{0,6}(怎么样|如何|好不好)/,
  /(?:目前|现在)剧情.{0,6}(评价|分析|优缺点)/,
  /(?:写|写得|进展)得.{0,6}(怎样|如何)/,
  /质量如何/,
  /剧情.{0,4}(好|差|弱|烂|分析|评价)/,
  /how.{0,10}(going|doing|quality|review)/i,
];

const PLAN_NEXT_FROM_PREV_PATTERNS = [
  /按照?你(?:刚才|之前|上次).{0,6}(?:说|给).{0,6}(?:规划|计划|安排)/,
  /按(?:你|刚才|之前|上面).{0,6}(?:说|给|提).{0,6}(?:建议|方案|意见).{0,6}(?:规划|写|继续)/,
  /就按?你.{0,6}说.{0,6}(?:写|规划|继续)/,
  /照(?:这个|那个|刚才).{0,6}(?:方向|方案|思路).{0,6}(?:写|规划)/,
  /based on.{0,10}(what you|previous|above|last).{0,10}(plan|write|continue)/i,
  /(?:第二|2).{0,4}(?:条|个).{0,6}(?:建议|方案)/,
];

const WRITE_NEXT_PATTERNS = [
  /(?:写|续写|开始写).{0,4}(?:下一章|第.{1,3}章)/,
  /下一章.{0,6}(?:必须|要|应该|让)/,
  /write.{0,5}next.{0,5}chapter/i,
  /继续.{0,4}(?:写|创作)/,
];

const GRAPH_EDIT_PATTERNS = [
  /(?:图谱|graph).{0,4}(?:编辑|修改|改|变更)/,
  /(?:关系|人物).{0,4}(?:改成|改为|修改)/,
  /把.{0,20}(?:关系|设定).{0,4}(?:改成|改为|调整)/,
];

const AUDIT_PATTERNS = [
  /(?:审计|audit|检查).{0,4}(?:当前|本|这).{0,4}章/,
  /本章.{0,4}(?:质量|问题|错误)/,
];

const REVISE_PATTERNS = [
  /(?:修订|修改|重写).{0,4}(?:当前|本|这|第).{0,4}章/,
  /(?:revise|rewrite).{0,5}(?:this|current)/i,
];

// ── Detection ──────────────────────────────────────────────────────────

function hasRecentPlotCritique(artifacts: ReadonlyArray<AssistantArtifactSummary>): boolean {
  return artifacts.some((a) => a.type === "plot_critique");
}

function findLastPlotCritiqueArtifact(artifacts: ReadonlyArray<AssistantArtifactSummary>): string | undefined {
  return artifacts.find((a) => a.type === "plot_critique")?.artifactId;
}

function testAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ── Public API ─────────────────────────────────────────────────────────

export function routeAssistantIntent(input: IntentRouterInput): IntentRouterOutput {
  const text = input.userText.trim();
  const bookIds = input.selectedBookIds;
  const recentCritique = hasRecentPlotCritique(input.recentArtifacts);

  // 1. Plan next from previous analysis (指代)
  if (testAny(text, PLAN_NEXT_FROM_PREV_PATTERNS) && recentCritique) {
    const refId = findLastPlotCritiqueArtifact(input.recentArtifacts);
    return {
      intentType: "plan_next_from_previous_analysis",
      confidence: 0.9,
      referencedArtifactIds: refId ? [refId] : [],
      targetBookIds: [...bookIds],
      riskLevel: "medium",
      rationale: "用户引用了上一轮剧情分析来规划下一章",
    };
  }

  // 2. Ask plot quality
  if (testAny(text, PLOT_QUALITY_PATTERNS)) {
    return {
      intentType: "ask_plot_quality",
      confidence: 0.9,
      referencedArtifactIds: [],
      targetBookIds: [...bookIds],
      riskLevel: "low",
      rationale: "用户请求剧情质量分析",
    };
  }

  // 3. Write next with user constraints
  if (testAny(text, WRITE_NEXT_PATTERNS)) {
    // check if it's referencing a graph change
    if (testAny(text, GRAPH_EDIT_PATTERNS)) {
      return {
        intentType: "write_next_from_graph_change",
        confidence: 0.85,
        referencedArtifactIds: [],
        targetBookIds: [...bookIds],
        riskLevel: "high",
        rationale: "用户基于图谱变更写下一章",
      };
    }
    return {
      intentType: "write_next_with_user_plot",
      confidence: 0.85,
      referencedArtifactIds: [],
      targetBookIds: [...bookIds],
      riskLevel: "medium",
      rationale: "用户要求写下一章并带有剧情约束",
    };
  }

  // 4. Graph edit
  if (testAny(text, GRAPH_EDIT_PATTERNS)) {
    return {
      intentType: "edit_story_graph",
      confidence: 0.8,
      referencedArtifactIds: [],
      targetBookIds: [...bookIds],
      riskLevel: "high",
      rationale: "用户要求编辑叙事图谱",
    };
  }

  // 5. Audit
  if (testAny(text, AUDIT_PATTERNS)) {
    return {
      intentType: "audit_chapter",
      confidence: 0.8,
      referencedArtifactIds: [],
      targetBookIds: [...bookIds],
      riskLevel: "low",
      rationale: "用户请求审计当前章节",
    };
  }

  // 6. Revise
  if (testAny(text, REVISE_PATTERNS)) {
    return {
      intentType: "revise_chapter",
      confidence: 0.8,
      referencedArtifactIds: [],
      targetBookIds: [...bookIds],
      riskLevel: "medium",
      rationale: "用户请求修订当前章节",
    };
  }

  // 7. Plan next from previous (no plot quality keyword, but referencing previous)
  if (recentCritique && /下一章|规划|计划/.test(text)) {
    const refId = findLastPlotCritiqueArtifact(input.recentArtifacts);
    return {
      intentType: "plan_next_from_previous_analysis",
      confidence: 0.7,
      referencedArtifactIds: refId ? [refId] : [],
      targetBookIds: [...bookIds],
      riskLevel: "medium",
      rationale: "有最近的剧情分析 artifact，用户提到下一章，推测为承接分析规划",
    };
  }

  // 8. Fallback
  return {
    intentType: "clarify",
    confidence: 0.3,
    referencedArtifactIds: [],
    targetBookIds: [...bookIds],
    riskLevel: "low",
    clarificationQuestion: "我不太确定你的意图。你是想分析剧情、写下一章、还是做其他操作？",
    rationale: "无法匹配到已知意图模式",
  };
}
