import { describe, expect, it } from "vitest";
import { parseAssistantOperatorCommand } from "./assistant-command-parser";

describe("assistant-command-parser", () => {
  it("parses all supported operator commands", () => {
    expect(parseAssistantOperatorCommand("/goal 推进第一卷主线")).toEqual({
      kind: "command",
      raw: "/goal 推进第一卷主线",
      command: { name: "goal", goal: "推进第一卷主线" },
    });
    expect(parseAssistantOperatorCommand("/status")).toEqual({
      kind: "command",
      raw: "/status",
      command: { name: "status" },
    });
    expect(parseAssistantOperatorCommand("/pause")).toEqual({
      kind: "command",
      raw: "/pause",
      command: { name: "pause" },
    });
    expect(parseAssistantOperatorCommand("/resume")).toEqual({
      kind: "command",
      raw: "/resume",
      command: { name: "resume" },
    });
    expect(parseAssistantOperatorCommand("/approve step-01")).toEqual({
      kind: "command",
      raw: "/approve step-01",
      command: { name: "approve", targetId: "step-01" },
    });
    expect(parseAssistantOperatorCommand("/rollback run_01")).toEqual({
      kind: "command",
      raw: "/rollback run_01",
      command: { name: "rollback", runId: "run_01" },
    });
    expect(parseAssistantOperatorCommand("/trace on")).toEqual({
      kind: "command",
      raw: "/trace on",
      command: { name: "trace", enabled: true },
    });
    expect(parseAssistantOperatorCommand("/budget")).toEqual({
      kind: "command",
      raw: "/budget",
      command: { name: "budget" },
    });
  });

  it("returns readable errors for invalid command arguments", () => {
    expect(parseAssistantOperatorCommand("/goal")).toEqual({
      kind: "error",
      raw: "/goal",
      error: "命令 /goal 需要目标描述。",
    });
    expect(parseAssistantOperatorCommand("/trace maybe")).toEqual({
      kind: "error",
      raw: "/trace maybe",
      error: "命令 /trace 仅支持 on 或 off。",
    });
  });

  it("does not classify natural language as commands", () => {
    expect(parseAssistantOperatorCommand("请帮我写下一章")).toEqual({ kind: "not-command" });
    expect(parseAssistantOperatorCommand("请执行 /goal 这个词汇解释")).toEqual({ kind: "not-command" });
  });
});
