import type { AuditIssue, AuditResult } from "../agents/continuity.js";

const SENSITIVE_CATEGORY_PATTERN = /(敏感词|Sensitive\s*(Content\s*Check|terms)|敏感词检查)/iu;
// Extended to cover Chinese terms the LLM may use when describing explicit/adult content
// in categories other than "敏感词检查" (e.g. "文风检查", "读者期待管理").
const ADULT_CONTENT_PATTERN = /(做爱|性交|性爱|亲密|高潮|情色|色情|露骨|情欲|肉戏|床戏|性描写|情爱|肉欲|色欲|淫|sex|sexual|erotic|explicit|intimate|threesome|adult\s*content)/iu;

function isAdultSensitiveIssue(issue: AuditIssue): boolean {
  const descAndSuggestion = `${issue.description} ${issue.suggestion ?? ""}`;
  // Category-matched sensitive-word issues (original check — kept for backwards compat)
  if (SENSITIVE_CATEGORY_PATTERN.test(issue.category) && ADULT_CONTENT_PATTERN.test(descAndSuggestion)) {
    return true;
  }
  // LLM-generated issues in any category that explicitly flag adult/explicit content
  // (e.g. "文风检查: 情欲描写过多", "读者期待管理: 过多性爱描写").
  // We filter these because adult content is intentional in books that contain it.
  if (ADULT_CONTENT_PATTERN.test(descAndSuggestion)) {
    return true;
  }
  return false;
}

export function removeAdultContentAuditPenalty(result: AuditResult): AuditResult {
  const filteredIssues = result.issues.filter((issue) => !isAdultSensitiveIssue(issue));
  const removedCount = result.issues.length - filteredIssues.length;
  if (removedCount === 0) {
    return result;
  }

  const hasCriticalIssue = filteredIssues.some((issue) => issue.severity === "critical");
  return {
    ...result,
    passed: hasCriticalIssue ? false : true,
    issues: filteredIssues,
  };
}

export function removeAdultContentIssues(issues: ReadonlyArray<AuditIssue>): ReadonlyArray<AuditIssue> {
  return issues.filter((issue) => !isAdultSensitiveIssue(issue));
}
