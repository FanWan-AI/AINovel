import { useEffect, useRef } from "react";
import { FileDiff, X } from "lucide-react";
import type { TFunction } from "../../hooks/use-i18n";

export interface ChapterRunBriefTraceItem {
  readonly text: string;
  readonly matched: boolean;
}

export interface ChapterRunDiffPayload {
  readonly runId: string;
  readonly chapter: number;
  readonly actionType: string;
  readonly decision: string | null;
  readonly unchangedReason: string | null;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
  readonly briefTrace: ReadonlyArray<ChapterRunBriefTraceItem>;
  readonly pendingApproval?: boolean;
  /** P5 fields — present only for blueprint-targeted-revise runs */
  readonly candidateStatus?: "ready-for-review" | "audit-failed";
  readonly candidateAuditIssues?: ReadonlyArray<string>;
}

interface ChapterDiffDialogProps {
  readonly open: boolean;
  readonly loading: boolean;
  readonly approving?: boolean;
  readonly error: string | null;
  readonly payload: ChapterRunDiffPayload | null;
  readonly t: TFunction;
  readonly onClose: () => void;
  readonly onApprove?: (runId: string, force?: boolean) => Promise<void>;
}

type SegmentKind = "same" | "add" | "remove";

interface DiffSegment {
  readonly kind: SegmentKind;
  readonly text: string;
}

type DiffRowKind = "equal" | "add" | "remove" | "change";

export interface DiffRow {
  readonly kind: DiffRowKind;
  readonly beforeText: string | null;
  readonly afterText: string | null;
}

type RawDiffOp =
  | { readonly kind: "equal"; readonly value: string }
  | { readonly kind: "remove"; readonly value: string }
  | { readonly kind: "add"; readonly value: string };

function splitLines(input: string): string[] {
  return input.split(/\r?\n/);
}

function createLcsMatrix(a: readonly string[], b: readonly string[]): number[][] {
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = a[i] === b[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  return matrix;
}

function buildRawDiffOps(beforeLines: readonly string[], afterLines: readonly string[]): RawDiffOp[] {
  const matrix = createLcsMatrix(beforeLines, afterLines);
  const ops: RawDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ kind: "equal", value: beforeLines[i] });
      i += 1;
      j += 1;
      continue;
    }
    if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      ops.push({ kind: "remove", value: beforeLines[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", value: afterLines[j] });
      j += 1;
    }
  }
  while (i < beforeLines.length) {
    ops.push({ kind: "remove", value: beforeLines[i] });
    i += 1;
  }
  while (j < afterLines.length) {
    ops.push({ kind: "add", value: afterLines[j] });
    j += 1;
  }
  return ops;
}

export function buildDiffRows(beforeContent: string, afterContent: string): DiffRow[] {
  const ops = buildRawDiffOps(splitLines(beforeContent), splitLines(afterContent));
  const rows: DiffRow[] = [];
  let idx = 0;
  while (idx < ops.length) {
    const current = ops[idx];
    if (current.kind === "equal") {
      rows.push({ kind: "equal", beforeText: current.value, afterText: current.value });
      idx += 1;
      continue;
    }
    if (current.kind === "remove") {
      const removed: string[] = [];
      while (idx < ops.length && ops[idx].kind === "remove") {
        removed.push(ops[idx].value);
        idx += 1;
      }
      const added: string[] = [];
      let probe = idx;
      while (probe < ops.length && ops[probe].kind === "add") {
        added.push(ops[probe].value);
        probe += 1;
      }
      if (added.length > 0) {
        const paired = Math.max(removed.length, added.length);
        for (let offset = 0; offset < paired; offset += 1) {
          rows.push({
            kind: "change",
            beforeText: removed[offset] ?? null,
            afterText: added[offset] ?? null,
          });
        }
        idx = probe;
      } else {
        removed.forEach((line) => rows.push({ kind: "remove", beforeText: line, afterText: null }));
      }
      continue;
    }
    const added: string[] = [];
    while (idx < ops.length && ops[idx].kind === "add") {
      added.push(ops[idx].value);
      idx += 1;
    }
    added.forEach((line) => rows.push({ kind: "add", beforeText: null, afterText: line }));
  }
  return rows;
}

function tokenizeForInlineDiff(input: string): string[] {
  if (/[一-龥]/.test(input)) {
    return Array.from(input);
  }
  return input.split(/(\s+|[^\w\s])/).filter((token) => token.length > 0);
}

function buildTokenOps(beforeTokens: readonly string[], afterTokens: readonly string[]): RawDiffOp[] {
  const matrix = createLcsMatrix(beforeTokens, afterTokens);
  const ops: RawDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeTokens.length && j < afterTokens.length) {
    if (beforeTokens[i] === afterTokens[j]) {
      ops.push({ kind: "equal", value: beforeTokens[i] });
      i += 1;
      j += 1;
      continue;
    }
    if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      ops.push({ kind: "remove", value: beforeTokens[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", value: afterTokens[j] });
      j += 1;
    }
  }
  while (i < beforeTokens.length) {
    ops.push({ kind: "remove", value: beforeTokens[i] });
    i += 1;
  }
  while (j < afterTokens.length) {
    ops.push({ kind: "add", value: afterTokens[j] });
    j += 1;
  }
  return ops;
}

function mergeSegments(segments: DiffSegment[]): DiffSegment[] {
  if (segments.length === 0) return [];
  const merged: DiffSegment[] = [segments[0]];
  for (let idx = 1; idx < segments.length; idx += 1) {
    const current = segments[idx];
    const prev = merged[merged.length - 1];
    if (prev.kind === current.kind) {
      merged[merged.length - 1] = { kind: prev.kind, text: prev.text + current.text };
    } else {
      merged.push(current);
    }
  }
  return merged;
}

export function buildInlineDiffSegments(beforeText: string, afterText: string): {
  readonly before: DiffSegment[];
  readonly after: DiffSegment[];
} {
  const tokenOps = buildTokenOps(tokenizeForInlineDiff(beforeText), tokenizeForInlineDiff(afterText));
  const beforeSegments = mergeSegments(
    tokenOps
      .filter((item) => item.kind !== "add")
      .map((item) => ({ kind: item.kind === "remove" ? "remove" : "same", text: item.value })),
  );
  const afterSegments = mergeSegments(
    tokenOps
      .filter((item) => item.kind !== "remove")
      .map((item) => ({ kind: item.kind === "add" ? "add" : "same", text: item.value })),
  );
  return { before: beforeSegments, after: afterSegments };
}

function actionLabel(actionType: string, t: TFunction): string {
  if (actionType === "rewrite") return t("book.rewrite");
  if (actionType === "anti-detect") return t("book.antiDetect");
  if (actionType === "resync") return t("chapterTaskCenter.actionResync");
  return t("book.spotFix");
}

function lineCellClass(kind: DiffRowKind, side: "before" | "after"): string {
  if (kind === "change") return side === "before" ? "bg-rose-500/8 border-l-2 border-rose-500/40" : "bg-emerald-500/8 border-l-2 border-emerald-500/40";
  if (kind === "remove" && side === "before") return "bg-rose-500/10 border-l-2 border-rose-500/45";
  if (kind === "add" && side === "after") return "bg-emerald-500/10 border-l-2 border-emerald-500/45";
  return "";
}

function segmentClass(kind: SegmentKind): string {
  if (kind === "remove") return "bg-rose-500/30 text-rose-700 dark:text-rose-200 rounded px-0.5";
  if (kind === "add") return "bg-emerald-500/30 text-emerald-700 dark:text-emerald-200 rounded px-0.5";
  return "";
}

export function ChapterDiffDialog({
  open,
  loading,
  approving = false,
  error,
  payload,
  t,
  onClose,
  onApprove,
}: ChapterDiffDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const diffRows = payload ? buildDiffRows(payload.beforeContent ?? "", payload.afterContent ?? "") : [];

  useEffect(() => {
    if (!open || loading) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [loading, onClose, open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === overlayRef.current && !loading) onClose();
      }}
    >
      <div className="w-full max-w-6xl mx-4 rounded-3xl border border-border/50 bg-card shadow-2xl shadow-primary/15 overflow-hidden">
        <div className="px-6 pt-6 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
              <FileDiff size={18} className="text-primary" />
            </div>
            <div>
              <h3 className="text-xl font-semibold">{t("chapterDiff.dialogTitle")}</h3>
              {payload && (
                <p className="text-xs text-muted-foreground">
                  {t("chapterAction.chapterPrefix")} {payload.chapter} · {actionLabel(payload.actionType, t)}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 pb-6 space-y-4">
          {loading && (
            <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-6 text-sm text-muted-foreground">
              {t("chapterDiff.loading")}
            </div>
          )}

          {!loading && error && (
            <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && payload && (
            <>
              {payload.decision === "unchanged" && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="font-semibold">{t("chapterDiff.unchangedReasonLabel")}</span>{" "}
                      {payload.unchangedReason ?? t("chapterDiff.unchangedReasonFallback")}
                    </div>
                    {payload.pendingApproval && onApprove && payload.candidateStatus !== "audit-failed" && (
                      <button
                        onClick={() => { void onApprove(payload.runId); }}
                        disabled={approving}
                        className="px-3 py-1.5 text-xs font-bold rounded-lg border border-emerald-500/40 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 disabled:opacity-50"
                      >
                        {approving ? t("common.loading") : t("chapterDiff.approveCandidate")}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* P5 audit-failed warning: show when the blueprint-targeted-revise candidate did not pass audit */}
              {payload.actionType === "blueprint-targeted-revise" && payload.candidateStatus === "audit-failed" && (
                <div className="rounded-xl border border-destructive/35 bg-destructive/8 px-4 py-3 text-sm text-destructive space-y-2">
                  <div className="font-semibold">⚠️ 蓝图定点修订未通过审计，建议手动核查后在修复过后再应用。</div>
                  {payload.candidateAuditIssues && payload.candidateAuditIssues.length > 0 && (
                    <ul className="list-disc list-inside space-y-0.5 text-xs">
                      {payload.candidateAuditIssues.map((issue, idx) => (
                        <li key={idx}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  {payload.pendingApproval && onApprove && (
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => { void onApprove(payload.runId, true); }}
                        disabled={approving}
                        className="px-3 py-1.5 text-xs font-bold rounded-lg border border-destructive/40 bg-destructive/15 text-destructive hover:bg-destructive/25 disabled:opacity-50"
                      >
                        {approving ? t("common.loading") : "强制应用（已知风险）"}
                      </button>
                      <span className="text-xs text-muted-foreground">仅当您确认风险后使用</span>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("chapterDiff.briefTraceTitle")}</h4>
                {payload.briefTrace.length === 0 ? (
                  <div className="rounded-xl border border-border/40 bg-secondary/20 px-4 py-3 text-sm text-muted-foreground">
                    {t("chapterDiff.briefTraceEmpty")}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {payload.briefTrace.map((item, index) => (
                      <li key={index} className="rounded-xl border border-border/40 bg-secondary/20 px-3 py-2 flex items-center justify-between gap-3">
                        <span className="text-sm">{item.text}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${item.matched ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                          {item.matched ? t("chapterDiff.traceMatched") : t("chapterDiff.traceMissed")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/40 bg-secondary/10 overflow-hidden lg:col-span-2">
                  <div className="grid grid-cols-2 border-b border-border/40 bg-secondary/40">
                    <div className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("chapterDiff.beforeTitle")}</div>
                    <div className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-muted-foreground border-l border-border/40">{t("chapterDiff.afterTitle")}</div>
                  </div>
                  <div className="max-h-[55vh] overflow-auto">
                    {diffRows.length === 0 ? (
                      <div className="px-3 py-4 text-sm text-muted-foreground">{t("chapterDiff.emptyContent")}</div>
                    ) : (
                      diffRows.map((row, index) => {
                        const inlineSegments = row.kind === "change" && row.beforeText !== null && row.afterText !== null
                          ? buildInlineDiffSegments(row.beforeText, row.afterText)
                          : null;
                        const beforeSegments = inlineSegments
                          ? inlineSegments.before
                          : [{ kind: "same", text: row.beforeText ?? "" }] as DiffSegment[];
                        const afterSegments = inlineSegments
                          ? inlineSegments.after
                          : [{ kind: "same", text: row.afterText ?? "" }] as DiffSegment[];
                        return (
                          <div key={index} className="grid grid-cols-2 border-b border-border/30 last:border-b-0">
                            <div className={`px-3 py-2.5 text-xs leading-relaxed font-mono whitespace-pre-wrap break-words ${lineCellClass(row.kind, "before")}`}>
                              {row.beforeText === null ? <span className="text-muted-foreground/60">∅</span> : beforeSegments.map((segment, segIndex) => (
                                <span key={segIndex} className={segmentClass(segment.kind)}>{segment.text}</span>
                              ))}
                            </div>
                            <div className={`px-3 py-2.5 text-xs leading-relaxed font-mono whitespace-pre-wrap break-words border-l border-border/40 ${lineCellClass(row.kind, "after")}`}>
                              {row.afterText === null ? <span className="text-muted-foreground/60">∅</span> : afterSegments.map((segment, segIndex) => (
                                <span key={segIndex} className={segmentClass(segment.kind)}>{segment.text}</span>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
