export type AssistantOperatorCommandName =
  | "goal"
  | "status"
  | "pause"
  | "resume"
  | "approve"
  | "rollback"
  | "trace"
  | "budget";

export type AssistantOperatorCommand =
  | { readonly name: "goal"; readonly goal: string }
  | { readonly name: "status" }
  | { readonly name: "pause" }
  | { readonly name: "resume" }
  | { readonly name: "approve"; readonly targetId: string }
  | { readonly name: "rollback"; readonly runId: string }
  | { readonly name: "trace"; readonly enabled: boolean }
  | { readonly name: "budget" };

export type AssistantOperatorParseResult =
  | { readonly kind: "not-command" }
  | { readonly kind: "command"; readonly raw: string; readonly command: AssistantOperatorCommand }
  | { readonly kind: "error"; readonly raw: string; readonly error: string };

const COMMANDS = new Set<AssistantOperatorCommandName>([
  "goal",
  "status",
  "pause",
  "resume",
  "approve",
  "rollback",
  "trace",
  "budget",
]);

function parseSingleArg(raw: string): string {
  return raw.trim();
}

export function parseAssistantOperatorCommand(input: string): AssistantOperatorParseResult {
  const normalized = input.trim();
  if (!normalized.startsWith("/")) {
    return { kind: "not-command" };
  }

  const body = normalized.slice(1).trim();
  if (!body) {
    return { kind: "error", raw: normalized, error: "命令不能为空。" };
  }

  const [nameToken = "", ...argTokens] = body.split(/\s+/u);
  const name = nameToken.toLowerCase() as AssistantOperatorCommandName;
  const argText = argTokens.join(" ").trim();

  if (!COMMANDS.has(name)) {
    return { kind: "error", raw: normalized, error: `不支持的命令：/${nameToken}` };
  }

  if (name === "goal") {
    const goal = parseSingleArg(argText);
    if (!goal) {
      return { kind: "error", raw: normalized, error: "命令 /goal 需要目标描述。" };
    }
    return { kind: "command", raw: normalized, command: { name: "goal", goal } };
  }

  if (name === "approve") {
    const targetId = parseSingleArg(argText);
    if (!targetId) {
      return { kind: "error", raw: normalized, error: "命令 /approve 需要 stepId 或 taskId。" };
    }
    return { kind: "command", raw: normalized, command: { name: "approve", targetId } };
  }

  if (name === "rollback") {
    const runId = parseSingleArg(argText);
    if (!runId) {
      return { kind: "error", raw: normalized, error: "命令 /rollback 需要 runId。" };
    }
    return { kind: "command", raw: normalized, command: { name: "rollback", runId } };
  }

  if (name === "trace") {
    const mode = parseSingleArg(argText).toLowerCase();
    if (mode !== "on" && mode !== "off") {
      return { kind: "error", raw: normalized, error: "命令 /trace 仅支持 on 或 off。" };
    }
    return { kind: "command", raw: normalized, command: { name: "trace", enabled: mode === "on" } };
  }

  if (argText.length > 0) {
    return { kind: "error", raw: normalized, error: `命令 /${name} 不接受额外参数。` };
  }

  return { kind: "command", raw: normalized, command: { name } };
}
