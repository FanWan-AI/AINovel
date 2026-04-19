import { fetchJson, useApi } from "../hooks/use-api";
import { useState } from "react";
import { Children, cloneElement, isValidElement } from "react";
import type { ReactNode } from "react";
import type { CSSProperties } from "react";
import type { ReactElement, JSXElementConstructor } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Code2, Eye, Pencil, Save, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface TruthFile {
  readonly name: string;
  readonly size: number;
  readonly preview: string;
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
}

function unwrapOuterCodeFence(markdown: string): string {
  const trimmed = markdown.trim();
  const opening = trimmed.match(/^```[^\n]*\n/);
  if (!opening) return markdown;
  if (!trimmed.endsWith("```")) return markdown;
  const body = trimmed.slice(opening[0].length, -3).trimStart();
  return body;
}

// ---------------------------------------------------------------------------
// Structured-data helpers for author_intent.md / book_rules.md
// ---------------------------------------------------------------------------

/** Field display labels for CreativeBrief JSON keys */
const BRIEF_FIELD_LABELS: Record<string, string> = {
  title: "书名",
  coreGenres: "核心题材",
  positioning: "故事定位",
  worldSetting: "世界观",
  protagonist: "主角",
  mainConflict: "主冲突",
  endingDirection: "结局方向",
  styleRules: "风格规则",
  forbiddenPatterns: "禁止模式",
  targetAudience: "目标读者",
  platformIntent: "目标平台",
};

/** Try to parse the entire content as JSON and render it as a structured card view. */
function tryRenderJson(content: string): ReactNode | null {
  const trimmed = content.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null) return null;
    return <JsonFieldCards data={obj} />;
  } catch {
    return null;
  }
}

function JsonFieldCards({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="space-y-5">
      {Object.entries(data).map(([key, value]) => {
        if (value === undefined || value === null || value === "") return null;
        const label = BRIEF_FIELD_LABELS[key] ?? key;
        const displayValue = Array.isArray(value)
          ? value.join(" / ")
          : typeof value === "object"
            ? JSON.stringify(value, null, 2)
            : String(value);
        const isLong = displayValue.length > 100;
        return (
          <div key={key}>
            <div className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1.5">{label}</div>
            <div
              className={`rounded-xl border border-border/40 bg-card/60 px-4 py-3 text-sm leading-7 text-foreground whitespace-pre-wrap ${
                isLong ? "max-h-[280px] overflow-y-auto" : ""
              }`}
            >
              {displayValue}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Splits YAML frontmatter (between ---) from the rest of the markdown body,
 * and renders the YAML as structured key/value cards.
 */
function splitYamlFrontmatter(content: string): { yaml: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  return { yaml: match[1], body: match[2] };
}

/** Book-rules YAML field labels */
const RULES_FIELD_LABELS: Record<string, string> = {
  version: "版本",
  protagonist: "主角设定",
  "protagonist.name": "主角名",
  "protagonist.personalityLock": "性格锁定",
  behavioralConstraints: "行为约束",
  genreLock: "题材锁定",
  "genreLock.primary": "主题材",
  "genreLock.forbidden": "禁止题材",
  prohibitions: "禁止条目",
  chapterTypesOverride: "章节类型覆盖",
  fatigueWordsOverride: "疲劳词覆盖",
  additionalAuditDimensions: "额外审计维度",
  enableFullCastTracking: "完整角色追踪",
  name: "名称",
  personalityLock: "性格特征",
  primary: "主题材",
  forbidden: "禁止",
};

function YamlStructuredView({ yamlText }: { yamlText: string }) {
  // Simple YAML-like key-value parser for the frontmatter
  // Handles: key: value, key: [array], nested objects via indentation
  const lines = yamlText.split(/\r?\n/);
  const entries: Array<{ key: string; value: string }> = [];
  let currentKey = "";
  let currentLines: string[] = [];

  const flush = () => {
    if (currentKey) {
      entries.push({ key: currentKey, value: currentLines.join("\n").trim() });
    }
    currentKey = "";
    currentLines = [];
  };

  for (const line of lines) {
    const topMatch = line.match(/^(\w[\w.]*)\s*:\s*(.*)/);
    if (topMatch && !line.startsWith("  ") && !line.startsWith("\t")) {
      flush();
      currentKey = topMatch[1];
      if (topMatch[2].trim()) {
        currentLines.push(topMatch[2].trim());
      }
    } else if (line.match(/^\s+-\s+/)) {
      // Array item
      const item = line.replace(/^\s+-\s+/, "").trim();
      currentLines.push(`• ${item}`);
    } else if (line.trim() && currentKey) {
      // Continuation of nested content
      currentLines.push(line.trim());
    }
  }
  flush();

  if (entries.length === 0) {
    return <pre className="text-sm whitespace-pre-wrap text-foreground/80">{yamlText}</pre>;
  }

  return (
    <div className="space-y-4">
      {entries.map(({ key, value }, i) => {
        const label = RULES_FIELD_LABELS[key] ?? key;
        const isLong = value.length > 120;
        return (
          <div key={i}>
            <div className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1.5">{label}</div>
            <div
              className={`rounded-xl border border-border/40 bg-card/60 px-4 py-3 text-sm leading-7 text-foreground whitespace-pre-wrap ${
                isLong ? "max-h-[240px] overflow-y-auto" : ""
              }`}
            >
              {value || <span className="text-muted-foreground italic">（空）</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// pending_hooks.md structured renderer
// ---------------------------------------------------------------------------

interface HookEntry {
  id: string;
  meta: string;        // e.g. "物品/身世, 可见现旧债, 已开4章"
  sections: Array<{ heading: string; items: string[] }>;
}

function parsePendingHooks(content: string): HookEntry[] | null {
  // Normalise <br> / <br/> / <br /> to newlines
  const text = content.replace(/<br\s*\/?>/gi, "\n");
  // Match hook entries: HOO1, HO11, HOO3 etc with parenthesised metadata followed by pipe
  // Also match entries where ID is followed by space+paren (full-width or half-width)
  const blockRegex = /(H[A-Za-z]*\d+)\s*[（(]([^)）]*)[)）]\s*[|｜]/g;
  const starts: Array<{ idx: number; id: string; meta: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(text)) !== null) {
    starts.push({ idx: m.index, id: m[1], meta: m[2].trim() });
  }
  if (starts.length === 0) return null;

  const entries: HookEntry[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.idx : text.length;
    const raw = text.slice(start.idx, end).trim();

    // Remove the leading "HOOKID (meta) |" prefix
    const prefixMatch = raw.match(/^H[A-Za-z]*\d+\s*[（(][^)）]*[)）]\s*[|｜]/);
    const rest = prefixMatch ? raw.slice(prefixMatch[0].length).trim() : raw;

    // Split by top-level pipe segments: "读者承诺: ..." | "种于第1章: ..." | "推进于第4章: ..."
    const segments = rest.split(/\s*[|｜]\s*/);
    const sections: HookEntry["sections"] = [];

    for (const seg of segments) {
      if (!seg.trim()) continue;
      // Try to find a heading like "读者承诺:" or "种于第1章:" or "推进于第4章:"
      const headMatch = seg.match(/^([^:：]{1,30})[：:]\s*([\s\S]*)/);
      if (headMatch) {
        const heading = headMatch[1].trim();
        const body = headMatch[2].trim();
        // Split body into numbered items or lines
        const lines = body.split(/\n/).map(l => l.trim()).filter(Boolean);
        sections.push({ heading, items: lines });
      } else {
        sections.push({ heading: "", items: [seg.trim()] });
      }
    }
    entries.push({ id: start.id, meta: start.meta, sections });
  }
  return entries.length > 0 ? entries : null;
}

const HOOK_STATUS_COLORS: Record<string, string> = {
  "已开": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  "慢烧": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "可见": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
};

function getHookStatusColor(meta: string): string {
  for (const [key, cls] of Object.entries(HOOK_STATUS_COLORS)) {
    if (meta.includes(key)) return cls;
  }
  return "bg-secondary text-muted-foreground";
}

function PendingHooksView({ entries }: { entries: HookEntry[] }) {
  return (
    <div className="space-y-5">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="rounded-xl border border-border/40 bg-card/60 overflow-hidden"
        >
          {/* Hook header */}
          <div className="px-5 py-3 border-b border-border/30 bg-secondary/20 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-sm font-bold text-primary">{entry.id}</span>
            {entry.meta.split(/[,，]/).map((tag, i) => (
              <span
                key={i}
                className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${getHookStatusColor(tag)}`}
              >
                {tag.trim()}
              </span>
            ))}
          </div>
          {/* Sections */}
          <div className="px-5 py-4 space-y-4">
            {entry.sections.map((sec, si) => (
              <div key={si}>
                {sec.heading && (
                  <div className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1.5">
                    {sec.heading}
                  </div>
                )}
                <div className="text-sm leading-7 text-foreground space-y-1">
                  {sec.items.map((item, ii) => (
                    <div key={ii} className="pl-1">{item}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const TRUTH_FILE_LABELS: Record<string, string> = {
  "audit_drift.md": "审计偏差",
  "author_intent.md": "作者意图",
  "book_rules.md": "创作规则",
  "chapter_summaries.md": "章节摘要",
  "character_matrix.md": "角色关系",
  "current_focus.md": "当前焦点",
  "current_state.md": "当前状态",
  "emotional_arcs.md": "情感弧线",
  "pending_hooks.md": "悬念伏笔",
  "story_bible.md": "故事圣经",
  "subplot_board.md": "支线看板",
  "volume_outline.md": "卷章大纲",
};

function truthFileLabel(name: string): string {
  return TRUTH_FILE_LABELS[name] ?? name.replace(/[_-]/g, " ").replace(/\.md$/, "");
}

function toPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toPlainText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return toPlainText((node as { props?: { children?: ReactNode } }).props?.children ?? "");
  }
  return "";
}

function shortTableHeaderLabel(label: string): string {
  const text = label.trim();
  if (text.length <= 8) return text;
  return `${text.slice(0, 8)}…`;
}

function mergeClassName(existing: unknown, next: string): string {
  const current = typeof existing === "string" ? existing : "";
  return current ? `${current} ${next}` : next;
}

type MarkdownElementProps = {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly [key: string]: unknown;
};

type MarkdownElement = ReactElement<MarkdownElementProps, string | JSXElementConstructor<unknown>>;

function asMarkdownElement(node: ReactNode): MarkdownElement | null {
  if (!isValidElement(node)) return null;
  return node as MarkdownElement;
}

export function TruthFiles({ bookId, nav, theme, t }: { bookId: string; nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data } = useApi<{ files: ReadonlyArray<TruthFile> }>(`/books/${bookId}/truth`);
  const [selected, setSelected] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [previewMode, setPreviewMode] = useState<"rendered" | "raw">("rendered");
  const [expandedTableCol, setExpandedTableCol] = useState<number | null>(null);
  const { data: fileData, error: fileError, refetch: refetchFile } = useApi<{ file: string; content: string | null }>(
    selected ? `/books/${bookId}/truth/${selected}` : "",
  );
  const isMarkdown = selected?.endsWith(".md") ?? false;
  const canRender = !editMode && isMarkdown && previewMode === "rendered";
  const renderedMarkdown = fileData?.content
    ? unwrapOuterCodeFence(fileData.content)
    : "";

  const startEdit = () => {
    setEditText(fileData?.content ?? "");
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
  };

  const handleSaveEdit = async () => {
    if (!selected) return;
    setSavingEdit(true);
    try {
      await fetchJson(`/books/${bookId}/truth/${selected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editText }),
      });
      setEditMode(false);
      refetchFile();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span className="text-border">/</span>
        <button onClick={() => nav.toBook(bookId)} className={c.link}>{bookId}</button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("truth.title")}</span>
      </div>

      <h1 className="font-serif text-3xl">{t("truth.title")}</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)]">
        {/* File list */}
        <div className={`border ${c.cardStatic} rounded-lg overflow-hidden`}>
          {data?.files.map((f) => (
            <button
              key={f.name}
              onClick={() => {
                setSelected(f.name);
                setEditMode(false);
                setPreviewMode("rendered");
                setExpandedTableCol(null);
              }}
              className={`w-full text-left px-3 py-2.5 text-sm border-b border-border/40 transition-colors ${
                selected === f.name
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted/30 text-muted-foreground"
              }`}
            >
              <div className="text-sm font-medium truncate">{truthFileLabel(f.name)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{f.size.toLocaleString()} {t("truth.chars")}</div>
            </button>
          ))}
          {(!data?.files || data.files.length === 0) && (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">{t("truth.empty")}</div>
          )}
        </div>

        {/* Content viewer */}
        <div className={`border ${c.cardStatic} rounded-xl p-6 min-h-[70vh] max-h-[82vh] flex flex-col`}>
          {selected && fileData?.content != null ? (
            <>
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="text-xs text-muted-foreground">
                  {isMarkdown ? "阅读视图（排版化）" : "原始文本"}
                </div>
                {editMode ? (
                  <>
                    <button
                      onClick={cancelEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
                    >
                      <X size={14} />
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      disabled={savingEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnPrimary} disabled:opacity-50`}
                    >
                      <Save size={14} />
                      {savingEdit ? t("truth.saving") : t("truth.save")}
                    </button>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    {isMarkdown && (
                      <>
                        <button
                          onClick={() => setPreviewMode("rendered")}
                          className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${
                            previewMode === "rendered" ? c.btnPrimary : c.btnSecondary
                          }`}
                        >
                          <Eye size={14} />
                          阅读视图
                        </button>
                        <button
                          onClick={() => setPreviewMode("raw")}
                          className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${
                            previewMode === "raw" ? c.btnPrimary : c.btnSecondary
                          }`}
                        >
                          <Code2 size={14} />
                          Markdown
                        </button>
                        {previewMode === "rendered" && expandedTableCol !== null && (
                          <button
                            onClick={() => setExpandedTableCol(null)}
                            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
                          >
                            恢复默认列宽
                          </button>
                        )}
                      </>
                    )}
                    <button
                      onClick={startEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
                    >
                      <Pencil size={14} />
                      Edit
                    </button>
                  </div>
                )}
              </div>
              {editMode ? (
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className={`${c.input} flex-1 rounded-md p-4 text-sm font-mono leading-relaxed resize-none min-h-[360px]`}
                />
              ) : canRender ? (
                <div className="paper-markdown-view flex-1 overflow-auto rounded-xl border border-border/40 bg-card px-8 py-7">
                  {/* Try structured rendering for JSON files (e.g. author_intent.md) */}
                  {(() => {
                    const jsonView = tryRenderJson(renderedMarkdown);
                    if (jsonView) return jsonView;

                    const fmResult = splitYamlFrontmatter(renderedMarkdown);
                    if (fmResult) {
                      return (
                        <div className="space-y-8">
                          <YamlStructuredView yamlText={fmResult.yaml} />
                          {fmResult.body.trim() && (
                            <>
                              <hr className="border-border/40" />
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{fmResult.body}</ReactMarkdown>
                            </>
                          )}
                        </div>
                      );
                    }

                    // pending_hooks.md or similar hook-entry files
                    const hookEntries = parsePendingHooks(renderedMarkdown);
                    if (hookEntries) return <PendingHooksView entries={hookEntries} />;

                    return null;
                  })() ?? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      table: ({ children }) => {
                        const topNodes = Children.toArray(children);
                        const headerSection = topNodes
                          .map(asMarkdownElement)
                          .find((node) => node?.type === "thead");
                        let totalCols = 0;
                        if (headerSection) {
                          const headerRows = Children.toArray(headerSection.props.children);
                          const firstHeaderRow = headerRows
                            .map(asMarkdownElement)
                            .find((node) => node?.type === "tr");
                          if (firstHeaderRow) {
                            totalCols = Children.toArray(firstHeaderRow.props.children).filter(
                              (cell) => {
                                const element = asMarkdownElement(cell);
                                return element?.type === "th" || element?.type === "td";
                              },
                            ).length;
                          }
                        }

                        const expandedWidth = 40;
                        const compactWidth = totalCols > 1 ? (100 - expandedWidth) / (totalCols - 1) : 100;

                        const mapped = topNodes.map((sectionNode) => {
                          const sectionElement = asMarkdownElement(sectionNode);
                          if (!sectionElement) return sectionNode;
                          if (sectionElement.type !== "thead" && sectionElement.type !== "tbody") return sectionNode;

                          const rows = Children.toArray(sectionElement.props.children).map((rowNode) => {
                            const rowElement = asMarkdownElement(rowNode);
                            if (!rowElement || rowElement.type !== "tr") return rowNode;

                            const cells = Children.toArray(rowElement.props.children).map((cellNode, colIndex) => {
                              const cellElement = asMarkdownElement(cellNode);
                              if (!cellElement) return cellNode;
                              if (cellElement.type !== "th" && cellElement.type !== "td") return cellNode;

                              const isExpanded = expandedTableCol !== null && expandedTableCol === colIndex;
                              const isCompacted = expandedTableCol !== null && expandedTableCol !== colIndex;

                              const widthStyle = expandedTableCol === null
                                ? undefined
                                : isExpanded
                                  ? { width: `${expandedWidth}%` }
                                  : { width: `${compactWidth}%` };

                              if (cellElement.type === "th") {
                                const fullText = toPlainText(cellElement.props.children);
                                const shortText = shortTableHeaderLabel(fullText);
                                return cloneElement(
                                  cellElement,
                                  {
                                    ...cellElement.props,
                                    className: mergeClassName(
                                      cellElement.props.className,
                                      `${isExpanded ? "truth-col-expanded" : ""} ${isCompacted ? "truth-col-compacted" : ""}`.trim(),
                                    ),
                                    style: { ...(cellElement.props.style ?? {}), ...(widthStyle ?? {}) },
                                    "data-col-index": colIndex,
                                  },
                                  <div className="truth-th-inner">
                                    <button
                                      type="button"
                                      className="truth-th-button"
                                      onClick={() => setExpandedTableCol((current) => (current === colIndex ? null : colIndex))}
                                      aria-label={`展开列: ${fullText}`}
                                    >
                                      <span className="truth-th-label">{shortText}</span>
                                    </button>
                                    <span className="truth-th-tooltip">{fullText}</span>
                                  </div>,
                                );
                              }

                              return cloneElement(cellElement, {
                                ...cellElement.props,
                                className: mergeClassName(
                                  cellElement.props.className,
                                  `${isExpanded ? "truth-col-expanded" : ""} ${isCompacted ? "truth-col-compacted" : ""}`.trim(),
                                ),
                                style: { ...(cellElement.props.style ?? {}), ...(widthStyle ?? {}) },
                                "data-col-index": colIndex,
                              });
                            });

                            return cloneElement(rowElement, rowElement.props, cells);
                          });

                          return cloneElement(sectionElement, sectionElement.props, rows);
                        });

                        return (
                          <div className="truth-table-wrap">
                            <table className={expandedTableCol !== null ? "truth-table-expanded" : ""}>{mapped}</table>
                          </div>
                        );
                      },
                    }}
                  >
                    {renderedMarkdown}
                  </ReactMarkdown>
                  )}
                </div>
              ) : (
                <pre className="text-sm leading-relaxed whitespace-pre-wrap font-mono text-foreground/80 overflow-auto rounded-xl border border-border/40 bg-card p-5">{fileData.content}</pre>
              )}
            </>
          ) : selected && fileError ? (
            <div className="text-destructive text-sm">{fileError}</div>
          ) : selected && fileData?.content === null ? (
            <div className="text-muted-foreground text-sm">{t("truth.notFound")}</div>
          ) : (
            <div className="text-muted-foreground/50 text-sm italic">{t("truth.selectFile")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
