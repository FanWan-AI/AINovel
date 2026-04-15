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
  completeAssistantResponse,
  createAssistantInitialState,
  requestAssistantConfirmation,
  resolveAssistantScopeBookIds,
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
    expect(pending.pendingConfirmation?.action).toBe("write-next");
    expect(pending.messages[0]?.content).toBe("请写下一章");
    expect(pending.loading).toBe(false);

    const confirmed = confirmAssistantPendingAction(pending);
    expect(confirmed.pendingConfirmation).toBeNull();
    expect(confirmed.loading).toBe(true);

    const pendingAgain = requestAssistantConfirmation(state, draft!, 4000);
    const canceled = cancelAssistantPendingAction(pendingAgain);
    expect(canceled.pendingConfirmation).toBeNull();
    expect(canceled.loading).toBe(false);
  });

  it("blocks book-level action draft when no scoped books are selected", () => {
    expect(buildAssistantConfirmationDraft("请写下一章", "single", [], [])).toBeNull();
    expect(buildAssistantConfirmationDraft("audit chapter 12", "all-active", [], [])).toBeNull();
  });
});
