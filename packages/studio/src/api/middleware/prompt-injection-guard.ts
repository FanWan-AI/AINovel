import type { Context, MiddlewareHandler } from "hono";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const REQUEST_ID_CONTEXT_KEY = "assistantSecurityRequestId";
const AUDIT_SUMMARY_PREVIEW_LENGTH = 96;
const AUDIT_SUMMARY_DIGEST_LENGTH = 12;

interface SecurityRule {
  readonly id: string;
  readonly reason: string;
  readonly routePrefixes: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<string>;
  readonly pattern?: RegExp;
  readonly reservedKeys?: ReadonlyArray<string>;
}

interface SecurityRulesConfig {
  readonly enabled: boolean;
  readonly whitelistRules: ReadonlyArray<SecurityRule>;
  readonly inputRules: ReadonlyArray<SecurityRule>;
  readonly outputRules: ReadonlyArray<SecurityRule>;
}

interface ContentCandidate {
  readonly target: string;
  readonly content: string;
}

interface SecurityDecision {
  readonly code: "ASSISTANT_SECURITY_BLOCKED" | "ASSISTANT_OUTPUT_BLOCKED";
  readonly reason: string;
  readonly ruleId: string;
  readonly requestId: string;
  readonly route: string;
  readonly phase: "request" | "output";
  readonly target: string;
  readonly summary: string;
  readonly message: string;
}

interface PromptInjectionGuard {
  readonly middleware: MiddlewareHandler;
  inspectOutput: (input: { readonly route: string; readonly requestId?: string; readonly content: string }) => Promise<SecurityDecision | null>;
  getRequestId: (context: Context) => string | undefined;
}

interface RawRule {
  readonly id?: unknown;
  readonly reason?: unknown;
  readonly pattern?: unknown;
  readonly routePrefixes?: unknown;
  readonly targets?: unknown;
  readonly reservedKeys?: unknown;
  readonly enabled?: unknown;
}

interface RawRulesConfig {
  readonly enabled?: unknown;
  readonly whitelistRules?: unknown;
  readonly inputRules?: unknown;
  readonly outputRules?: unknown;
}

const DEFAULT_INPUT_RULES: ReadonlyArray<SecurityRule> = [
  {
    id: "default.prompt-hijack",
    reason: "检测到提示劫持或越权指令特征。",
    routePrefixes: ["/api/assistant/"],
    targets: ["prompt", "input", "instruction", "content", "message", "objective", "$raw"],
    pattern: /(ignore|disregard|override).{0,40}(instruction|system|developer|guard|policy)|忽略.{0,20}(之前|上面|现有).{0,20}(指令|系统|规则)|绕过.{0,20}(安全|限制|策略)|bypass.{0,20}(safety|guard|policy)/iu,
  },
  {
    id: "default.system-leak-request",
    reason: "检测到 system prompt / developer message 泄漏请求特征。",
    routePrefixes: ["/api/assistant/"],
    targets: ["prompt", "input", "instruction", "content", "message", "$raw"],
    pattern: /(system prompt|developer message|hidden prompt|系统提示词|系统提示|开发者消息).{0,30}(原文|全文|内容|exact|raw|verbatim|show|reveal|dump|泄漏|输出)/iu,
  },
  {
    id: "default.parameter-injection",
    reason: "检测到保留模型参数或角色注入，请使用受控接口参数。",
    routePrefixes: ["/api/assistant/"],
    targets: ["$reserved-keys"],
    reservedKeys: [
      "system",
      "developer",
      "messages",
      "model",
      "temperature",
      "max_tokens",
      "top_p",
      "tool_choice",
      "response_format",
      "functions",
      "tools",
      "presence_penalty",
      "frequency_penalty",
    ],
  },
];

const DEFAULT_OUTPUT_RULES: ReadonlyArray<SecurityRule> = [
  {
    id: "default.system-leak-output",
    reason: "输出命中 system prompt 泄漏特征，已拦截返回。",
    routePrefixes: ["/api/assistant/"],
    targets: ["response"],
    // Avoid false positives for in-story terms like "系统提示" in webnovel content.
    pattern: /(system prompt|developer message|hidden prompt|系统提示词|开发者消息|BEGIN_SYSTEM_PROMPT|END_SYSTEM_PROMPT|<system>|role:\s*system|(?:以下|这是|这里是|原文|全文).{0,24}(system prompt|系统提示词|开发者消息))/iu,
  },
];

function normalizeRule(raw: unknown): SecurityRule | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const source = raw as RawRule;
  if (source.enabled === false) {
    return null;
  }
  const id = typeof source.id === "string" && source.id.trim().length > 0 ? source.id.trim() : "";
  const reason = typeof source.reason === "string" && source.reason.trim().length > 0 ? source.reason.trim() : "";
  const routePrefixes = Array.isArray(source.routePrefixes)
    ? source.routePrefixes.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : ["/api/assistant/"];
  const targets = Array.isArray(source.targets)
    ? source.targets.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : ["$raw"];
  const reservedKeys = Array.isArray(source.reservedKeys)
    ? source.reservedKeys.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : [];
  let pattern: RegExp | undefined;
  if (typeof source.pattern === "string" && source.pattern.trim().length > 0) {
    try {
      pattern = new RegExp(source.pattern, "iu");
    } catch {
      pattern = undefined;
    }
  }
  if (!id || !reason) {
    return null;
  }
  if (!pattern && reservedKeys.length === 0) {
    return null;
  }
  return {
    id,
    reason,
    routePrefixes,
    targets,
    ...(pattern ? { pattern } : {}),
    ...(reservedKeys.length > 0 ? { reservedKeys } : {}),
  };
}

function normalizeRules(raw: unknown, fallback: ReadonlyArray<SecurityRule>): ReadonlyArray<SecurityRule> {
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const normalized = raw.map((entry) => normalizeRule(entry)).filter((entry): entry is SecurityRule => entry !== null);
  return normalized.length > 0 ? normalized : fallback;
}

async function loadSecurityRules(root: string): Promise<SecurityRulesConfig> {
  const rulesPath = join(root, ".inkos", "security-rules.json");
  try {
    const raw = JSON.parse(await readFile(rulesPath, "utf-8")) as RawRulesConfig;
    return {
      enabled: raw.enabled !== false,
      whitelistRules: normalizeRules(raw.whitelistRules, []),
      inputRules: normalizeRules(raw.inputRules, DEFAULT_INPUT_RULES),
      outputRules: normalizeRules(raw.outputRules, DEFAULT_OUTPUT_RULES),
    };
  } catch {
    return {
      enabled: true,
      whitelistRules: [],
      inputRules: DEFAULT_INPUT_RULES,
      outputRules: DEFAULT_OUTPUT_RULES,
    };
  }
}

function normalizeRequestId(input?: string | null): string {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : `req_${randomUUID().replace(/-/g, "")}`;
}

function summarizeContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const preview = normalized.slice(0, AUDIT_SUMMARY_PREVIEW_LENGTH);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, AUDIT_SUMMARY_DIGEST_LENGTH);
  return `${preview}${normalized.length > AUDIT_SUMMARY_PREVIEW_LENGTH ? "…" : ""} [len=${normalized.length} sha256=${digest}]`;
}

function matchesRoute(rule: SecurityRule, route: string): boolean {
  return rule.routePrefixes.some((prefix) => route.startsWith(prefix));
}

function matchesTarget(rule: SecurityRule, target: string): boolean {
  return rule.targets.includes(target) || rule.targets.includes("*");
}

function collectStringCandidates(value: unknown, parentKey?: string): ContentCandidate[] {
  if (typeof value === "string") {
    if (parentKey && parentKey.trim().length > 0) {
      return [{ target: parentKey, content: value }];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringCandidates(entry, parentKey));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => collectStringCandidates(entry, key));
}

async function readRequestBody(request: Request): Promise<string> {
  try {
    return await request.clone().text();
  } catch (error) {
    return `[request-body-unavailable:${error instanceof Error ? error.message : String(error)}]`;
  }
}

function collectReservedKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectReservedKeys(entry, found));
    return found;
  }
  if (typeof value !== "object" || value === null) {
    return found;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    found.add(key);
    collectReservedKeys(entry, found);
  });
  return found;
}

function matchesWhitelist(rules: ReadonlyArray<SecurityRule>, route: string, candidates: ReadonlyArray<ContentCandidate>): boolean {
  return rules.some((rule) => {
    if (!matchesRoute(rule, route) || !rule.pattern) {
      return false;
    }
    return candidates.some((candidate) => matchesTarget(rule, candidate.target) && rule.pattern?.test(candidate.content));
  });
}

function findRuleMatch(rules: ReadonlyArray<SecurityRule>, route: string, candidates: ReadonlyArray<ContentCandidate>): { rule: SecurityRule; candidate: ContentCandidate } | null {
  for (const rule of rules) {
    if (!matchesRoute(rule, route)) {
      continue;
    }
    if (rule.pattern) {
      const candidate = candidates.find((entry) => matchesTarget(rule, entry.target) && rule.pattern?.test(entry.content));
      if (candidate) {
        return { rule, candidate };
      }
    }
    if (rule.reservedKeys && rule.reservedKeys.length > 0) {
      const reservedCandidate = candidates.find((entry) => entry.target === "$reserved-keys");
      if (!reservedCandidate) {
        continue;
      }
      const seen = new Set(reservedCandidate.content.split(",").map((value) => value.trim()).filter((value) => value.length > 0));
      const matchedKey = rule.reservedKeys.find((key) => seen.has(key));
      if (matchedKey) {
        return { rule, candidate: { target: "$reserved-keys", content: matchedKey } };
      }
    }
  }
  return null;
}

async function appendAuditLog(root: string, decision: SecurityDecision): Promise<void> {
  const logPath = join(root, ".inkos", "security-audit.log");
  await mkdir(join(root, ".inkos"), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    phase: decision.phase,
    route: decision.route,
    requestId: decision.requestId,
    rule: decision.ruleId,
    reason: decision.reason,
    target: decision.target,
    summary: decision.summary,
  })}\n`, "utf-8");
}

async function buildRequestDecision(
  root: string,
  config: SecurityRulesConfig,
  input: { readonly route: string; readonly requestId: string; readonly request: Request },
): Promise<SecurityDecision | null> {
  if (!config.enabled) {
    return null;
  }
  const url = new URL(input.request.url);
  const queryCandidates = Array.from(url.searchParams.entries()).map(([key, value]) => ({ target: key, content: value }));
  const rawBody = await readRequestBody(input.request);
  const candidates: ContentCandidate[] = [...queryCandidates];
  if (rawBody.trim().length > 0) {
    candidates.push({ target: "$raw", content: rawBody });
  }
  const contentType = input.request.headers.get("content-type") ?? "";
  let parsedBody: unknown = undefined;
  if (rawBody.trim().length > 0 && contentType.includes("application/json")) {
    try {
      parsedBody = JSON.parse(rawBody);
      candidates.push(...collectStringCandidates(parsedBody));
      const reservedKeys = Array.from(collectReservedKeys(parsedBody)).sort();
      if (reservedKeys.length > 0) {
        candidates.push({ target: "$reserved-keys", content: reservedKeys.join(",") });
      }
    } catch {
      // Keep raw body candidate only when JSON parsing fails.
    }
  }
  if (matchesWhitelist(config.whitelistRules, input.route, candidates)) {
    return null;
  }
  const match = findRuleMatch(config.inputRules, input.route, candidates);
  if (!match) {
    return null;
  }
  const decision: SecurityDecision = {
    code: "ASSISTANT_SECURITY_BLOCKED",
    reason: match.rule.reason,
    ruleId: match.rule.id,
    requestId: input.requestId,
    route: input.route,
    phase: "request",
    target: match.candidate.target,
    summary: summarizeContent(match.candidate.content),
    message: "Assistant request blocked by security policy.",
  };
  await appendAuditLog(root, decision);
  return decision;
}

async function buildOutputDecision(
  root: string,
  config: SecurityRulesConfig,
  input: { readonly route: string; readonly requestId: string; readonly content: string },
): Promise<SecurityDecision | null> {
  if (!config.enabled) {
    return null;
  }
  const candidates: ContentCandidate[] = [{ target: "response", content: input.content }];
  if (matchesWhitelist(config.whitelistRules, input.route, candidates)) {
    return null;
  }
  const match = findRuleMatch(config.outputRules, input.route, candidates);
  if (!match) {
    return null;
  }
  const decision: SecurityDecision = {
    code: "ASSISTANT_OUTPUT_BLOCKED",
    reason: match.rule.reason,
    ruleId: match.rule.id,
    requestId: input.requestId,
    route: input.route,
    phase: "output",
    target: match.candidate.target,
    summary: summarizeContent(match.candidate.content),
    message: "Assistant response blocked by security policy.",
  };
  await appendAuditLog(root, decision);
  return decision;
}

export function createPromptInjectionGuard(root: string): PromptInjectionGuard {
  let rulesPromise: Promise<SecurityRulesConfig> | null = null;
  const loadRules = () => {
    rulesPromise ??= loadSecurityRules(root);
    return rulesPromise;
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    const requestId = normalizeRequestId(c.req.header("x-request-id"));
    c.set(REQUEST_ID_CONTEXT_KEY, requestId);
    c.header("X-Request-Id", requestId);
    const rules = await loadRules();
    const decision = await buildRequestDecision(root, rules, {
      route: c.req.path,
      requestId,
      request: c.req.raw,
    });
    if (decision) {
      return c.json({
        error: {
          code: decision.code,
          message: decision.message,
          reason: decision.reason,
          rule: decision.ruleId,
          requestId: decision.requestId,
        },
      }, 403);
    }
    await next();
    if (!c.res.headers.has("X-Request-Id")) {
      c.res.headers.set("X-Request-Id", requestId);
    }
  };

  return {
    middleware,
    async inspectOutput(input) {
      const rules = await loadRules();
      const requestId = normalizeRequestId(input.requestId);
      return buildOutputDecision(root, rules, {
        route: input.route,
        requestId,
        content: input.content,
      });
    },
    getRequestId(context) {
      return context.get(REQUEST_ID_CONTEXT_KEY) as string | undefined;
    },
  };
}
