import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseAssistantOperatorCommand } from "../api/services/assistant-command-parser";
import type { TFunction } from "../hooks/use-i18n";
import {
  ASSISTANT_QUICK_ACTIONS,
  AssistantTimeline,
  AssistantView,
  applyAssistantInput,
  applyAssistantIncomingPrompt,
  applyAssistantOperatorCommand,
  applyAssistantQuickAction,
  applyAssistantTaskEventFromSSE,
  buildAssistantConfirmationDraft,
  buildAssistantNextActionPrompt,
  collectAssistantStepRunIds,
  cancelAssistantPendingAction,
  confirmAssistantPendingAction,
  completeAssistantTaskPlanExecution,
  completeAssistantResponse,
  createAssistantTaskPlanDraft,
  createAssistantInitialState,
  requestAssistantConfirmation,
  reconcileAssistantTaskFromSnapshot,
  resolveAssistantScopeBookIds,
  transitionAssistantTaskPlan,
  submitAssistantInput,
} from "./AssistantView";

describe("AssistantView", () => {
  it("renders three-section layout with context bar, message area and input panel", () => {
    const tMock: TFunction = (key) => String(key);
    const html = renderToStaticMarkup(createElement(AssistantView, {
      nav: { toDashboard: vi.fn() },
      theme: "light",
      t: tMock,
    }));

    expect(html).toContain("assistant-context-bar");
    expect(html).toContain("assistant-scope-selector");
    expect(html).toContain("assistant-message-list");
    expect(html).toContain("assistant-input-panel");
    expect(html).toContain("assistant-empty-state");
    expect(html).toContain("生成大纲");
  });

  it("updates input, submits message and appends assistant response", () => {
    const prompt = "请帮我总结上一章";
    const state = createAssistantInitialState();
    const typed = applyAssistantInput(state, prompt);

    expect(typed.input).toBe(prompt);

    const submitting = submitAssistantInput(typed, typed.input, 1000);
    expect(submitting.loading).toBe(true);
    expect(submitting.input).toBe("");
    expect(submitting.messages).toEqual([
      { id: "msg-1", role: "user", content: prompt, timestamp: 1000 },
    ]);

    const completed = completeAssistantResponse(submitting, prompt, 1200);
    expect(completed.loading).toBe(false);
    expect(completed.messages).toHaveLength(2);
    expect(completed.messages[1]?.role).toBe("assistant");
  });

  it("hydrates assistant input from forwarded ChatBar prompt", () => {
    const state = createAssistantInitialState();
    const next = applyAssistantIncomingPrompt(state, "  请帮我审计第5章  ");
    expect(next.input).toBe("请帮我审计第5章");
    expect(applyAssistantIncomingPrompt(state, "   ")).toBe(state);
  });

  it("submits prompt when quick action is clicked", () => {
    const state = createAssistantInitialState();
    const next = applyAssistantQuickAction(state, ASSISTANT_QUICK_ACTIONS[0]!, 2000);

    expect(next.loading).toBe(true);
    expect(next.messages).toEqual([
      { id: "msg-1", role: "user", content: "请帮我生成下一章节的大纲。", timestamp: 2000 },
    ]);
  });

  it("resolves scope selections for single, multi and all-active modes", () => {
    expect(resolveAssistantScopeBookIds("single", ["book-1", "book-2"], ["book-1", "book-2", "book-3"]))
      .toEqual(["book-1"]);
    expect(resolveAssistantScopeBookIds("multi", ["book-1", "book-2", "book-1"], ["book-1", "book-2", "book-3"]))
      .toEqual(["book-1", "book-2"]);
    expect(resolveAssistantScopeBookIds("all-active", [], ["book-1", "book-2"]))
      .toEqual(["book-1", "book-2"]);
  });

  it("creates, confirms and cancels parameter confirmation cards for book actions", () => {
    const state = createAssistantInitialState();
    const draft = buildAssistantConfirmationDraft("请写下一章", "single", ["book-1"], ["book-1", "book-2"]);
    expect(draft).not.toBeNull();

    const pending = requestAssistantConfirmation(state, draft!, 3000);
    expect(pending.taskPlan?.action).toBe("write-next");
    expect(pending.taskPlan?.status).toBe("awaiting-confirm");
    expect(pending.messages[0]?.content).toBe("请写下一章");
    expect(pending.loading).toBe(false);

    const confirmed = confirmAssistantPendingAction(pending, 3500);
    expect(confirmed.taskPlan?.status).toBe("running");
    expect(confirmed.loading).toBe(true);

    const pendingAgain = requestAssistantConfirmation(state, draft!, 4000);
    const canceled = cancelAssistantPendingAction(pendingAgain, 4500);
    expect(canceled.taskPlan?.status).toBe("cancelled");
    expect(canceled.loading).toBe(false);
  });

  it("blocks book-level action draft when no scoped books are selected", () => {
    expect(buildAssistantConfirmationDraft("请写下一章", "single", [], [])).toBeNull();
    expect(buildAssistantConfirmationDraft("audit chapter 12", "all-active", [], [])).toBeNull();
  });

  it("supports full task-plan state transitions", () => {
    const draft = buildAssistantConfirmationDraft("audit chapter 12", "single", ["book-1"], ["book-1"]);
    expect(draft).not.toBeNull();
    const planDraft = createAssistantTaskPlanDraft(draft!, 5000);
    expect(planDraft.status).toBe("draft");

    const awaitingConfirm = transitionAssistantTaskPlan(planDraft, "awaiting-confirm", 5001);
    const running = transitionAssistantTaskPlan(awaitingConfirm, "running", 5002);
    const succeeded = transitionAssistantTaskPlan(running, "succeeded", 5003);
    const failed = transitionAssistantTaskPlan(running, "failed", 5004);
    const cancelled = transitionAssistantTaskPlan(awaitingConfirm, "cancelled", 5005);

    expect(awaitingConfirm.status).toBe("awaiting-confirm");
    expect(running.status).toBe("running");
    expect(succeeded.status).toBe("succeeded");
    expect(failed.status).toBe("failed");
    expect(cancelled.status).toBe("cancelled");
  });

  it("completes running task plans with succeeded/failed results", () => {
    const draft = buildAssistantConfirmationDraft("请写下一章", "single", ["book-1"], ["book-1"]);
    const pending = requestAssistantConfirmation(createAssistantInitialState(), draft!, 6000);
    const running = confirmAssistantPendingAction(pending, 6001);

    const succeeded = completeAssistantTaskPlanExecution(running, "succeeded", 6002);
    expect(succeeded.taskPlan?.status).toBe("succeeded");
    expect(succeeded.loading).toBe(false);

    const runningAgain = confirmAssistantPendingAction(pending, 6003);
    const failed = completeAssistantTaskPlanExecution(runningAgain, "failed", 6004);
    expect(failed.taskPlan?.status).toBe("failed");
    expect(failed.loading).toBe(false);
  });

  it("does not mutate state when completion is requested outside running status", () => {
    const state = createAssistantInitialState();
    expect(completeAssistantTaskPlanExecution(state, "succeeded", 7000)).toBe(state);
  });

  it("applies assistant step/done events into timeline and closes loading on completion", () => {
    const draft = buildAssistantConfirmationDraft("请写下一章", "single", ["book-1"], ["book-1"]);
    const pending = requestAssistantConfirmation(createAssistantInitialState(), draft!, 8000);
    const running = confirmAssistantPendingAction(pending, 8001);
    const withTask = { ...running, taskExecution: { taskId: "asst_t_01", sessionId: "asst_s_01", status: "running" as const, timeline: [], lastSyncedAt: 8001, nextSequence: 0 } };

    const started = applyAssistantTaskEventFromSSE(withTask, {
      event: "assistant:step:start",
      data: { taskId: "asst_t_01", sessionId: "asst_s_01", stepId: "s1", action: "audit", timestamp: "2026-01-01T00:00:01.000Z" },
      timestamp: 8002,
    });
    const done = applyAssistantTaskEventFromSSE(started, {
      event: "assistant:done",
      data: { taskId: "asst_t_01", sessionId: "asst_s_01", status: "succeeded", timestamp: "2026-01-01T00:00:02.000Z" },
      timestamp: 8003,
    });

    expect(started.taskExecution?.timeline).toHaveLength(1);
    expect(done.taskExecution?.status).toBe("succeeded");
    expect(done.taskExecution?.timeline.at(-1)?.event).toBe("assistant:done");
    expect(done.loading).toBe(false);
    expect(done.taskPlan?.status).toBe("succeeded");
  });

  it("reconciles timeline from task snapshot when sse events are missing", () => {
    const draft = buildAssistantConfirmationDraft("审计第3章", "single", ["book-1"], ["book-1"]);
    const pending = requestAssistantConfirmation(createAssistantInitialState(), draft!, 9000);
    const running = confirmAssistantPendingAction(pending, 9001);
    const withTask = { ...running, taskExecution: { taskId: "asst_t_02", sessionId: "asst_s_02", status: "running" as const, timeline: [], lastSyncedAt: 9001, nextSequence: 0 } };

    const reconciled = reconcileAssistantTaskFromSnapshot(withTask, {
      taskId: "asst_t_02",
      sessionId: "asst_s_02",
      status: "failed",
      steps: {
        s1: { stepId: "s1", action: "audit", status: "failed", startedAt: "2026-01-01T00:00:01.000Z", finishedAt: "2026-01-01T00:00:02.000Z", error: "boom" },
      },
      lastUpdatedAt: "2026-01-01T00:00:03.000Z",
      error: "boom",
    });

    expect(reconciled.taskExecution?.timeline.map((entry) => entry.event)).toEqual(["assistant:step:start", "assistant:step:fail", "assistant:done"]);
    expect(reconciled.loading).toBe(false);
    expect(reconciled.taskPlan?.status).toBe("failed");
  });

  it("renders timeline items", () => {
    const html = renderToStaticMarkup(createElement(AssistantTimeline, {
      entries: [
        {
          id: "t1",
          event: "assistant:step:start",
          taskId: "asst_t_01",
          stepId: "s1",
          action: "audit",
          message: "步骤 s1（audit） 开始",
          timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
        },
      ],
    }));

    expect(html).toContain("assistant-task-timeline");
    expect(html).toContain("步骤 s1");
  });

  it("maps suggested next actions to executable prompts", () => {
    const draft = buildAssistantConfirmationDraft("审计第3章", "single", ["book-1"], ["book-1"]);
    const state = requestAssistantConfirmation(createAssistantInitialState(), draft!, 10_000);
    expect(buildAssistantNextActionPrompt("spot-fix", state.taskPlan)).toContain("spot-fix");
    expect(buildAssistantNextActionPrompt("re-audit", state.taskPlan)).toContain("第3章");
    expect(buildAssistantNextActionPrompt("write-next", state.taskPlan)).toBe("请写下一章。");
  });

  it("collects non-empty run ids from step run mapping", () => {
    expect(collectAssistantStepRunIds({
      s1: "run_1",
      s2: "",
      s3: "run_3",
    })).toEqual(["run_1", "run_3"]);
  });

  it("parses supported operator commands and rejects natural language", () => {
    expect(parseAssistantOperatorCommand("/goal 完成第一卷主线")).toEqual({
      kind: "command",
      raw: "/goal 完成第一卷主线",
      command: { name: "goal", goal: "完成第一卷主线" },
    });
    expect(parseAssistantOperatorCommand("/trace on")).toEqual({
      kind: "command",
      raw: "/trace on",
      command: { name: "trace", enabled: true },
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
    expect(parseAssistantOperatorCommand("/approve step-1")).toEqual({
      kind: "command",
      raw: "/approve step-1",
      command: { name: "approve", targetId: "step-1" },
    });
    expect(parseAssistantOperatorCommand("/rollback run_1")).toEqual({
      kind: "command",
      raw: "/rollback run_1",
      command: { name: "rollback", runId: "run_1" },
    });
    expect(parseAssistantOperatorCommand("/budget")).toEqual({
      kind: "command",
      raw: "/budget",
      command: { name: "budget" },
    });
    expect(parseAssistantOperatorCommand("/trace maybe")).toEqual({
      kind: "error",
      raw: "/trace maybe",
      error: "命令 /trace 仅支持 on 或 off。",
    });
    expect(parseAssistantOperatorCommand("请帮我生成下一章 /goal")).toEqual({
      kind: "not-command",
    });
  });

  it("echoes operator command receipts and readable failures", () => {
    const initial = createAssistantInitialState();
    const afterGoal = applyAssistantOperatorCommand(initial, "/goal 推进主线", 11_000);
    expect(afterGoal).not.toBeNull();
    expect(afterGoal?.messages.map((message) => message.content)).toEqual([
      "/goal 推进主线",
      "[Operator Receipt]\n- command: /goal 推进主线\n- result: ok\n- message: 已更新目标：推进主线",
    ]);

    const afterPause = applyAssistantOperatorCommand(afterGoal!, "/pause", 11_001);
    expect(afterPause?.messages.at(-1)?.content).toContain("result: ok");

    const afterPauseAgain = applyAssistantOperatorCommand(afterPause!, "/pause", 11_002);
    expect(afterPauseAgain?.messages.at(-1)?.content).toContain("命令执行失败：会话已处于暂停状态。");

    const afterNaturalLanguage = applyAssistantOperatorCommand(afterPauseAgain!, "请继续分析人物弧光", 11_003);
    expect(afterNaturalLanguage).toBeNull();
  });
});
