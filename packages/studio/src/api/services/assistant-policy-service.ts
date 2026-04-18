import { resolveAssistantSkillId } from "./assistant-skill-registry-service.js";

export type AssistantPolicyRiskLevel = "low" | "medium" | "high";
export type AssistantAutopilotLevel = "manual" | "guarded" | "autopilot";

export interface AssistantStrategyBudgetSettings {
  readonly limit: number;
  readonly currency: string;
}

export interface AssistantStrategySettings {
  readonly schemaVersion: number;
  readonly autopilotLevel: AssistantAutopilotLevel;
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
  readonly strategy?: AssistantStrategySettings;
}

export interface AssistantPolicyBudgetWarning {
  readonly spent: number;
  readonly limit: number;
  readonly overBy: number;
  readonly currency: string;
  readonly message: string;
}

export interface AssistantPolicyCheckResult {
  readonly allow: boolean;
  readonly riskLevel: AssistantPolicyRiskLevel;
  readonly reasons: ReadonlyArray<string>;
  readonly requiredApprovals: ReadonlyArray<string>;
  readonly budgetWarning?: AssistantPolicyBudgetWarning;
}

const HIGH_RISK_MODES = new Set(["rewrite", "full-rewrite", "anti-detect"]);
const MUTATING_ACTIONS = new Set(["revise", "rewrite", "anti-detect", "write-next"]);

export function normalizeAssistantStrategySettings(raw: unknown, fallbackUpdatedAt = ""): AssistantStrategySettings {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const autopilotLevel = ASSISTANT_AUTOPILOT_LEVEL_VALUES.includes(source.autopilotLevel as AssistantAutopilotLevel)
    ? source.autopilotLevel as AssistantAutopilotLevel
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

export function requiresAssistantCheckpoint(plan: ReadonlyArray<AssistantPolicyPlanStep>): boolean {
  return resolveRiskLevel(plan) !== "low";
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
  autopilotLevel: AssistantAutopilotLevel,
): boolean {
  return autopilotLevel === "manual" && plan.some((step) => MUTATING_ACTIONS.has(step.action));
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
  const reasons: string[] = [];
  const requiredApprovals = new Set<string>();
  const budgetWarning = toBudgetWarning(resolveEffectiveBudget(input.budget, strategy));

  if (riskLevel === "high" && strategy.autopilotLevel !== "autopilot") {
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
    ...(budgetWarning ? { budgetWarning } : {}),
  };
}
