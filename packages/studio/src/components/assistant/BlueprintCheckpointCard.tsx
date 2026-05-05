/**
 * BlueprintCheckpointCard — shown when a task is paused at a blueprint-confirm checkpoint.
 * Fetches the blueprint artifact by ID, renders it for user review, then lets them approve.
 */

import { useEffect, useState } from "react";
import { fetchJson } from "../../hooks/use-api";
import { BlueprintPreviewCard, type BlueprintPreviewPayload } from "./BlueprintPreviewCard";

interface Props {
  readonly nodeId: string;
  readonly blueprintArtifactId: string;
  readonly sessionId: string;
  readonly bookId?: string;
  readonly taskId: string;
  readonly disabled?: boolean;
  readonly onApprove: (nodeId: string) => void | Promise<void>;
  readonly onBlueprintEdit?: (updated: Record<string, unknown>) => void;
}

export function BlueprintCheckpointCard({
  nodeId,
  blueprintArtifactId,
  sessionId,
  bookId,
  taskId,
  disabled,
  onApprove,
  onBlueprintEdit,
}: Props) {
  const [blueprint, setBlueprint] = useState<(BlueprintPreviewPayload & { artifactId?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState("");
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ sessionId });
    if (bookId) params.set("bookId", bookId);
    fetchJson<{ artifact: { payload: Record<string, unknown> } }>(
      `/assistant/artifact/${blueprintArtifactId}?${params.toString()}`,
    )
      .then((data) => {
        if (cancelled) return;
        const payload = data.artifact.payload;
        setBlueprint({ ...(payload as unknown as BlueprintPreviewPayload), artifactId: blueprintArtifactId });
        setEditText(JSON.stringify(payload, null, 2));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [blueprintArtifactId, sessionId, bookId]);

  const handleEditSubmit = async () => {
    setEditError("");
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(editText) as Record<string, unknown>;
    } catch {
      setEditError("JSON 格式错误，请检查后重试");
      return;
    }
    try {
      const data = await fetchJson<{ blueprint: Record<string, unknown> }>(
        `/assistant/blueprint/${blueprintArtifactId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, bookId, patch }),
        },
      );
      setBlueprint({ ...(data.blueprint as unknown as BlueprintPreviewPayload), artifactId: blueprintArtifactId });
      setEditText(JSON.stringify(data.blueprint, null, 2));
      setEditOpen(false);
      onBlueprintEdit?.(data.blueprint);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleApprove = async () => {
    if (approving || disabled) return;
    setApproving(true);
    try {
      await onApprove(nodeId);
    } finally {
      setApproving(false);
    }
  };

  if (loading) {
    return (
      <section className="mt-3 rounded-md border border-amber-300/50 bg-amber-50/60 p-3 dark:border-amber-800/40 dark:bg-amber-950/20">
        <div className="text-sm text-muted-foreground animate-pulse">正在加载蓝图…</div>
      </section>
    );
  }

  if (error || !blueprint) {
    return (
      <section className="mt-3 rounded-md border border-amber-300/50 bg-amber-50/60 p-3 dark:border-amber-800/40 dark:bg-amber-950/20">
        <div className="text-sm font-medium">任务等待你的确认 — 蓝图确认节点（{nodeId}）</div>
        {error && <div className="mt-1 text-xs text-destructive">蓝图加载失败：{error}</div>}
        <div className="mt-3">
          <button
            type="button"
            disabled={disabled ?? approving}
            onClick={() => void handleApprove()}
            className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="assistant-checkpoint-approve"
          >
            继续执行（审批）
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-3 space-y-2" data-testid="blueprint-checkpoint-card">
      <div className="rounded-md border border-amber-300/50 bg-amber-50/60 px-3 py-2 dark:border-amber-800/40 dark:bg-amber-950/20">
        <div className="text-sm font-medium">📋 请确认下方章节蓝图，然后点击"继续执行"启动写作</div>
        <div className="mt-0.5 text-xs text-muted-foreground">审批节点：{nodeId} | 任务：{taskId}</div>
      </div>

      <BlueprintPreviewCard
        blueprint={blueprint}
        onConfirm={() => void handleApprove()}
        onEdit={() => {
          setEditText(JSON.stringify(blueprint, null, 2));
          setEditOpen(true);
        }}
      />

      {editOpen && (
        <div className="rounded-md border border-border bg-card/50 p-3 space-y-2" data-testid="blueprint-edit-panel">
          <div className="text-xs font-medium text-foreground">编辑蓝图（直接修改 JSON）</div>
          <textarea
            className="w-full rounded border border-border bg-background p-2 text-xs font-mono h-48 resize-y"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            data-testid="blueprint-edit-textarea"
          />
          {editError && (
            <div className="text-xs text-destructive" data-testid="blueprint-edit-error">{editError}</div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground"
              onClick={() => { setEditOpen(false); setEditError(""); }}
            >
              取消
            </button>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => void handleEditSubmit()}
              data-testid="blueprint-edit-submit"
            >
              保存蓝图
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={disabled ?? approving}
          onClick={() => void handleApprove()}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="assistant-checkpoint-approve"
        >
          {approving ? "处理中…" : "继续执行（审批）"}
        </button>
      </div>
    </section>
  );
}
