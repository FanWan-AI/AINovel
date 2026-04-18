import type { AssistantGoalToBookProgress } from "../../pages/AssistantView";

export function GoalToBookWizard({
  value,
  onChange,
  onSubmit,
  disabled,
  activeBookTitle,
  progress,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
  readonly activeBookTitle?: string | null;
  readonly progress?: AssistantGoalToBookProgress | null;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-3" data-testid="assistant-goal-to-book-wizard">
      <div className="space-y-1">
        <div className="text-sm font-medium">Goal-to-Book 向导</div>
        <div className="text-xs text-muted-foreground">
          输入一句话目标，生成蓝图 → 写审修循环 → 发布候选任务流。
          {activeBookTitle ? ` 当前书籍：《${activeBookTitle}》` : " 请先锁定一本书。"}
        </div>
      </div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="例：一个普通人误入修真学院，并在 2 章内完成蓝图与首轮创作。"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="assistant-goal-to-book-input"
          disabled={disabled}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="assistant-goal-to-book-submit"
        >
          生成任务流
        </button>
      </div>
      {progress && (
        <div className="space-y-2 rounded-lg border border-border/70 bg-background/80 p-3" data-testid="assistant-goal-to-book-progress">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>当前阶段：阶段 {progress.currentStageIndex}/7 · {progress.currentStageLabel}</span>
            <span>预计剩余 {progress.remainingSteps} 步</span>
          </div>
          <div className="grid grid-cols-7 gap-1" aria-label="goal to book stage progress">
            {progress.stages.map((stage) => (
              <div
                key={stage.index}
                className={
                  stage.status === "complete"
                    ? "rounded bg-primary/20 px-1.5 py-1 text-center text-[10px] text-primary"
                    : stage.status === "current"
                      ? "rounded bg-primary px-1.5 py-1 text-center text-[10px] text-primary-foreground"
                      : "rounded bg-muted px-1.5 py-1 text-center text-[10px] text-muted-foreground"
                }
              >
                {stage.label}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{progress.currentStepLabel}</span>
            <span>
              章节循环 {progress.completedChapterLoops}/{progress.chapterLoopTarget}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
