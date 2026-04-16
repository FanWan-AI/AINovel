import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "../../hooks/use-i18n";
import type { AssistantTaskPlan } from "../../pages/AssistantView";
import { buildTaskPlanCardActions, resolveTaskPlanStatusKey, TaskPlanCard } from "./TaskPlanCard";

const t: TFunction = (key) => key;

function createTaskPlan(status: AssistantTaskPlan["status"]): AssistantTaskPlan {
  return {
    id: "plan-1",
    status,
    action: "write-next",
    prompt: "请写下一章",
    targetBookIds: ["book-1"],
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe("TaskPlanCard", () => {
  it("maps all status values to i18n keys", () => {
    expect(resolveTaskPlanStatusKey("draft")).toBe("assistant.planStatusDraft");
    expect(resolveTaskPlanStatusKey("awaiting-confirm")).toBe("assistant.planStatusAwaitingConfirm");
    expect(resolveTaskPlanStatusKey("running")).toBe("assistant.planStatusRunning");
    expect(resolveTaskPlanStatusKey("succeeded")).toBe("assistant.planStatusSucceeded");
    expect(resolveTaskPlanStatusKey("failed")).toBe("assistant.planStatusFailed");
    expect(resolveTaskPlanStatusKey("cancelled")).toBe("assistant.planStatusCancelled");
  });

  it("builds confirm/cancel actions only in awaiting-confirm status", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const awaitingActions = buildTaskPlanCardActions("awaiting-confirm", onConfirm, onCancel, t);
    expect(awaitingActions).toHaveLength(2);
    awaitingActions[0]?.onClick();
    awaitingActions[1]?.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);

    expect(buildTaskPlanCardActions("running", onConfirm, onCancel, t)).toEqual([]);
    expect(buildTaskPlanCardActions("succeeded", onConfirm, onCancel, t)).toEqual([]);
  });

  it("renders task plan card with status and targets", () => {
    const html = renderToStaticMarkup(
      createElement(TaskPlanCard, {
        t,
        taskPlan: createTaskPlan("awaiting-confirm"),
        actionLabel: "assistant.actionWriteNext",
        targetBookTitles: ["测试书籍"],
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("assistant-task-plan-card");
    expect(html).toContain("assistant.planStatusAwaitingConfirm");
    expect(html).toContain("assistant.confirmTargets");
    expect(html).toContain("assistant-confirm-action");
    expect(html).toContain("assistant-cancel-action");
  });
});
