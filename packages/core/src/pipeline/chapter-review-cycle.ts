import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import { removeAdultContentAuditPenalty } from "./audit-issue-policy.js";
import type { ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditNormalizedWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly normalizeApplied: boolean;
  readonly lengthNormalizationSnapshots: ReadonlyArray<{
    readonly stage: "pre-audit" | "post-revision";
    readonly mode: "compress" | "expand";
    readonly beforeContent: string;
    readonly afterContent: string;
    readonly beforeCount: number;
    readonly afterCount: number;
    readonly applied: boolean;
    readonly rejectedReason?: string;
  }>;
  readonly reviewSnapshots: ReadonlyArray<{
    readonly stage: "writer-output" | "pre-audit";
    readonly content: string;
    readonly wordCount: number;
  }>;
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode: "spot-fix",
      genre?: string,
      options?: {
        chapterIntent?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: {
        temperature?: number;
        chapterIntent?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
      },
    ) => Promise<AuditResult>;
  };
  readonly normalizeDraftLengthIfNeeded: (chapterContent: string) => Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    snapshot?: {
      readonly stage: "pre-audit" | "post-revision";
      readonly mode: "compress" | "expand";
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly beforeCount: number;
      readonly afterCount: number;
      readonly applied: boolean;
      readonly rejectedReason?: string;
    };
    tokenUsage?: ChapterReviewCycleUsage;
  }>;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly restoreLostAuditIssues: (previous: AuditResult, next: AuditResult) => AuditResult;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => {
    found: ReadonlyArray<{ severity: string }>;
    issues: ReadonlyArray<AuditIssue>;
  };
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let postReviseCount = 0;
  let normalizeApplied = false;
  let finalContent = params.initialOutput.content;
  let finalWordCount = params.initialOutput.wordCount;
  let revised = false;
  const lengthNormalizationSnapshots: ChapterReviewCycleResult["lengthNormalizationSnapshots"] extends ReadonlyArray<infer T> ? T[] : never[] = [];
  const reviewSnapshots: ChapterReviewCycleResult["reviewSnapshots"] extends ReadonlyArray<infer T> ? T[] : never[] = [{
    stage: "writer-output",
    content: finalContent,
    wordCount: finalWordCount,
  }];

  if (params.initialOutput.postWriteErrors.length > 0) {
    params.logWarn({
      zh: `检测到 ${params.initialOutput.postWriteErrors.length} 个后写错误，审计前触发 spot-fix 修补`,
      en: `${params.initialOutput.postWriteErrors.length} post-write errors detected, triggering spot-fix before audit`,
    });
    const reviser = params.createReviser();
    const spotFixIssues = params.initialOutput.postWriteErrors.map((violation) => ({
      severity: "critical" as const,
      category: violation.rule,
      description: violation.description,
      suggestion: violation.suggestion,
    }));
    const fixResult = await reviser.reviseChapter(
      params.bookDir,
      finalContent,
      params.chapterNumber,
      spotFixIssues,
      "spot-fix",
      params.book.genre,
      {
        ...params.reducedControlInput,
        lengthSpec: params.lengthSpec,
      },
    );
    totalUsage = params.addUsage(totalUsage, fixResult.tokenUsage);
    if (fixResult.revisedContent.length > 0) {
      finalContent = fixResult.revisedContent;
      finalWordCount = fixResult.wordCount;
      revised = true;
    }
  }

  const normalizedBeforeAudit = await params.normalizeDraftLengthIfNeeded(finalContent);
  totalUsage = params.addUsage(totalUsage, normalizedBeforeAudit.tokenUsage);
  if (normalizedBeforeAudit.snapshot) {
    lengthNormalizationSnapshots.push({ ...normalizedBeforeAudit.snapshot, stage: "pre-audit" });
  }
  finalContent = normalizedBeforeAudit.content;
  finalWordCount = normalizedBeforeAudit.wordCount;
  normalizeApplied = normalizeApplied || normalizedBeforeAudit.applied;
  params.assertChapterContentNotEmpty(finalContent, "draft generation");
  reviewSnapshots.push({
    stage: "pre-audit",
    content: finalContent,
    wordCount: finalWordCount,
  });

  params.logStage({
    zh: "审计草稿：检查连续性、人设、伏笔、爽点兑现、AI痕迹与平台硬风险；成人男频情欲内容本身不作为扣分项",
    en: "auditing draft: checking continuity, character logic, hooks, payoff, AI tells and hard platform risk; adult genre content itself is not penalized",
  });
  const rawLlmAudit = await params.auditor.auditChapter(
    params.bookDir,
    finalContent,
    params.chapterNumber,
    params.book.genre,
    params.reducedControlInput,
  );
  const llmAudit = removeAdultContentAuditPenalty(rawLlmAudit);
  totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
  const aiTellsResult = params.analyzeAITells(finalContent);
  const sensitiveWriteResult = params.analyzeSensitiveWords(finalContent);
  const hasBlockedWriteWords = sensitiveWriteResult.found.some((item) => item.severity === "block");
  let auditResult: AuditResult = removeAdultContentAuditPenalty({
    passed: hasBlockedWriteWords ? false : llmAudit.passed,
    issues: [...llmAudit.issues, ...aiTellsResult.issues, ...sensitiveWriteResult.issues],
    summary: llmAudit.summary,
  });

  if (!auditResult.passed) {
    const criticalIssues = auditResult.issues.filter((issue) => issue.severity === "critical");
    if (criticalIssues.length > 0) {
      const reviser = params.createReviser();
      params.logStage({
        zh: `自动修复关键问题：仅针对 ${criticalIssues.length} 个 critical 做局部修补，避免改写成人男频核心卖点`,
        en: `auto-revising ${criticalIssues.length} critical issue(s) with targeted patching only`,
      });
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        auditResult.issues,
        "spot-fix",
        params.book.genre,
        {
          ...params.reducedControlInput,
          lengthSpec: params.lengthSpec,
        },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);

      if (reviseOutput.revisedContent.length > 0) {
        const normalizedRevision = await params.normalizeDraftLengthIfNeeded(reviseOutput.revisedContent);
        totalUsage = params.addUsage(totalUsage, normalizedRevision.tokenUsage);
        if (normalizedRevision.snapshot) {
          lengthNormalizationSnapshots.push({ ...normalizedRevision.snapshot, stage: "post-revision" });
        }
        postReviseCount = normalizedRevision.wordCount;
        normalizeApplied = normalizeApplied || normalizedRevision.applied;

        const preMarkers = params.analyzeAITells(finalContent);
        const postMarkers = params.analyzeAITells(normalizedRevision.content);
        if (postMarkers.issues.length <= preMarkers.issues.length) {
          finalContent = normalizedRevision.content;
          finalWordCount = normalizedRevision.wordCount;
          revised = true;
          params.assertChapterContentNotEmpty(finalContent, "revision");
        }

        const rawReAudit = await params.auditor.auditChapter(
          params.bookDir,
          finalContent,
          params.chapterNumber,
          params.book.genre,
          params.reducedControlInput
            ? { ...params.reducedControlInput, temperature: 0 }
            : { temperature: 0 },
        );
        const reAudit = removeAdultContentAuditPenalty(rawReAudit);
        totalUsage = params.addUsage(totalUsage, reAudit.tokenUsage);
        const reAITells = params.analyzeAITells(finalContent);
        const reSensitive = params.analyzeSensitiveWords(finalContent);
        const reHasBlocked = reSensitive.found.some((item) => item.severity === "block");
        auditResult = removeAdultContentAuditPenalty(params.restoreLostAuditIssues(auditResult, {
          passed: reHasBlocked ? false : reAudit.passed,
          issues: [...reAudit.issues, ...reAITells.issues, ...reSensitive.issues],
          summary: reAudit.summary,
        }));
      }
    }
  }

  return {
    finalContent,
    finalWordCount,
    preAuditNormalizedWordCount: normalizedBeforeAudit.wordCount,
    revised,
    auditResult,
    totalUsage,
    postReviseCount,
    normalizeApplied,
    lengthNormalizationSnapshots,
    reviewSnapshots,
  };
}
