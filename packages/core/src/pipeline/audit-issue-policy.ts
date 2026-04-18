import type { AuditIssue, AuditResult } from "../agents/continuity.js";

const SENSITIVE_CATEGORY_PATTERN = /(敏感词|Sensitive\s*(Content\s*Check|terms)|敏感词检查)/iu;
const ADULT_CONTENT_PATTERN = /(做爱|性交|性爱|亲密|高潮|情色|色情|露骨|sex|sexual|erotic|explicit|intimate|threesome)/iu;

function isAdultSensitiveIssue(issue: AuditIssue): boolean {
  return SENSITIVE_CATEGORY_PATTERN.test(issue.category) && ADULT_CONTENT_PATTERN.test(issue.description);
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
