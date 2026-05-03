/**
 * Contract Verifier — checks whether a written chapter satisfies
 * the ChapterSteeringContract requirements.
 *
 * P0: keyword-based heuristic.  P2+ can swap in LLM agent.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ContractVerificationItem {
  readonly requirement: string;
  readonly status: "satisfied" | "partial" | "missing";
  readonly evidence?: string;
  readonly reason: string;
}

export interface ContractVerificationReport {
  readonly satisfactionRate: number;
  readonly items: ReadonlyArray<ContractVerificationItem>;
  readonly shouldRewrite: boolean;
}

export interface VerifyContractInput {
  readonly chapterText: string;
  readonly mustInclude: ReadonlyArray<string>;
  readonly mustAvoid: ReadonlyArray<string>;
  readonly sceneBeats: ReadonlyArray<string>;
  readonly goal?: string;
}

// ── Matching ───────────────────────────────────────────────────────────

function extractKeywords(phrase: string): string[] {
  // Extract meaningful tokens — split on punctuation/space for mixed text
  const tokens = phrase
    .replace(/[，。；,.！!?？\s、（）()]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
  if (tokens.length > 1) return tokens;
  // For single long Chinese tokens, extract 2-3 char sub-grams
  const source = tokens[0] ?? phrase;
  if (source.length <= 3) return [source];
  const grams: string[] = [source];
  for (let len = 2; len <= 4 && len < source.length; len++) {
    for (let i = 0; i <= source.length - len; i++) {
      grams.push(source.slice(i, i + len));
    }
  }
  // Deduplicate and prefer longer/more specific grams
  return [...new Set(grams)].filter((g) => g.length >= 2);
}

function checkPresence(chapterText: string, phrase: string): {
  found: boolean;
  evidence?: string;
  coverage: number;
} {
  // First check exact match
  const exactIdx = chapterText.indexOf(phrase);
  if (exactIdx !== -1) {
    const start = Math.max(0, exactIdx - 20);
    const end = Math.min(chapterText.length, exactIdx + phrase.length + 20);
    return {
      found: true,
      evidence: chapterText.slice(start, end),
      coverage: 1,
    };
  }

  // Fallback: keyword/gram matching
  const keywords = extractKeywords(phrase);
  const lowerText = chapterText.toLowerCase();
  let foundCount = 0;
  const evidenceSnippets: string[] = [];

  for (const kw of keywords) {
    const idx = lowerText.indexOf(kw.toLowerCase());
    if (idx !== -1) {
      foundCount++;
      const start = Math.max(0, idx - 20);
      const end = Math.min(chapterText.length, idx + kw.length + 20);
      evidenceSnippets.push(chapterText.slice(start, end));
    }
  }

  // For n-gram approach: success if we find enough overlapping grams
  const coverage = keywords.length > 0 ? foundCount / keywords.length : 0;
  return {
    found: coverage >= 0.3,
    evidence: evidenceSnippets.length > 0 ? evidenceSnippets[0] : undefined,
    coverage,
  };
}

function checkAbsence(chapterText: string, phrase: string): {
  violated: boolean;
  evidence?: string;
} {
  const result = checkPresence(chapterText, phrase);
  return {
    violated: result.found,
    evidence: result.evidence,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export function verifyContractSatisfaction(input: VerifyContractInput): ContractVerificationReport {
  const items: ContractVerificationItem[] = [];

  // Hard requirement counters — mustInclude + mustAvoid only.
  // satisfactionRate is computed from hard requirements so that soft sceneBeats
  // (e.g. critique suggestions) never drag the score below the threshold.
  let hardSatisfied = 0;
  let hardTotal = 0;

  // Check mustInclude (hard requirements)
  for (const req of input.mustInclude) {
    hardTotal++;
    const result = checkPresence(input.chapterText, req);
    if (result.coverage >= 0.9) {
      hardSatisfied++;
      items.push({
        requirement: `必须包含: ${req}`,
        status: "satisfied",
        evidence: result.evidence,
        reason: `关键词匹配率 ${(result.coverage * 100).toFixed(0)}%`,
      });
    } else if (result.coverage >= 0.5) {
      hardSatisfied += 0.5;
      items.push({
        requirement: `必须包含: ${req}`,
        status: "partial",
        evidence: result.evidence,
        reason: `部分关键词匹配率 ${(result.coverage * 100).toFixed(0)}%，可能体现不足`,
      });
    } else {
      items.push({
        requirement: `必须包含: ${req}`,
        status: "missing",
        reason: `未找到足够相关证据，匹配率 ${(result.coverage * 100).toFixed(0)}%`,
      });
    }
  }

  // Check mustAvoid (hard requirements)
  for (const req of input.mustAvoid) {
    hardTotal++;
    const result = checkAbsence(input.chapterText, req);
    if (!result.violated) {
      hardSatisfied++;
      items.push({
        requirement: `必须避免: ${req}`,
        status: "satisfied",
        reason: "正文中未发现相关禁忌内容",
      });
    } else {
      items.push({
        requirement: `必须避免: ${req}`,
        status: "missing",
        evidence: result.evidence,
        reason: "正文中发现了禁忌内容",
      });
    }
  }

  // Check scene beats (soft guidance — tracked in items but excluded from satisfactionRate).
  // This prevents soft/diagnostic beats from diluting the hard-requirement satisfaction score.
  for (const beat of input.sceneBeats) {
    const result = checkPresence(input.chapterText, beat);
    if (result.coverage >= 0.5) {
      items.push({
        requirement: `场景节拍: ${beat}`,
        status: "satisfied",
        evidence: result.evidence,
        reason: `节拍关键词匹配率 ${(result.coverage * 100).toFixed(0)}%`,
      });
    } else if (result.coverage > 0) {
      items.push({
        requirement: `场景节拍: ${beat}`,
        status: "partial",
        evidence: result.evidence,
        reason: `部分匹配率 ${(result.coverage * 100).toFixed(0)}%`,
      });
    } else {
      items.push({
        requirement: `场景节拍: ${beat}`,
        status: "missing",
        reason: "未找到该场景节拍的相关内容",
      });
    }
  }

  // satisfactionRate is based on hard requirements only; defaults to 1.0 when none exist
  const satisfactionRate = hardTotal > 0 ? hardSatisfied / hardTotal : 1;
  const shouldRewrite = satisfactionRate < 0.7 && hardTotal > 0;

  return {
    satisfactionRate: Math.round(satisfactionRate * 100) / 100,
    items,
    shouldRewrite,
  };
}
