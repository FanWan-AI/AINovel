import type { TFunction } from "../../hooks/use-i18n";
import type { AssistantTaskPlan, AssistantTaskPlanStatus } from "../../pages/AssistantView";

export interface TaskPlanCardAction {
  readonly id: "confirm" | "cancel";
  readonly label: string;
  readonly onClick: () => void;
  readonly testId: "assistant-confirm-action" | "assistant-cancel-action";
  readonly className: string;
}

const TASK_PLAN_STATUS_KEY: Record<AssistantTaskPlanStatus, "assistant.planStatusDraft" | "assistant.planStatusAwaitingConfirm" | "assistant.planStatusRunning" | "assistant.planStatusSucceeded" | "assistant.planStatusFailed" | "assistant.planStatusCancelled"> = {
  draft: "assistant.planStatusDraft",
  "awaiting-confirm": "assistant.planStatusAwaitingConfirm",
  running: "assistant.planStatusRunning",
  succeeded: "assistant.planStatusSucceeded",
  failed: "assistant.planStatusFailed",
  cancelled: "assistant.planStatusCancelled",
};

export function resolveTaskPlanStatusKey(status: AssistantTaskPlanStatus) {
  return TASK_PLAN_STATUS_KEY[status];
}

export function buildTaskPlanCardActions(
  status: AssistantTaskPlanStatus,
  onConfirm: () => void,
  onCancel: () => void,
  t: TFunction,
): ReadonlyArray<TaskPlanCardAction> {
  if (status !== "awaiting-confirm") {
    return [];
  }
  return [
    {
      id: "confirm",
      label: t("assistant.confirm"),
      onClick: onConfirm,
      testId: "assistant-confirm-action",
      className: "h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground",
    },
    {
      id: "cancel",
      label: t("assistant.cancel"),
      onClick: onCancel,
      testId: "assistant-cancel-action",
      className: "h-8 rounded-md border border-border px-3 text-xs text-muted-foreground",
    },
  ];
}

export function TaskPlanCard({
  t,
  taskPlan,
  actionLabel,
  chapterLabel,
  targetBookTitles,
  onConfirm,
  onCancel,
}: {
  t: TFunction;
  taskPlan: AssistantTaskPlan;
  actionLabel: string;
  chapterLabel?: string;
  targetBookTitles: ReadonlyArray<string>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const actions = buildTaskPlanCardActions(taskPlan.status, onConfirm, onCancel, t);
  return (
    <div className="mt-3 rounded-xl border border-primary/40 bg-card p-4 space-y-2" data-testid="assistant-task-plan-card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{t("assistant.planTitle")}</div>
        <div className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {t("assistant.planStatus")} · {t(resolveTaskPlanStatusKey(taskPlan.status))}
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {actionLabel}
        {chapterLabel ? ` · ${chapterLabel}` : ""}
      </div>
      <div className="text-xs text-muted-foreground">
        {t("assistant.confirmTargets")}：{targetBookTitles.join("、")}
      </div>
      <div className="text-xs text-muted-foreground">
        {t("assistant.planPrompt")}：{taskPlan.prompt}
      </div>
      {actions.length > 0 && (
        <div className="flex items-center gap-2 pt-1">
          {actions.map((action) => (
            <button key={action.id} onClick={action.onClick} className={action.className} data-testid={action.testId}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
