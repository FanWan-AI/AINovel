import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "../hooks/use-i18n";
import {
  ASSISTANT_QUICK_ACTIONS,
  AssistantView,
  applyAssistantInput,
  applyAssistantQuickAction,
  completeAssistantResponse,
  createAssistantInitialState,
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
});
