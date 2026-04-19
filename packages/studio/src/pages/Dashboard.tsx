import { useEffect, useMemo, useState } from "react";
import type { SSEMessage } from "../hooks/use-sse";
import { fetchJson, useApi } from "../hooks/use-api";
import { deriveActiveBookIds, shouldRefetchBookCollections } from "../hooks/use-book-activity";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { ArrowRight, BookOpen, Clock3, Eye, FileText, Plus, Trash2 } from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly language?: string;
  readonly fanficMode?: string;
}

interface Nav {
  toBook: (id: string) => void;
  toAnalytics: (id: string) => void;
  toBookCreate: () => void;
  toTruth?: (id: string) => void;
}

export function Dashboard({
  nav,
  sse,
}: {
  nav: Nav;
  sse: { messages: ReadonlyArray<SSEMessage> };
  theme: Theme;
  t: TFunction;
}) {
  const { data, loading, error, refetch } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const writingBooks = useMemo(() => deriveActiveBookIds(sse.messages), [sse.messages]);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) {
      refetch();
    }
  }, [refetch, sse.messages]);

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
          <div className="text-sm text-muted-foreground">正在整理作品书架…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto mt-12 max-w-3xl rounded-[28px] border border-destructive/30 bg-destructive/5 p-8 text-destructive">
        <div className="text-xl font-semibold">作品页加载失败</div>
        <div className="mt-2 text-sm text-destructive/80">{error}</div>
      </div>
    );
  }

  const books = data?.books ?? [];

  if (books.length === 0) {
    return (
      <div className="flex min-h-full items-center justify-center px-8">
        <div className="w-full max-w-3xl rounded-[36px] border border-border/70 bg-card/70 px-10 py-14 text-center shadow-2xl shadow-black/10 backdrop-blur-xl">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <BookOpen size={28} />
          </div>
          <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">作品</div>
          <h1 className="mt-4 text-5xl font-semibold tracking-tight text-foreground">你的作品</h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-muted-foreground">
            先创建第一本书，把世界观、人物和章节续写都纳入同一个工作台。
          </p>
          <button
            onClick={nav.toBookCreate}
            className="mx-auto mt-8 inline-flex h-12 items-center gap-2 rounded-2xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02]"
          >
            <Plus size={16} />
            新建作品
          </button>
        </div>
      </div>
    );
  }

  const featuredBook = books[0];
  const secondaryBooks = books.slice(1);

  return (
    <div className="min-h-full bg-transparent text-foreground">
      <div className="mx-auto flex h-full max-w-[1440px] flex-col px-10 pb-12 pt-24">
        <section className="mb-10 rounded-[32px] border border-border/70 bg-card/58 p-6 shadow-[0_24px_64px_-36px_rgba(0,0,0,0.18)] backdrop-blur-xl">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-3 py-1 text-[11px] text-muted-foreground">
                <Plus size={12} />
                创建新作品
              </div>
              <h2 className="mt-4 font-sans text-3xl font-semibold tracking-tight text-foreground">
                开一本新的故事线
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
                从题材、平台定位到风格基调，直接开始新的项目。适合开新坑、切换题材，或给不同平台单独做一套作品方案。
              </p>
            </div>

            <div className="flex flex-col gap-3 lg:min-w-[280px]">
              <button
                onClick={nav.toBookCreate}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02]"
              >
                <Plus size={16} />
                新建作品
              </button>
              <div className="rounded-2xl border border-border bg-background/50 px-4 py-3 text-xs leading-6 text-muted-foreground">
                建议先准备：
                <span className="ml-1">书名、核心题材、读者定位、风格方向。</span>
              </div>
            </div>
          </div>
        </section>

        <div className="mb-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground">
            <BookOpen size={12} />
            作品
          </div>
          <h1 className="mt-5 text-6xl font-semibold tracking-tight text-foreground">你的作品</h1>
        </div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.45fr_0.95fr]">
          <BookShowcaseCard
            book={featuredBook}
            featured
            writing={writingBooks.has(featuredBook.id)}
            onOpen={() => nav.toBook(featuredBook.id)}
            onViewTruth={() => nav.toTruth?.(featuredBook.id)}
            onDelete={async () => {
              await fetchJson(`/books/${featuredBook.id}`, { method: "DELETE" });
              refetch();
            }}
          />
          <div className="space-y-5">
            {secondaryBooks.length > 0 ? secondaryBooks.map((book) => (
              <BookShowcaseCard
                key={book.id}
                book={book}
                writing={writingBooks.has(book.id)}
                onOpen={() => nav.toBook(book.id)}
                onViewTruth={() => nav.toTruth?.(book.id)}
                onDelete={async () => {
                  await fetchJson(`/books/${book.id}`, { method: "DELETE" });
                  refetch();
                }}
              />
            )) : (
              <button
                onClick={nav.toBookCreate}
                className="flex min-h-[220px] w-full flex-col justify-between rounded-[32px] border border-dashed border-border bg-card/50 p-6 text-left transition-colors hover:bg-card/80"
              >
                <div className="rounded-full border border-border bg-secondary/40 px-3 py-1 text-xs text-muted-foreground w-fit">
                  新作品
                </div>
                <div>
                  <div className="text-2xl font-semibold text-foreground">再开一本新书</div>
                  <div className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                    把新的题材、风格和平台定位也纳入同一个创作系统。
                  </div>
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>现在开始</span>
                  <ArrowRight size={18} />
                </div>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BookShowcaseCard({
  book,
  featured = false,
  writing,
  onOpen,
  onViewTruth,
  onDelete,
}: {
  readonly book: BookSummary;
  readonly featured?: boolean;
  readonly writing: boolean;
  readonly onOpen: () => void;
  readonly onViewTruth?: () => void;
  readonly onDelete?: () => Promise<void>;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const statusLabel = book.status === "active" ? "连载中" : book.status === "paused" ? "暂停中" : book.status;
  const description = featured
    ? "一个节奏强、设定直给的系统流作品，核心卖点是轻松升级、持续反馈和高爽点推进。"
    : "偏克制与氛围感的情感故事，强调人物情绪、关系张力和更细腻的叙事节奏。";

  const handleDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div
      className={`group relative w-full rounded-[32px] border border-border/70 bg-card/68 p-6 text-left shadow-[0_24px_64px_-36px_rgba(0,0,0,0.22)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-card/90 ${
        featured ? "min-h-[250px]" : "min-h-[220px]"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border bg-secondary/40 px-3 py-1 text-[11px] text-muted-foreground">
            {book.genre || "未分类"}
          </span>
          <span className="rounded-full border border-border bg-secondary/40 px-3 py-1 text-[11px] text-muted-foreground">
            {statusLabel}
          </span>
          {writing && (
            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] text-emerald-600 dark:text-emerald-300">
              写作中
            </span>
          )}
        </div>
        <button
          onClick={onOpen}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-secondary/40 text-muted-foreground transition-colors hover:text-foreground hover:bg-secondary/70"
        >
          <ArrowRight size={18} />
        </button>
      </div>

      <button onClick={onOpen} className="block w-full text-left">
        <h2 className={`mt-6 font-sans font-semibold tracking-tight text-foreground ${featured ? "text-5xl leading-[1.08]" : "text-3xl leading-[1.15]"}`}>
          《{book.title}》
        </h2>

        <p className={`mt-4 max-w-3xl text-muted-foreground ${featured ? "text-base leading-8" : "text-sm leading-7"}`}>
          {description}
        </p>
      </button>

      {/* Footer: time + action buttons */}
      <div className="mt-8 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock3 size={15} />
          <span>{featured ? "今天更新" : `${Math.max(book.chaptersWritten - 3, 1)} 天前编辑`}</span>
        </div>

        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition-all hover:bg-primary/10 hover:text-primary hover:border-primary/30"
          >
            <Eye size={12} />
            查看小说
          </button>
          {onViewTruth && (
            <button
              onClick={(e) => { e.stopPropagation(); onViewTruth(); }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition-all hover:bg-primary/10 hover:text-primary hover:border-primary/30"
            >
              <FileText size={12} />
              真相文件
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border/50 bg-secondary/50 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 disabled:opacity-50"
          >
            <Trash2 size={12} />
            删除
          </button>
        </div>
      </div>

      {/* Delete confirmation overlay */}
      {confirmingDelete && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center rounded-[32px] bg-black/50 backdrop-blur-sm"
          onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); }}
        >
          <div
            className="mx-6 w-full max-w-sm rounded-2xl border border-border/50 bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-foreground">确认删除</h3>
            <p className="mt-2 text-sm text-muted-foreground leading-6">
              确定要删除《{book.title}》吗？此操作不可撤销，所有章节、设定和版本记录都将被永久删除。
            </p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="rounded-xl border border-border/50 bg-secondary px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-xl border border-destructive/30 bg-destructive px-4 py-2 text-xs font-semibold text-white hover:bg-destructive/90 transition-colors disabled:opacity-50"
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
