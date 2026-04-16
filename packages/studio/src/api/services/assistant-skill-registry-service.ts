export type AssistantSkillLayer = "builtin" | "project" | "trusted";
export type AssistantSkillRiskLevel = "low" | "medium" | "high";
export type AssistantSkillAllowedScope = "single" | "multi" | "all-active";

export interface AssistantSkillMetadata {
  readonly name: string;
  readonly version: string;
  readonly requiredEnv: ReadonlyArray<string>;
  readonly requiredBins: ReadonlyArray<string>;
  readonly riskLevel: AssistantSkillRiskLevel;
  readonly allowedScopes: ReadonlyArray<AssistantSkillAllowedScope>;
  readonly rollbackSupport: boolean;
  readonly extensions?: Record<string, unknown>;
}

export interface AssistantSkillDescriptor {
  readonly skillId: string;
  readonly layer: AssistantSkillLayer;
  readonly metadata: AssistantSkillMetadata;
  readonly requiredPermissions: ReadonlyArray<string>;
}

export interface AssistantSkillPermissionView extends AssistantSkillDescriptor {
  readonly authorized: boolean;
  readonly missingPermissions: ReadonlyArray<string>;
}

export interface AssistantSkillAuthorizationDenied {
  readonly stepId: string;
  readonly action: string;
  readonly skillId?: string;
  readonly reason: string;
}

interface AssistantSkillRegistryEntry extends AssistantSkillDescriptor {
  readonly actionMatchers: ReadonlyArray<string>;
}

const SKILL_REGISTRY: ReadonlyArray<AssistantSkillRegistryEntry> = [
  {
    skillId: "builtin.audit",
    layer: "builtin",
    metadata: {
      name: "audit",
      version: "1.0.0",
      requiredEnv: [],
      requiredBins: [],
      riskLevel: "low",
      allowedScopes: ["single", "multi", "all-active"],
      rollbackSupport: false,
    },
    requiredPermissions: [],
    actionMatchers: ["audit", "re-audit"],
  },
  {
    skillId: "builtin.revise",
    layer: "builtin",
    metadata: {
      name: "revise",
      version: "1.0.0",
      requiredEnv: [],
      requiredBins: [],
      riskLevel: "medium",
      allowedScopes: ["single", "multi"],
      rollbackSupport: true,
    },
    requiredPermissions: [],
    actionMatchers: ["revise", "revise:spot-fix", "revise:polish", "revise:rework"],
  },
  {
    skillId: "builtin.rewrite",
    layer: "builtin",
    metadata: {
      name: "rewrite",
      version: "1.0.0",
      requiredEnv: [],
      requiredBins: [],
      riskLevel: "high",
      allowedScopes: ["single", "multi"],
      rollbackSupport: true,
    },
    requiredPermissions: ["assistant.execute.rewrite"],
    actionMatchers: ["rewrite", "revise:rewrite", "revise:full-rewrite"],
  },
  {
    skillId: "builtin.write-next",
    layer: "builtin",
    metadata: {
      name: "write-next",
      version: "1.0.0",
      requiredEnv: [],
      requiredBins: [],
      riskLevel: "medium",
      allowedScopes: ["single", "multi", "all-active"],
      rollbackSupport: true,
    },
    requiredPermissions: [],
    actionMatchers: ["write-next"],
  },
  {
    skillId: "project.style-governance",
    layer: "project",
    metadata: {
      name: "style-governance",
      version: "1.0.0",
      requiredEnv: [],
      requiredBins: [],
      riskLevel: "medium",
      allowedScopes: ["single", "multi"],
      rollbackSupport: true,
    },
    requiredPermissions: ["assistant.execute.project.style-governance"],
    actionMatchers: ["project:style-governance"],
  },
  {
    skillId: "trusted.anti-detect",
    layer: "trusted",
    metadata: {
      name: "anti-detect",
      version: "1.0.0",
      requiredEnv: [],
      requiredBins: [],
      riskLevel: "high",
      allowedScopes: ["single", "multi"],
      rollbackSupport: true,
      extensions: {
        signingRequired: true,
      },
    },
    requiredPermissions: ["assistant.execute.anti-detect"],
    actionMatchers: ["anti-detect", "revise:anti-detect"],
  },
];

function toActionMatcher(action: string, mode?: string): string {
  const normalizedAction = action.trim();
  const normalizedMode = mode?.trim();
  return normalizedMode && normalizedAction === "revise"
    ? `${normalizedAction}:${normalizedMode}`
    : normalizedAction;
}

function pickSkillByMatcher(actionMatcher: string): AssistantSkillRegistryEntry | undefined {
  return SKILL_REGISTRY.find((entry) => entry.actionMatchers.includes(actionMatcher));
}

function collectMissingPermissions(
  requiredPermissions: ReadonlyArray<string>,
  grantedPermissions: ReadonlySet<string>,
): string[] {
  return requiredPermissions.filter((permission) => !grantedPermissions.has(permission));
}

export function listAssistantSkills(permissions?: ReadonlyArray<string>): AssistantSkillPermissionView[] {
  const granted = new Set(permissions ?? []);
  return SKILL_REGISTRY.map((entry) => {
    const missingPermissions = collectMissingPermissions(entry.requiredPermissions, granted);
    return {
      skillId: entry.skillId,
      layer: entry.layer,
      metadata: entry.metadata,
      requiredPermissions: entry.requiredPermissions,
      authorized: missingPermissions.length === 0,
      missingPermissions,
    };
  });
}

export function resolveAssistantSkillId(action: string, mode?: string): string | undefined {
  const actionMatcher = toActionMatcher(action, mode);
  return pickSkillByMatcher(actionMatcher)?.skillId;
}

export function authorizeAssistantSkillPlan(
  plan: ReadonlyArray<{ stepId: string; action: string; mode?: string }>,
  permissions?: ReadonlyArray<string>,
): { allow: true } | { allow: false; denied: ReadonlyArray<AssistantSkillAuthorizationDenied> } {
  if (permissions === undefined) {
    return { allow: true };
  }
  const granted = new Set(permissions ?? []);
  const denied: AssistantSkillAuthorizationDenied[] = [];

  for (const step of plan) {
    const actionMatcher = toActionMatcher(step.action, step.mode);
    const matched = pickSkillByMatcher(actionMatcher);
    if (!matched) {
      denied.push({
        stepId: step.stepId,
        action: step.action,
        reason: `No registered skill for action "${step.action}".`,
      });
      continue;
    }
    const missingPermissions = collectMissingPermissions(matched.requiredPermissions, granted);
    if (missingPermissions.length > 0) {
      denied.push({
        stepId: step.stepId,
        action: step.action,
        skillId: matched.skillId,
        reason: `Missing required permissions: ${missingPermissions.join(", ")}.`,
      });
    }
  }

  return denied.length > 0 ? { allow: false, denied } : { allow: true };
}
