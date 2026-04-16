import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "../hooks/use-i18n";
import {
  ASSISTANT_QUICK_ACTIONS,
  AssistantView,
  applyAssistantInput,
  applyAssistantQuickAction,
  buildAssistantConfirmationDraft,
  cancelAssistantPendingAction,
  confirmAssistantPendingAction,
  completeAssistantTaskPlanExecution,
  completeAssistantResponse,
  createAssistantTaskPlanDraft,
  createAssistantInitialState,
  requestAssistantConfirmation,
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
});
