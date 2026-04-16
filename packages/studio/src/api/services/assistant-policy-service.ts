export type AssistantPolicyRiskLevel = "low" | "medium" | "high";

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
      continue;
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

export function evaluateAssistantPolicy(input: AssistantPolicyCheckInput): AssistantPolicyCheckResult {
  const riskLevel = resolveRiskLevel(input.plan);
  const reasons: string[] = [];
  const requiredApprovals = new Set<string>();
  const budgetWarning = toBudgetWarning(input.budget);

  if (riskLevel === "high") {
    requiredApprovals.add("high-risk-manual-approval");
    if (!input.approved) {
      reasons.push("High-risk actions require manual approval before execution.");
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
