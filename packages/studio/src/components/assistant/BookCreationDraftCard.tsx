/**
 * BookCreationDraftCard — displays the AI-generated book creation draft
 * in the assistant conversation, allowing the user to confirm or refine it.
 */

import type { BookCreationDraftPayload } from "../../api/services/assistant-artifact-service";

interface BookCreationDraftCardProps {
  readonly payload: BookCreationDraftPayload;
  readonly onConfirm: () => void;
  readonly onRefine: (prefillText: string) => void;
  readonly disabled?: boolean;
  readonly isCreated?: boolean;
  readonly createdBookId?: string;
}

interface DraftRowProps {
  readonly label: string;
  readonly value: string | undefined;
  readonly fieldHint: string;
  readonly onRefine: (prefillText: string) => void;
  readonly disabled?: boolean;
}

function DraftRow({ label, value, fieldHint, onRefine, disabled }: DraftRowProps) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-border/40 last:border-0">
      <span className="shrink-0 w-20 text-xs text-muted-foreground pt-0.5">{label}</span>
      <span className="flex-1 text-sm text-foreground leading-relaxed">{value}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onRefine(fieldHint)}
        className="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        aria-label={`修改${label}`}
      >
        改
      </button>
    </div>
  );
}

export function BookCreationDraftCard({
  payload,
  onConfirm,
  onRefine,
  disabled,
  isCreated,
  createdBookId,
}: BookCreationDraftCardProps) {
  const styleRulesText = payload.styleRules?.join("、");
  const wordCountText = payload.chapterWordCount ? `${payload.chapterWordCount} 字/章` : undefined;

  return (
    <section
      className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3"
      data-testid="book-creation-draft-card"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">📖 书籍草案</h3>
        <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {isCreated ? "已创建" : payload.stage === "confirmed" ? "已确认" : "草案"}
        </span>
      </div>

      {/* Fields */}
      <div className="rounded-md border border-border/60 bg-background/60 px-3 py-1">
        <DraftRow
          label="书名"
          value={`《${payload.title}》`}
          fieldHint={`改书名为`}
          onRefine={onRefine}
          disabled={disabled || isCreated}
        />
        <DraftRow
          label="体裁"
          value={payload.genre}
          fieldHint="改体裁为"
          onRefine={onRefine}
          disabled={disabled || isCreated}
        />
        <DraftRow
          label="受众"
          value={payload.audience}
          fieldHint="改受众定位为"
          onRefine={onRefine}
          disabled={disabled || isCreated}
        />
        <DraftRow
          label="主角"
          value={payload.protagonist}
          fieldHint="改主角设定为"
          onRefine={onRefine}
          disabled={disabled || isCreated}
        />
        <DraftRow
          label="核心爽点"
          value={payload.coreConflict}
          fieldHint="改核心爽点为"
          onRefine={onRefine}
          disabled={disabled || isCreated}
        />
        {payload.femaleLeads && (
          <DraftRow
            label="女主搭配"
            value={payload.femaleLeads}
            fieldHint="改女主搭配为"
            onRefine={onRefine}
            disabled={disabled || isCreated}
          />
        )}
        {payload.firstVolumePlan && (
          <DraftRow
            label="第一卷"
            value={payload.firstVolumePlan}
            fieldHint="改第一卷规划为"
            onRefine={onRefine}
            disabled={disabled || isCreated}
          />
        )}
        {styleRulesText && (
          <DraftRow
            label="文风标签"
            value={styleRulesText}
            fieldHint="改文风标签为"
            onRefine={onRefine}
            disabled={disabled || isCreated}
          />
        )}
        {wordCountText && (
          <DraftRow
            label="章节字数"
            value={wordCountText}
            fieldHint="改章节字数为"
            onRefine={onRefine}
            disabled={disabled || isCreated}
          />
        )}
      </div>

      {/* Actions */}
      {!isCreated && payload.stage !== "confirmed" && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRefine("我想修改")}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            ✏️ 修改某项内容
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onConfirm}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="book-creation-draft-confirm"
          >
            ✅ 确认创建
          </button>
        </div>
      )}

      {isCreated && createdBookId && (
        <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400">
          <span className="flex-1">📖 书籍已创建成功！</span>
          <a
            href={`/?bookId=${createdBookId}`}
            className="font-medium underline hover:no-underline"
          >
            进入书籍 →
          </a>
        </div>
      )}
    </section>
  );
}
