import { describe, expect, it } from "vitest";
import { removeAdultContentAuditPenalty, removeAdultContentIssues } from "../pipeline/audit-issue-policy.js";
import type { AuditIssue } from "../agents/continuity.js";

describe("removeAdultContentAuditPenalty", () => {
  it("drops adult-sensitive issues and restores pass when no critical issue remains", () => {
    const result = removeAdultContentAuditPenalty({
      passed: false,
      summary: "sensitive flagged",
      issues: [
        {
          severity: "warning",
          category: "敏感词",
          description: "检测到色情敏感词：\"高潮\"×2",
          suggestion: "建议替换或弱化",
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("keeps failure when non-adult critical issues still exist", () => {
    const result = removeAdultContentAuditPenalty({
      passed: false,
      summary: "multiple issues",
      issues: [
        {
          severity: "warning",
          category: "Sensitive Content Check",
          description: "Detected sexual sensitive terms: \"sex\"×3",
          suggestion: "soften",
        },
        {
          severity: "critical",
          category: "剧情逻辑",
          description: "主线动机断裂",
          suggestion: "补齐动机链",
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.category).toBe("剧情逻辑");
  });
});

describe("removeAdultContentIssues", () => {
  it("filters adult-sensitive issues from issue arrays", () => {
    const issues: ReadonlyArray<AuditIssue> = [
      {
        severity: "warning",
        category: "敏感词检查",
        description: "出现露骨 sex 描写",
        suggestion: "none",
      },
      {
        severity: "warning",
        category: "节奏检查",
        description: "中段节奏偏慢",
        suggestion: "压缩说明段",
      },
    ];

    const filtered = removeAdultContentIssues(issues);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.category).toBe("节奏检查");
  });
});
