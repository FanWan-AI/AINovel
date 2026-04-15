import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
    const html = renderToStaticMarkup(createElement(AssistantView, {
      nav: { toDashboard: vi.fn() },
      theme: "light",
      t: ((key: string) => key) as never,
    }));

    expect(html).toContain("assistant-context-bar");
    expect(html).toContain("assistant-message-list");
    expect(html).toContain("assistant-input-panel");
    expect(html).toContain("assistant-empty-state");
    expect(html).toContain("生成大纲");
  });

  it("updates input, submits message and appends assistant response", () => {
    const state = createAssistantInitialState();
    const typed = applyAssistantInput(state, "请帮我总结上一章");

    expect(typed.input).toBe("请帮我总结上一章");

    const submitting = submitAssistantInput(typed, typed.input, 1000);
    expect(submitting.loading).toBe(true);
    expect(submitting.input).toBe("");
    expect(submitting.messages).toEqual([
      { role: "user", content: "请帮我总结上一章", timestamp: 1000 },
    ]);

    const completed = completeAssistantResponse(submitting, "请帮我总结上一章", 1200);
    expect(completed.loading).toBe(false);
    expect(completed.messages).toHaveLength(2);
    expect(completed.messages[1]?.role).toBe("assistant");
  });

  it("submits prompt when quick action is clicked", () => {
    const state = createAssistantInitialState();
    const next = applyAssistantQuickAction(state, ASSISTANT_QUICK_ACTIONS[0]!, 2000);

    expect(next.loading).toBe(true);
    expect(next.messages).toEqual([
      { role: "user", content: "请帮我生成下一章节的大纲。", timestamp: 2000 },
    ]);
  });
});
