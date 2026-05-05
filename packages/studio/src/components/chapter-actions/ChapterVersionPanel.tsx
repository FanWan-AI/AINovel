import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, RotateCcw, X } from "lucide-react";
import { fetchJson } from "../../hooks/use-api";
import type { TFunction } from "../../hooks/use-i18n";

interface VersionEntry {
  readonly versionId: string;
  readonly createdAt: string;
  readonly actionType: string;
  readonly label: string;
  readonly hasContent: boolean;
}

interface VersionDetail {
  readonly versionId: string;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
  readonly actionType: string;
  readonly label: string;
}

interface ChapterVersionPanelProps {
  readonly open: boolean;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly t: TFunction;
  readonly onClose: () => void;
  readonly onRestored?: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  revise: "微调",
  rewrite: "重生成",
  "anti-detect": "降低AI痕迹",
  resync: "同步",
  "length-normalize": "审计前字数归一化",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

// ---------- Inline diff ----------

type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

/**
 * Sentence-level diff using LCS (longest common subsequence).
 * Splits text into sentences / short segments for readable granularity.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation but keep the delimiter attached.
  return text.split(/(?<=[。！？\n；;.!?])/u).filter(Boolean);
}

function computeLCS(a: string[], b: string[]): boolean[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // Backtrack to produce a membership table
  const inLCS: boolean[][] = [Array(m).fill(false) as boolean[], Array(n).fill(false) as boolean[]];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      inLCS[0]![i] = true;
      inLCS[1]![j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return inLCS;
}

function computeDiff(before: string, after: string): { beforeOps: DiffOp[]; afterOps: DiffOp[] } {
  const aSents = splitSentences(before);
  const bSents = splitSentences(after);
  const inLCS = computeLCS(aSents, bSents);

  const beforeOps: DiffOp[] = aSents.map((s, i) => ({
    type: inLCS[0]![i] ? "equal" as const : "delete" as const,
    text: s,
  }));
  const afterOps: DiffOp[] = bSents.map((s, i) => ({
    type: inLCS[1]![i] ? "equal" as const : "insert" as const,
    text: s,
  }));
  return { beforeOps, afterOps };
}

function DiffContent({ ops }: { readonly ops: ReadonlyArray<DiffOp> }) {
  return (
    <div className="text-xs leading-relaxed whitespace-pre-wrap">
      {ops.map((op, i) => {
        if (op.type === "equal") {
          return <span key={i}>{op.text}</span>;
        }
        if (op.type === "delete") {
          return (
            <span key={i} className="bg-red-200/80 text-red-950 dark:bg-red-900/50 dark:text-red-200 rounded-sm px-0.5">
              {op.text}
            </span>
          );
        }
        return (
          <span key={i} className="bg-emerald-200/80 text-emerald-950 dark:bg-emerald-900/50 dark:text-emerald-200 rounded-sm px-0.5">
            {op.text}
          </span>
        );
      })}
    </div>
  );
}

function VersionDetailView({
  selectedVersion,
}: {
  readonly selectedVersion: VersionDetail;
}) {
  const diff = useMemo(() => {
    if (!selectedVersion.beforeContent || !selectedVersion.afterContent) return null;
    return computeDiff(selectedVersion.beforeContent, selectedVersion.afterContent);
  }, [selectedVersion.beforeContent, selectedVersion.afterContent]);

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const handleScroll = useCallback((source: "left" | "right") => {
    if (syncing.current) return;
    syncing.current = true;
    const from = source === "left" ? leftRef.current : rightRef.current;
    const to = source === "left" ? rightRef.current : leftRef.current;
    if (from && to) {
      const ratio = from.scrollTop / (from.scrollHeight - from.clientHeight || 1);
      to.scrollTop = ratio * (to.scrollHeight - to.clientHeight || 1);
    }
    syncing.current = false;
  }, []);

  return (
    <div className="space-y-4">
      <div className="text-sm font-medium">
        {ACTION_LABELS[selectedVersion.actionType] ?? selectedVersion.actionType}
        {selectedVersion.label !== selectedVersion.actionType && (
          <span className="text-muted-foreground ml-2">· {selectedVersion.label}</span>
        )}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-red-100 dark:bg-red-900/40 border border-red-200 dark:border-red-800" />
          删除内容
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-emerald-100 dark:bg-emerald-900/40 border border-emerald-200 dark:border-emerald-800" />
          新增内容
        </span>
      </div>
      {/* Side-by-side diff */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <h4 className="text-xs font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400 dark:bg-red-500" />
            修改前
          </h4>
          <div ref={leftRef} onScroll={() => handleScroll("left")} className="rounded-xl border border-border/40 bg-secondary/20 p-4 max-h-[50vh] overflow-y-auto">
            {diff ? (
              <DiffContent ops={diff.beforeOps} />
            ) : (
              <div className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
                {selectedVersion.beforeContent ?? "（无内容）"}
              </div>
            )}
          </div>
        </div>
        <div>
          <h4 className="text-xs font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 dark:bg-emerald-500" />
            修改后
          </h4>
          <div ref={rightRef} onScroll={() => handleScroll("right")} className="rounded-xl border border-border/40 bg-secondary/20 p-4 max-h-[50vh] overflow-y-auto">
            {diff ? (
              <DiffContent ops={diff.afterOps} />
            ) : (
              <div className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
                {selectedVersion.afterContent ?? "（无内容）"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChapterVersionPanel({
  open,
  bookId,
  chapterNumber,
  t,
  onClose,
  onRestored,
}: ChapterVersionPanelProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<VersionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ versions: VersionEntry[] }>(
        `/books/${bookId}/chapters/${chapterNumber}/versions`,
      );
      setVersions(data.versions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [bookId, chapterNumber]);

  useEffect(() => {
    if (open) {
      void loadVersions();
      setSelectedVersion(null);
    }
  }, [open, loadVersions]);

  const loadDetail = async (versionId: string) => {
    setDetailLoading(true);
    try {
      const detail = await fetchJson<VersionDetail>(
        `/books/${bookId}/chapters/${chapterNumber}/versions/${versionId}`,
      );
      setSelectedVersion(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRestore = async (versionId: string) => {
    const confirmed = window.confirm("确认恢复到此版本？当前内容将被替换。");
    if (!confirmed) return;
    setRestoring(true);
    try {
      await fetchJson<{ ok: boolean }>(
        `/books/${bookId}/chapters/${chapterNumber}/restore/${versionId}`,
        { method: "POST" },
      );
      onRestored?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-5xl mx-4 max-h-[85vh] rounded-3xl border border-border/50 bg-card shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between shrink-0 bg-card border-b border-border/40">
          <div className="flex items-center gap-3">
            {selectedVersion ? (
              <button
                onClick={() => setSelectedVersion(null)}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
              >
                ← 返回版本列表
              </button>
            ) : (
              <>
                <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
                  <History size={18} className="text-primary" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold">{t("book.versions")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t("chapterAction.chapterPrefix")} {chapterNumber}
                  </p>
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedVersion && (
              <button
                onClick={() => handleRestore(selectedVersion.versionId)}
                disabled={restoring || !selectedVersion.beforeContent}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl border border-primary/30 bg-primary/5 text-primary hover:bg-primary hover:text-white transition-colors disabled:opacity-50"
              >
                <RotateCcw size={14} />
                恢复到此版本
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-4">
          {loading && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              {t("common.loading")}
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive py-4 text-center">{error}</div>
          )}

          {!loading && !error && versions.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              暂无版本记录
            </div>
          )}

          {!loading && versions.length > 0 && !selectedVersion && (
            <div className="space-y-2">
              {versions.map((v) => (
                <div
                  key={v.versionId}
                  className="rounded-xl border border-border/40 bg-card/50 px-4 py-3 flex items-center justify-between gap-2"
                >
                  <div className="text-sm">
                    <span className="font-medium">{formatTime(v.createdAt)}</span>
                    <span className="text-muted-foreground ml-2">
                      {ACTION_LABELS[v.actionType] ?? v.actionType}
                    </span>
                    {v.label !== v.actionType && (
                      <span className="text-xs text-muted-foreground ml-2 truncate max-w-[200px] inline-block align-bottom">
                        · {v.label}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => loadDetail(v.versionId)}
                      disabled={detailLoading}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border/50 bg-secondary/30 hover:bg-secondary/60 transition-colors"
                    >
                      查看
                    </button>
                    {v.hasContent && (
                      <button
                        onClick={() => handleRestore(v.versionId)}
                        disabled={restoring}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border border-primary/30 bg-primary/5 text-primary hover:bg-primary hover:text-white transition-colors disabled:opacity-50"
                      >
                        <RotateCcw size={12} />
                        恢复
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedVersion && (
            <VersionDetailView
              selectedVersion={selectedVersion}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
