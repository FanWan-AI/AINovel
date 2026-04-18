export interface ReleaseGateTextSource {
  readonly source: string;
  readonly content: string;
}

export interface ReleaseGateSecurityFinding {
  readonly ruleId: string;
  readonly source: string;
  readonly excerpt: string;
  readonly description: string;
}

export interface ReleaseGateCheckResult {
  readonly gateId: "quality" | "consistency" | "security" | "manual_confirmation";
  readonly label: string;
  readonly passed: boolean;
  readonly blocking: boolean;
  readonly reason: string | null;
}

export interface ReleaseCandidateCheckpoint {
  readonly stage: "release-candidate";
  readonly requiredApproval: boolean;
  readonly status: "pending" | "approved";
  readonly reason: string;
}

export interface ReleaseCandidateEvaluation {
  readonly bookId: string;
  readonly isReleaseCandidate: boolean;
  readonly eligible: boolean;
  readonly publishQualityGate: number;
  readonly overallScore: number;
  readonly autopilotLevel: string;
  readonly gates: ReadonlyArray<ReleaseGateCheckResult>;
  readonly blockingReasons: ReadonlyArray<string>;
  readonly consistencyBlockingIssues: ReadonlyArray<string>;
  readonly securityFindings: ReadonlyArray<ReleaseGateSecurityFinding>;
  readonly checkpoint: ReleaseCandidateCheckpoint;
}

export interface EvaluateReleaseCandidateInput {
  readonly bookId: string;
  readonly isReleaseCandidate: boolean;
  readonly publishQualityGate: number;
  readonly overallScore: number;
  readonly consistencyBlockingIssues: ReadonlyArray<string>;
  readonly securityFindings: ReadonlyArray<ReleaseGateSecurityFinding>;
  readonly manualConfirmed: boolean;
  readonly autopilotLevel: string;
}

interface ReleaseGateSecurityRule {
  readonly ruleId: string;
  readonly pattern: RegExp;
  readonly description: string;
}

const RELEASE_GATE_SECURITY_RULES: ReadonlyArray<ReleaseGateSecurityRule> = [
  {
    ruleId: "dangerous-instruction",
    pattern: /恐怖袭击教程|制毒教程|枪支制作教程|炸药制作教程/iu,
    description: "发现疑似危险违法教程内容，需要先通过安全审计复核。",
  },
  {
    ruleId: "abusive-content",
    pattern: /儿童色情|极端主义宣传|仇恨煽动|种族灭绝宣言/iu,
    description: "发现疑似违规敏感内容，需要先通过安全审计复核。",
  },
];
const RELEASE_GATE_EXCERPT_CONTEXT_LENGTH = 24;

function trimExcerpt(content: string, index: number, length: number): string {
  const start = Math.max(0, index - RELEASE_GATE_EXCERPT_CONTEXT_LENGTH);
  const end = Math.min(content.length, index + length + RELEASE_GATE_EXCERPT_CONTEXT_LENGTH);
  return content.slice(start, end).replace(/\s+/gu, " ").trim();
}

export function shouldSkipReleaseGateManualConfirmation(autopilotLevel: string): boolean {
  return autopilotLevel === "autopilot" || autopilotLevel === "L3";
}

export function scanReleaseGateSecuritySources(
  sources: ReadonlyArray<ReleaseGateTextSource>,
): ReadonlyArray<ReleaseGateSecurityFinding> {
  const findings: ReleaseGateSecurityFinding[] = [];
  for (const source of sources) {
    for (const rule of RELEASE_GATE_SECURITY_RULES) {
      const match = rule.pattern.exec(source.content);
      if (!match || typeof match.index !== "number") {
        continue;
      }
      findings.push({
        ruleId: rule.ruleId,
        source: source.source,
        excerpt: trimExcerpt(source.content, match.index, match[0].length),
        description: rule.description,
      });
    }
  }
  return findings;
}

export function evaluateReleaseCandidate(
  input: EvaluateReleaseCandidateInput,
): ReleaseCandidateEvaluation {
  const qualityPassed = input.overallScore >= input.publishQualityGate;
  const consistencyPassed = input.consistencyBlockingIssues.length === 0;
  const securityPassed = input.securityFindings.length === 0;
  const manualPassed = input.manualConfirmed || shouldSkipReleaseGateManualConfirmation(input.autopilotLevel);

  const gates: ReleaseGateCheckResult[] = [
    {
      gateId: "quality",
      label: "质量分",
      passed: qualityPassed,
      blocking: true,
      reason: qualityPassed
        ? `全书质量分 ${input.overallScore} 已达到发布阈值 ${input.publishQualityGate}。`
        : `全书质量分 ${input.overallScore} 未达到发布阈值 ${input.publishQualityGate}。`,
    },
    {
      gateId: "consistency",
      label: "全书一致性",
      passed: consistencyPassed,
      blocking: true,
      reason: consistencyPassed
        ? "全书一致性检查未发现阻断问题。"
        : input.consistencyBlockingIssues[0] ?? "全书一致性检查存在阻断问题。",
    },
    {
      gateId: "security",
      label: "安全审计",
      passed: securityPassed,
      blocking: true,
      reason: securityPassed
        ? "安全审计通过，未发现敏感违规内容。"
        : `${input.securityFindings[0]?.description ?? "安全审计未通过。"}（${input.securityFindings[0]?.source ?? "unknown"}）`,
    },
    {
      gateId: "manual_confirmation",
      label: "人工确认",
      passed: manualPassed,
      blocking: true,
      reason: manualPassed
        ? (
          shouldSkipReleaseGateManualConfirmation(input.autopilotLevel)
            ? "当前策略为 autopilot/L3，发布候选阶段允许跳过人工通读确认。"
            : "已确认完成至少一次人工通读。"
        )
        : "尚未确认已完成人工通读。",
    },
  ];

  const blockingReasons = gates
    .filter((gate) => gate.blocking && !gate.passed && gate.reason)
    .map((gate) => gate.reason as string);

  return {
    bookId: input.bookId,
    isReleaseCandidate: input.isReleaseCandidate,
    eligible: blockingReasons.length === 0,
    publishQualityGate: input.publishQualityGate,
    overallScore: input.overallScore,
    autopilotLevel: input.autopilotLevel,
    gates,
    blockingReasons,
    consistencyBlockingIssues: [...input.consistencyBlockingIssues],
    securityFindings: [...input.securityFindings],
    checkpoint: {
      stage: "release-candidate",
      requiredApproval: true,
      status: manualPassed ? "approved" : "pending",
      reason: manualPassed
        ? "发布候选阶段 checkpoint 已满足人工确认门禁。"
        : "发布候选阶段 checkpoint 等待人工确认。",
    },
  };
}
