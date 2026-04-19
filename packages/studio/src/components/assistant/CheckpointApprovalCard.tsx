export function CheckpointApprovalCard({
  nodeId,
  label,
  disabled,
  onApprove,
}: {
  readonly nodeId: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly onApprove: (nodeId: string) => void;
}) {
  return (
    <section className="mt-3 rounded-md border border-amber-300/50 bg-amber-50/60 p-3 dark:border-amber-800/40 dark:bg-amber-950/20">
      <div className="text-sm font-medium">任务等待你的确认</div>
      <div className="mt-1 text-xs text-muted-foreground">
        当前节点：{label && label.trim().length > 0 ? label : nodeId}（{nodeId}）
      </div>
      <div className="mt-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onApprove(nodeId)}
          className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="assistant-checkpoint-approve"
        >
          继续执行（审批）
        </button>
      </div>
    </section>
  );
}

