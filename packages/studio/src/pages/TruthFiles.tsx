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
              <div className="font-mono text-sm truncate">{f.name}</div>
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
