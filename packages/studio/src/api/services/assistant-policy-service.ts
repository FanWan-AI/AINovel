export type AssistantPolicyRiskLevel = "low" | "medium" | "high";
export type AssistantAutopilotLevel = "L0" | "L1" | "L2" | "L3";
export type AssistantAutopilotAction = "manual-checkpoint" | "auto-execute" | "countdown-auto";
export type AssistantAutopilotCheckpointStrategy = "none" | "before-first-step" | "before-risky-step";

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
export const DEFAULT_ASSISTANT_AUTOPILOT_LEVEL: AssistantAutopilotLevel = "L1";
export const L2_MEDIUM_RISK_COUNTDOWN_SECONDS = 30;

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

export function normalizeAssistantAutopilotLevel(input: unknown): AssistantAutopilotLevel | undefined {
  return input === "L0" || input === "L1" || input === "L2" || input === "L3" ? input : undefined;
}

export function resolveAssistantAutopilotDecision(
  planOrRiskLevel: ReadonlyArray<AssistantPolicyPlanStep> | AssistantPolicyRiskLevel,
  autopilotLevel: AssistantAutopilotLevel = DEFAULT_ASSISTANT_AUTOPILOT_LEVEL,
): AssistantAutopilotDecision {
  const riskLevel = Array.isArray(planOrRiskLevel) ? resolveRiskLevel(planOrRiskLevel) : planOrRiskLevel;
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
  if (autopilotLevel === "L2") {
    if (riskLevel === "low") {
      return {
        level: autopilotLevel,
        action: "auto-execute",
        checkpointStrategy: "none",
        shouldAutoExecute: true,
        autoApproveCheckpoint: true,
        reasonCode: "l2-low-risk-auto",
        reason: "L2 auto-executes low-risk actions.",
      };
    }
    if (riskLevel === "medium") {
      return {
        level: autopilotLevel,
        action: "countdown-auto",
        checkpointStrategy: "none",
        shouldAutoExecute: true,
        autoApproveCheckpoint: true,
        countdownSeconds: L2_MEDIUM_RISK_COUNTDOWN_SECONDS,
        reasonCode: "l2-medium-countdown-auto",
        reason: "L2 auto-executes medium-risk actions after a countdown window.",
      };
    }
    return {
      level: autopilotLevel,
      action: "manual-checkpoint",
      checkpointStrategy: "before-risky-step",
      shouldAutoExecute: false,
      autoApproveCheckpoint: false,
      reasonCode: "l2-high-risk-manual",
      reason: "L2 requires manual confirmation for high-risk actions.",
    };
  }
  return {
    level: autopilotLevel,
    action: "auto-execute",
    checkpointStrategy: "none",
    shouldAutoExecute: true,
    autoApproveCheckpoint: true,
    reasonCode: "l3-full-auto",
    reason: "L3 auto-executes unless budget guard or the failure safety brake stops the run.",
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

export function evaluateAssistantPolicy(input: AssistantPolicyCheckInput): AssistantPolicyCheckResult {
  const riskLevel = resolveRiskLevel(input.plan);
  const autopilot = resolveAssistantAutopilotDecision(
    riskLevel,
    input.autopilotLevel ?? DEFAULT_ASSISTANT_AUTOPILOT_LEVEL,
  );
  const reasons: string[] = [];
  const requiredApprovals = new Set<string>();
  const budgetWarning = toBudgetWarning(input.budget);

  if (riskLevel === "high" && autopilot.level !== "L3") {
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
    autopilot,
    ...(budgetWarning ? { budgetWarning } : {}),
  };
}
