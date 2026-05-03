/**
 * Developmental Editor (P5) — scores chapter quality across multiple dimensions.
 * Heuristic implementation; P5+ can swap in LLM agent.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface DevelopmentalEditDimensions {
  readonly conflict: number;
  readonly agency: number;
  readonly payoff: number;
  readonly relationshipMovement: number;
  readonly hook: number;
  readonly proseFreshness: number;
  readonly contractSatisfaction: number;
}

export interface DevelopmentalEditReport {
  readonly overallScore: number;
  readonly dimensions: DevelopmentalEditDimensions;
  readonly blockingIssues: ReadonlyArray<string>;
  readonly rewriteAdvice: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<{ source: string; excerpt: string; reason: string }>;
}

export interface DevelopmentalEditorInput {
  readonly chapterText: string;
  readonly chapterNumber: number;
  readonly steeringContract?: {
    readonly mustInclude: ReadonlyArray<string>;
    readonly mustAvoid: ReadonlyArray<string>;
  };
}

// ── Patterns ───────────────────────────────────────────────────────────

const CONFLICT_PATTERNS = [
  { re: /(?:冲突|对抗|争执|对峙|争吵|逼问|质问|反驳)/g, label: "直接冲突" },
  { re: /(?:威胁|警告|拒绝|反对|不信任|怀疑)/g, label: "对立情绪" },
  { re: /(?:选择|决定|抉择|决断|下定决心)/g, label: "艰难选择" },
];

const AGENCY_PATTERNS = [
  { re: /(?:主动|毅然|果断|直接|毫不犹豫|率先)/g, label: "主动行为" },
  { re: /(?:亲自|自己|独立|独自)/g, label: "独立行动" },
  { re: /(?:决定|选择|出手|行动|出击)/g, label: "决策行为" },
];

const PASSIVE_PATTERNS = [
  { re: /(?:冷静分析|仔细思考|在心里|默默|沉思)/g, label: "过度内省" },
  { re: /(?:暂时先|暂且|稍后|留待|以后再说)/g, label: "推延行动" },
  { re: /(?:观察|看着|注意到|察觉到|发现)/g, label: "被动观察" },
];

const PAYOFF_PATTERNS = [
  { re: /(?:反转|意外|出乎意料|没想到|震惊)/g, label: "反转" },
  { re: /(?:爽|痛快|解气|大快人心|碾压)/g, label: "爽感释放" },
  { re: /(?:代价|牺牲|损失|代价|受伤)/g, label: "代价意识" },
];

const AI_TELL_PATTERNS = [
  { re: /像/g, label: "像" },
  { re: /仿佛/g, label: "仿佛" },
  { re: /宛如/g, label: "宛如" },
  { re: /犹如/g, label: "犹如" },
  { re: /似乎/g, label: "似乎" },
];

// ── Scoring ────────────────────────────────────────────────────────────

function countMatches(text: string, patterns: ReadonlyArray<{ re: RegExp; label: string }>): number {
  let total = 0;
  for (const { re } of patterns) {
    const m = text.match(re);
    if (m) total += m.length;
  }
  return total;
}

function scoreFromRatio(positive: number, negative: number, maxScore = 10): number {
  if (positive + negative === 0) return 5;
  const ratio = positive / (positive + negative);
  return Math.round(ratio * maxScore * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Public API ─────────────────────────────────────────────────────────

export function evaluateChapterDrama(input: DevelopmentalEditorInput): DevelopmentalEditReport {
  const { chapterText, steeringContract } = input;

  const textLen = chapterText.length;
  const normalizedLen = clamp(textLen / 3000, 0.5, 1.5); // 3000字为基准

  // Conflict
  const conflictHits = countMatches(chapterText, CONFLICT_PATTERNS);
  const conflict = clamp(Math.round((conflictHits / Math.max(1, normalizedLen)) * 2) / 2, 0, 10);

  // Agency vs Passive
  const agencyHits = countMatches(chapterText, AGENCY_PATTERNS);
  const passiveHits = countMatches(chapterText, PASSIVE_PATTERNS);
  const agency = scoreFromRatio(agencyHits, passiveHits, 10);

  // Payoff
  const payoffHits = countMatches(chapterText, PAYOFF_PATTERNS);
  const payoff = clamp(Math.round((payoffHits / Math.max(1, normalizedLen)) * 3) / 2, 0, 10);

  // Prose freshness (inverse of AI tells)
  const aiTellHits = countMatches(chapterText, AI_TELL_PATTERNS);
  const aiTellDensity = aiTellHits / Math.max(1, textLen / 500);
  const proseFreshness = clamp(Math.round((10 - aiTellDensity * 3) * 10) / 10, 0, 10);

  // Relationship movement
  const relationshipMovement = clamp(conflict * 0.5 + agency * 0.5, 0, 10);

  // Hook
  const hook = clamp(payoff * 0.6 + conflict * 0.4, 0, 10);

  // Contract satisfaction
  let contractSatisfaction = 10;
  const blockingIssues: string[] = [];
  if (steeringContract) {
    let satisfied = 0;
    let total = steeringContract.mustInclude.length + steeringContract.mustAvoid.length;
    for (const req of steeringContract.mustInclude) {
      if (chapterText.includes(req)) {
        satisfied++;
      } else {
        blockingIssues.push(`未满足 mustInclude: "${req}"`);
      }
    }
    for (const req of steeringContract.mustAvoid) {
      if (!chapterText.includes(req)) {
        satisfied++;
      } else {
        blockingIssues.push(`违反 mustAvoid: "${req}"`);
      }
    }
    contractSatisfaction = total > 0 ? Math.round((satisfied / total) * 100) / 10 : 10;
  }

  // Rewrite advice
  const rewriteAdvice: string[] = [];
  if (conflict < 4) rewriteAdvice.push("增加直接冲突和对抗场景");
  if (agency < 4) rewriteAdvice.push("减少被动观察/分析，增加主角主动行为");
  if (payoff < 3) rewriteAdvice.push("增加反转或爽点释放");
  if (proseFreshness < 5) rewriteAdvice.push("减少像/仿佛/宛如等AI痕迹词汇");
  if (contractSatisfaction < 8) rewriteAdvice.push("必须满足用户指定的 mustInclude/mustAvoid");

  const dimensions: DevelopmentalEditDimensions = {
    conflict,
    agency,
    payoff,
    relationshipMovement,
    hook,
    proseFreshness,
    contractSatisfaction,
  };

  const overallScore = Math.round(
    (conflict * 0.15 + agency * 0.15 + payoff * 0.15 + relationshipMovement * 0.10
      + hook * 0.10 + proseFreshness * 0.05 + contractSatisfaction * 0.30) * 10
  ) / 10;

  const evidence = [
    { source: "冲突检测", excerpt: `发现 ${conflictHits} 处冲突模式`, reason: `冲突评分: ${conflict}` },
    { source: "主动性检测", excerpt: `主动: ${agencyHits}, 被动: ${passiveHits}`, reason: `主动性评分: ${agency}` },
    { source: "AI痕迹检测", excerpt: `发现 ${aiTellHits} 处像/仿佛/宛如`, reason: `文笔鲜活度: ${proseFreshness}` },
  ];

  return {
    overallScore,
    dimensions,
    blockingIssues,
    rewriteAdvice,
    evidence,
  };
}
