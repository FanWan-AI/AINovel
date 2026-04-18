import { resolveAssistantSkillId } from "./assistant-skill-registry-service.js";

export type AssistantPolicyRiskLevel = "low" | "medium" | "high";
export type AssistantStrategyAutopilotLevel = "manual" | "guarded" | "autopilot";
export type AssistantAutopilotLevel = AssistantStrategyAutopilotLevel | "L0" | "L1" | "L2" | "L3";
export type AssistantAutopilotAction = "manual-checkpoint" | "auto-execute" | "countdown-auto";
export type AssistantAutopilotCheckpointStrategy = "none" | "before-first-step" | "before-risky-step";

export interface AssistantStrategyBudgetSettings {
  readonly limit: number;
  readonly currency: string;
}

export interface AssistantStrategySettings {
  readonly schemaVersion: number;
  readonly autopilotLevel: AssistantStrategyAutopilotLevel;
  readonly autoFixThreshold: number;
  readonly maxAutoFixIterations: number;
  readonly budget: AssistantStrategyBudgetSettings;
  readonly approvalSkills: ReadonlyArray<string>;
  readonly publishQualityGate: number;
  readonly updatedAt: string;
  readonly extensions?: Record<string, unknown>;
}

export const ASSISTANT_STRATEGY_SCHEMA_VERSION = 1;
export const ASSISTANT_AUTOPILOT_LEVEL_VALUES = ["manual", "guarded", "autopilot"] as const;
export const DEFAULT_ASSISTANT_STRATEGY_SETTINGS: AssistantStrategySettings = {
  schemaVersion: ASSISTANT_STRATEGY_SCHEMA_VERSION,
  autopilotLevel: "guarded",
  autoFixThreshold: 85,
  maxAutoFixIterations: 3,
  budget: {
    limit: 0,
    currency: "tokens",
  },
  approvalSkills: [],
  publishQualityGate: 80,
  updatedAt: "",
};

export interface AssistantPolicyPlanStep {
  readonly action: string;
  readonly mode?: string;
  readonly bookId?: string;
  readonly bookIds?: ReadonlyArray<string>;
}

export interface AssistantPolicyBudgetInput {
  readonly spent: number;
  readonly limit: number;
  readonly currency?: string;
}

export interface AssistantPolicyCheckInput {
  readonly plan: ReadonlyArray<AssistantPolicyPlanStep>;
  readonly approved: boolean;
  readonly permissions?: ReadonlyArray<string>;
  readonly budget?: AssistantPolicyBudgetInput;
  readonly autopilotLevel?: AssistantAutopilotLevel;
  readonly strategy?: AssistantStrategySettings;
}

export interface AssistantPolicyBudgetWarning {
  readonly spent: number;
  readonly limit: number;
  readonly overBy: number;
  readonly currency: string;
  readonly message: string;
}

export interface AssistantAutopilotDecision {
  readonly level: AssistantAutopilotLevel;
  readonly action: AssistantAutopilotAction;
  readonly checkpointStrategy: AssistantAutopilotCheckpointStrategy;
  readonly shouldAutoExecute: boolean;
  readonly autoApproveCheckpoint: boolean;
  readonly countdownSeconds?: number;
  readonly reasonCode: string;
  readonly reason: string;
}

export interface AssistantPolicyCheckResult {
  readonly allow: boolean;
  readonly riskLevel: AssistantPolicyRiskLevel;
  readonly reasons: ReadonlyArray<string>;
  readonly requiredApprovals: ReadonlyArray<string>;
  readonly budgetWarning?: AssistantPolicyBudgetWarning;
  readonly autopilot: AssistantAutopilotDecision;
}

const HIGH_RISK_MODES = new Set(["rewrite", "full-rewrite", "anti-detect"]);
const MUTATING_ACTIONS = new Set(["revise", "rewrite", "anti-detect", "write-next"]);
const LEGACY_ASSISTANT_AUTOPILOT_LEVEL_VALUES = ["L0", "L1", "L2", "L3"] as const;
export const DEFAULT_ASSISTANT_AUTOPILOT_LEVEL: AssistantAutopilotLevel = "L1";
export const ASSISTANT_MEDIUM_RISK_COUNTDOWN_SECONDS = 30;

export function normalizeAssistantStrategySettings(raw: unknown, fallbackUpdatedAt = ""): AssistantStrategySettings {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const autopilotLevel = ASSISTANT_AUTOPILOT_LEVEL_VALUES.includes(source.autopilotLevel as AssistantStrategyAutopilotLevel)
    ? source.autopilotLevel as AssistantStrategyAutopilotLevel
    : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.autopilotLevel;
  const autoFixThreshold = Number.isFinite(source.autoFixThreshold)
    ? Number(source.autoFixThreshold)
    : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.autoFixThreshold;
  const maxAutoFixIterations = Number.isInteger(source.maxAutoFixIterations)
    ? Number(source.maxAutoFixIterations)
    : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.maxAutoFixIterations;
  const budgetSource = typeof source.budget === "object" && source.budget !== null && !Array.isArray(source.budget)
    ? source.budget as Record<string, unknown>
    : {};
  const budgetLimit = Number.isFinite(budgetSource.limit)
    ? Number(budgetSource.limit)
    : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.budget.limit;
  const budgetCurrency = typeof budgetSource.currency === "string" && budgetSource.currency.trim().length > 0
    ? budgetSource.currency.trim()
    : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.budget.currency;
  const approvalSkills = Array.isArray(source.approvalSkills)
    ? source.approvalSkills.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.approvalSkills;
  const publishQualityGate = Number.isFinite(source.publishQualityGate)
    ? Number(source.publishQualityGate)
    : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.publishQualityGate;
  const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim().length > 0
    ? source.updatedAt
    : fallbackUpdatedAt;
  const extensions = typeof source.extensions === "object" && source.extensions !== null && !Array.isArray(source.extensions)
    ? source.extensions as Record<string, unknown>
    : undefined;
  return {
    schemaVersion: ASSISTANT_STRATEGY_SCHEMA_VERSION,
    autopilotLevel,
    autoFixThreshold: autoFixThreshold >= 0 && autoFixThreshold <= 100
      ? autoFixThreshold
      : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.autoFixThreshold,
    maxAutoFixIterations: maxAutoFixIterations >= 1 && maxAutoFixIterations <= 20
      ? maxAutoFixIterations
      : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.maxAutoFixIterations,
    budget: {
      limit: budgetLimit >= 0 ? budgetLimit : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.budget.limit,
      currency: budgetCurrency,
    },
    approvalSkills: [...new Set(approvalSkills.map((item) => item.trim()).filter((item) => item.length > 0))],
    publishQualityGate: publishQualityGate >= 0 && publishQualityGate <= 100
      ? publishQualityGate
      : DEFAULT_ASSISTANT_STRATEGY_SETTINGS.publishQualityGate,
    updatedAt,
    ...(extensions ? { extensions } : {}),
  };
}

function resolveRiskLevel(plan: ReadonlyArray<AssistantPolicyPlanStep>): AssistantPolicyRiskLevel {
  let hasRevise = false;
  for (const step of plan) {
    if (step.action === "rewrite" || step.action === "anti-detect") return "high";
    if (step.action === "revise") {
      hasRevise = true;
      if (typeof step.mode === "string" && HIGH_RISK_MODES.has(step.mode)) {
        return "high";
      }
    }
  }
  return hasRevise ? "medium" : "low";
}

function hasMutatingActions(plan: ReadonlyArray<AssistantPolicyPlanStep>): boolean {
  return plan.some((step) => MUTATING_ACTIONS.has(step.action));
}

function isFullAutoAutopilotLevel(level: AssistantAutopilotLevel): boolean {
  return level === "autopilot" || level === "L3";
}

export function normalizeAssistantAutopilotLevel(input: unknown): AssistantAutopilotLevel | undefined {
  return ASSISTANT_AUTOPILOT_LEVEL_VALUES.includes(input as AssistantStrategyAutopilotLevel)
    || LEGACY_ASSISTANT_AUTOPILOT_LEVEL_VALUES.includes(input as (typeof LEGACY_ASSISTANT_AUTOPILOT_LEVEL_VALUES)[number])
    ? input as AssistantAutopilotLevel
    : undefined;
}

export function resolveAssistantAutopilotDecision(
  planOrRiskLevel: ReadonlyArray<AssistantPolicyPlanStep> | AssistantPolicyRiskLevel,
  autopilotLevel: AssistantAutopilotLevel = DEFAULT_ASSISTANT_AUTOPILOT_LEVEL,
): AssistantAutopilotDecision {
  const riskLevel = Array.isArray(planOrRiskLevel) ? resolveRiskLevel(planOrRiskLevel) : planOrRiskLevel;
  const mutating = Array.isArray(planOrRiskLevel)
    ? hasMutatingActions(planOrRiskLevel)
    : riskLevel !== "low";

  if (autopilotLevel === "L0") {
    return {
      level: autopilotLevel,
      action: "manual-checkpoint",
      checkpointStrategy: "before-first-step",
      shouldAutoExecute: false,
      autoApproveCheckpoint: false,
      reasonCode: "l0-manual-checkpoint",
      reason: "L0 requires a manual checkpoint before any assistant task executes.",
    };
  }

  if (autopilotLevel === "manual") {
    if (!mutating) {
      return {
        level: autopilotLevel,
        action: "auto-execute",
        checkpointStrategy: "none",
        shouldAutoExecute: true,
        autoApproveCheckpoint: true,
        reasonCode: "manual-readonly-auto",
        reason: "Manual strategy still allows non-mutating assistant actions to run automatically.",
      };
    }
    return {
      level: autopilotLevel,
      action: "manual-checkpoint",
      checkpointStrategy: "before-risky-step",
      shouldAutoExecute: false,
      autoApproveCheckpoint: false,
      reasonCode: "manual-mutating-approval",
      reason: "Manual strategy requires approval before mutating assistant actions execute.",
    };
  }

  if (autopilotLevel === "L1") {
    if (riskLevel === "low") {
      return {
        level: autopilotLevel,
        action: "auto-execute",
        checkpointStrategy: "none",
        shouldAutoExecute: true,
        autoApproveCheckpoint: true,
        reasonCode: "l1-compatible-low-risk-auto",
        reason: "L1-compatible default keeps low-risk actions automatic.",
      };
    }
    return {
      level: autopilotLevel,
      action: "manual-checkpoint",
      checkpointStrategy: "before-risky-step",
      shouldAutoExecute: false,
      autoApproveCheckpoint: false,
      reasonCode: "l1-compatible-risk-checkpoint",
      reason: "L1-compatible default inserts a checkpoint before risky assistant actions.",
    };
  }

  if (autopilotLevel === "guarded" || autopilotLevel === "L2") {
    if (riskLevel === "low") {
      return {
        level: autopilotLevel,
        action: "auto-execute",
        checkpointStrategy: "none",
        shouldAutoExecute: true,
        autoApproveCheckpoint: true,
        reasonCode: autopilotLevel === "guarded" ? "guarded-low-risk-auto" : "l2-low-risk-auto",
        reason: "Low-risk assistant actions run automatically under the guarded policy.",
      };
    }
    if (riskLevel === "medium") {
      return {
        level: autopilotLevel,
        action: "countdown-auto",
        checkpointStrategy: "none",
        shouldAutoExecute: true,
        autoApproveCheckpoint: true,
        countdownSeconds: ASSISTANT_MEDIUM_RISK_COUNTDOWN_SECONDS,
        reasonCode: autopilotLevel === "guarded" ? "guarded-medium-countdown-auto" : "l2-medium-countdown-auto",
        reason: "Medium-risk assistant actions auto-execute after the guarded countdown window.",
      };
    }
    return {
      level: autopilotLevel,
      action: "manual-checkpoint",
      checkpointStrategy: "before-risky-step",
      shouldAutoExecute: false,
      autoApproveCheckpoint: false,
      reasonCode: autopilotLevel === "guarded" ? "guarded-high-risk-manual" : "l2-high-risk-manual",
      reason: "High-risk assistant actions require manual confirmation under the guarded policy.",
    };
  }

  return {
    level: autopilotLevel,
    action: "auto-execute",
    checkpointStrategy: "none",
    shouldAutoExecute: true,
    autoApproveCheckpoint: true,
    reasonCode: autopilotLevel === "autopilot" ? "autopilot-full-auto" : "l3-full-auto",
    reason: "Full autopilot executes automatically unless the budget guard or failure safety brake stops the run.",
  };
}

export function requiresAssistantCheckpoint(
  plan: ReadonlyArray<AssistantPolicyPlanStep>,
  autopilotLevel: AssistantAutopilotLevel = DEFAULT_ASSISTANT_AUTOPILOT_LEVEL,
): boolean {
  return resolveAssistantAutopilotDecision(plan, autopilotLevel).checkpointStrategy !== "none";
}

function collectMissingPermissions(
  plan: ReadonlyArray<AssistantPolicyPlanStep>,
  permissions: ReadonlyArray<string> | undefined,
): string[] {
  if (!permissions) return [];
  const granted = new Set(permissions);
  const required = new Set<string>();
  for (const step of plan) {
    if (step.action === "rewrite" || (step.action === "revise" && step.mode === "rewrite")) {
      required.add("assistant.execute.rewrite");
    }
    if (step.action === "anti-detect" || (step.action === "revise" && step.mode === "anti-detect")) {
      required.add("assistant.execute.anti-detect");
    }
  }
  return [...required].filter((permission) => !granted.has(permission));
}

function toBudgetWarning(budget: AssistantPolicyBudgetInput | undefined): AssistantPolicyBudgetWarning | undefined {
  if (!budget) return undefined;
  if (!Number.isFinite(budget.limit) || !Number.isFinite(budget.spent)) return undefined;
  if (budget.spent <= budget.limit) return undefined;
  const overBy = Number((budget.spent - budget.limit).toFixed(4));
  const currency = budget.currency?.trim() || "tokens";
  return {
    spent: budget.spent,
    limit: budget.limit,
    overBy,
    currency,
    message: `Budget exceeded: spent ${budget.spent} > limit ${budget.limit} ${currency}.`,
  };
}

function resolveEffectiveBudget(
  budget: AssistantPolicyBudgetInput | undefined,
  strategy: AssistantStrategySettings,
): AssistantPolicyBudgetInput | undefined {
  if (!budget) return undefined;
  if (!Number.isFinite(budget.spent)) return undefined;
  if (Number.isFinite(strategy.budget.limit) && strategy.budget.limit > 0) {
    return {
      spent: budget.spent,
      limit: strategy.budget.limit,
      currency: strategy.budget.currency,
    };
  }
  return budget;
}

function requiresManualApprovalByAutopilot(
  plan: ReadonlyArray<AssistantPolicyPlanStep>,
  autopilotLevel: AssistantStrategyAutopilotLevel,
): boolean {
  return autopilotLevel === "manual" && hasMutatingActions(plan);
}

function collectStrategyApprovalSkills(
  plan: ReadonlyArray<AssistantPolicyPlanStep>,
  approvalSkills: ReadonlyArray<string>,
): string[] {
  if (approvalSkills.length === 0) return [];
  const required = new Set<string>();
  const allowed = new Set(approvalSkills);
  for (const step of plan) {
    const skillId = resolveAssistantSkillId(step.action, step.mode);
    if (skillId && allowed.has(skillId)) {
      required.add(skillId);
    }
  }
  return [...required];
}

export function evaluateAssistantPolicy(input: AssistantPolicyCheckInput): AssistantPolicyCheckResult {
  const strategy = input.strategy ?? DEFAULT_ASSISTANT_STRATEGY_SETTINGS;
  const riskLevel = resolveRiskLevel(input.plan);
  const autopilot = resolveAssistantAutopilotDecision(
    input.plan,
    input.autopilotLevel ?? strategy.autopilotLevel,
  );
  const reasons: string[] = [];
  const requiredApprovals = new Set<string>();
  const budgetWarning = toBudgetWarning(resolveEffectiveBudget(input.budget, strategy));

  if (riskLevel === "high" && !isFullAutoAutopilotLevel(autopilot.level)) {
    requiredApprovals.add("high-risk-manual-approval");
    if (!input.approved) {
      reasons.push("High-risk actions require manual approval before execution.");
    }
  }

  if (requiresManualApprovalByAutopilot(input.plan, strategy.autopilotLevel)) {
    requiredApprovals.add("manual-autopilot-approval");
    if (!input.approved) {
      reasons.push("Manual autopilot level requires approval before mutating actions can execute.");
    }
  }

  for (const skillId of collectStrategyApprovalSkills(input.plan, strategy.approvalSkills)) {
    requiredApprovals.add(`skill:${skillId}`);
    if (!input.approved) {
      reasons.push(`Configured approval skill requires manual approval: ${skillId}.`);
    }
  }

  const missingPermissions = collectMissingPermissions(input.plan, input.permissions);
  for (const permission of missingPermissions) {
    reasons.push(`Missing required permission: ${permission}.`);
  }

  if (budgetWarning) {
    reasons.push(budgetWarning.message);
  }

  return {
    allow: reasons.length === 0,
    riskLevel,
    reasons,
    requiredApprovals: [...requiredApprovals],
    autopilot,
    ...(budgetWarning ? { budgetWarning } : {}),
  };
}
