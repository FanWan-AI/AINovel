import { useEffect, useRef, useState } from "react";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
  List,
  BookOpen,
  CheckCircle2,
  Hash,
  Type,
  Clock,
  Pencil,
  Save,
  Eye,
} from "lucide-react";

interface ChapterData {
  readonly chapterNumber: number;
  readonly filename: string;
  readonly content: string;
}

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface BookDetailData {
  readonly book: {
    readonly title: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
  toChapter: (bookId: string, chapterNumber: number) => void;
}

export function ChapterReader({ bookId, chapterNumber, nav, theme, t }: {
  bookId: string;
  chapterNumber: number;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<ChapterData>(
    `/books/${bookId}/chapters/${chapterNumber}`,
  );
  const { data: bookData } = useApi<BookDetailData>(`/books/${bookId}`);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [chapterRailOpen, setChapterRailOpen] = useState(false);
  const [chapterRailLayout, setChapterRailLayout] = useState({ left: 264, panelWidth: 244 });
  const paperRef = useRef<HTMLDivElement | null>(null);
  const chapters = [...(bookData?.chapters ?? [])].sort((a, b) => a.number - b.number);

  useEffect(() => {
    const measureRail = () => {
      const paperEl = paperRef.current;
      if (!paperEl) return;

      const sidebarEl = document.querySelector<HTMLElement>("[data-sidebar-shell='app']");
      const sidebarRight = sidebarEl?.getBoundingClientRect().right ?? 248;
      const paperLeft = paperEl.getBoundingClientRect().left;
      const gutterWidth = Math.max(paperLeft - sidebarRight, 160);
      const panelWidth = Math.max(220, Math.min(320, gutterWidth - 56));
      const collapsedWidth = 48;
      const expandedWidth = collapsedWidth + 12 + panelWidth;
      const activeWidth = chapterRailOpen ? expandedWidth : collapsedWidth;
      const left = sidebarRight + Math.max((gutterWidth - activeWidth) / 2, 8);

      setChapterRailLayout({ left, panelWidth });
    };

    measureRail();
    window.addEventListener("resize", measureRail);
    return () => window.removeEventListener("resize", measureRail);
  }, [chapterRailOpen, chapters.length]);

  const handleStartEdit = () => {
    if (!data) return;
    setEditContent(data.content);
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      setEditing(false);
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("reader.openingManuscript")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  // Split markdown content into title and body
  const lines = data.content.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine?.replace(/^#\s*/, "") ?? `Chapter ${chapterNumber}`;
  const body = lines
    .filter((l) => l !== titleLine)
    .join("\n")
    .trim();

  const handleApprove = async () => {
    await postApi(`/books/${bookId}/chapters/${chapterNumber}/approve`);
    nav.toBook(bookId);
  };

  const paragraphs = body.split(/\n\n+/).filter(Boolean);
  const currentChapterIndex = chapters.findIndex((chapter) => chapter.number === chapterNumber);
  const previousChapter = currentChapterIndex > 0 ? chapters[currentChapterIndex - 1] : null;
  const nextChapter = currentChapterIndex >= 0 && currentChapterIndex < chapters.length - 1
    ? chapters[currentChapterIndex + 1]
    : null;
  const resolvedBookTitle = bookData?.book.title ?? bookId;

  const chapterRailButtonClass = (active: boolean) =>
    `w-full rounded-2xl border px-3 py-3 text-left transition-all ${
      active
        ? "border-primary/30 bg-primary/8 shadow-sm"
        : "border-border/60 bg-background/92 hover:border-primary/25 hover:bg-background"
    }`;

  const navigationButtonClass = (enabled: boolean) =>
    `group inline-flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold transition-all ${
      enabled
        ? "border-border/60 bg-background hover:border-primary/30 hover:text-primary hover:shadow-md"
        : "cursor-not-allowed border-border/40 bg-muted/40 text-muted-foreground/50"
    }`;

  return (
    <div className="relative max-w-4xl mx-auto space-y-10">
      <div className="hidden xl:block">
        <aside
          className="fixed top-1/2 z-30 -translate-y-1/2"
          style={{ left: `${chapterRailLayout.left}px` }}
        >
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => setChapterRailOpen((open) => !open)}
              className="mt-6 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-background/95 text-muted-foreground shadow-lg backdrop-blur hover:text-primary"
              title={chapterRailOpen ? "收起章节导航" : "展开章节导航"}
            >
              {chapterRailOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>

            <div
              className="overflow-hidden rounded-[28px] border border-border/60 bg-background/95 shadow-2xl backdrop-blur transition-all duration-300"
              style={{
                width: chapterRailOpen ? `${chapterRailLayout.panelWidth}px` : "0px",
                opacity: chapterRailOpen ? 1 : 0,
              }}
            >
              <div className="p-5" style={{ width: `${chapterRailLayout.panelWidth}px` }}>
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
                      章节导航
                    </p>
                    <h3 className="mt-1 line-clamp-2 text-base font-semibold leading-7 text-foreground">
                      {resolvedBookTitle}
                    </h3>
                  </div>
                  <span className="shrink-0 rounded-full bg-primary/8 px-3 py-1.5 text-[11px] font-semibold text-primary">
                    {chapters.length} 章
                  </span>
                </div>

                <div className="max-h-[68vh] space-y-2 overflow-y-auto pr-1">
                  {chapters.map((chapter) => (
                    <button
                      key={chapter.number}
                      type="button"
                      onClick={() => nav.toChapter(bookId, chapter.number)}
                      className={chapterRailButtonClass(chapter.number === chapterNumber)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold text-muted-foreground">
                          第{chapter.number}章
                        </span>
                        <span className="rounded-full bg-secondary/70 px-2 py-0.5 text-[10px] text-muted-foreground">
                          {chapter.wordCount.toLocaleString()}字
                        </span>
                      </div>
                      <div className="mt-1 line-clamp-2 text-sm font-medium leading-6 text-foreground">
                        {chapter.title}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Navigation & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
          <button
            onClick={nav.toDashboard}
            className="hover:text-primary transition-colors flex items-center gap-1"
          >
            {t("bread.books")}
          </button>
          <span className="text-border">/</span>
          <button
            onClick={() => nav.toBook(bookId)}
            className="hover:text-primary transition-colors truncate max-w-[120px]"
          >
            {resolvedBookTitle}
          </button>
          <span className="text-border">/</span>
          <span className="text-foreground flex items-center gap-1">
            <Hash size={12} />
            {chapterNumber}
          </span>
        </nav>

        <div className="flex gap-2">
          <button
            onClick={() => nav.toBook(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-foreground hover:bg-secondary/80 transition-all border border-border/50"
          >
            <List size={14} />
            {t("reader.backToList")}
          </button>

          {/* Edit / Preview toggle */}
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-sm disabled:opacity-50"
              >
                {saving ? <div className="w-3.5 h-3.5 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
                {saving ? t("book.saving") : t("book.save")}
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-foreground transition-all border border-border/50"
              >
                <Eye size={14} />
                {t("reader.preview")}
              </button>
            </>
          ) : (
            <button
              onClick={handleStartEdit}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-muted-foreground rounded-xl hover:text-primary hover:bg-primary/10 transition-all border border-border/50"
            >
              <Pencil size={14} />
              {t("reader.edit")}
            </button>
          )}

          <button
            onClick={handleApprove}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-500/10 text-emerald-600 rounded-xl hover:bg-emerald-500 hover:text-white transition-all border border-emerald-500/20 shadow-sm"
          >
            <CheckCircle2 size={14} />
            {t("reader.approve")}
          </button>
        </div>
      </div>

      {/* Manuscript Sheet */}
      <div
        ref={paperRef}
        className="paper-sheet rounded-2xl p-8 md:p-16 lg:p-24 shadow-2xl shadow-primary/5 min-h-[80vh] relative overflow-hidden"
      >
        {/* Physical Paper Details */}
        <div className="absolute top-0 left-8 w-px h-full bg-primary/5 hidden md:block" />
        <div className="absolute top-0 right-8 w-px h-full bg-primary/5 hidden md:block" />

        <header className="mb-16 text-center">
          <div className="flex items-center justify-center gap-2 text-muted-foreground/30 mb-8 select-none">
            <div className="h-px w-12 bg-border/40" />
            <BookOpen size={20} />
            <div className="h-px w-12 bg-border/40" />
          </div>
          <h1 className="text-4xl md:text-5xl font-serif font-medium italic text-foreground tracking-tight leading-tight">
            {title}
          </h1>
          <div className="mt-8 flex items-center justify-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
            <span>{t("reader.manuscriptPage")}</span>
            <span className="text-border">·</span>
            <span>{chapterNumber.toString().padStart(2, '0')}</span>
          </div>
        </header>

        {editing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full min-h-[60vh] bg-transparent font-serif text-lg leading-[1.8] text-foreground/90 focus:outline-none resize-none border border-border/30 rounded-lg p-6 focus:border-primary/40 focus:ring-2 focus:ring-primary/10 transition-all"
            autoFocus
          />
        ) : (
          <article className="prose prose-zinc dark:prose-invert max-w-none">
            {paragraphs.map((para, i) => (
              <p key={i} className="font-serif text-lg md:text-xl leading-[1.8] text-foreground/90 mb-8 first-letter:text-2xl first-letter:font-bold first-letter:text-primary/40">
                {para}
              </p>
            ))}
          </article>
        )}

        <footer className="mt-24 pt-12 border-t border-border/20 flex flex-col items-center gap-6 text-center">
          <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
             <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary/50">
               <Type size={14} className="text-primary/60" />
               <span>{body.length.toLocaleString()} {t("reader.characters")}</span>
             </div>
             <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary/50">
               <Clock size={14} className="text-primary/60" />
               <span>{Math.ceil(body.length / 500)} {t("reader.minRead")}</span>
             </div>
          </div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/40 font-bold">{t("reader.endOfChapter")}</p>
        </footer>
      </div>

      {/* Footer Navigation */}
      <div className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          disabled={!previousChapter}
          onClick={() => previousChapter && nav.toChapter(bookId, previousChapter.number)}
          className={navigationButtonClass(Boolean(previousChapter))}
          title={previousChapter ? `返回第${previousChapter.number}章` : "没有上一章节"}
        >
          <ChevronLeft size={16} />
          <div className="text-left">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              返回上一章节
            </div>
            <div className="max-w-[220px] truncate text-sm">
              {previousChapter ? `第${previousChapter.number}章 ${previousChapter.title}` : "已是第一章"}
            </div>
          </div>
        </button>

        <div className="flex items-center justify-center">
          <button
            onClick={() => nav.toBook(bookId)}
            className="flex items-center gap-2 text-sm font-bold text-muted-foreground hover:text-primary transition-all group"
          >
            <List size={16} className="group-hover:scale-110 transition-transform" />
            {t("reader.chapterList")}
          </button>
        </div>

        <button
          type="button"
          disabled={!nextChapter}
          onClick={() => nextChapter && nav.toChapter(bookId, nextChapter.number)}
          className={`${navigationButtonClass(Boolean(nextChapter))} justify-end text-right`}
          title={nextChapter ? `进入第${nextChapter.number}章` : "没有下一章节"}
        >
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              进入下一章节
            </div>
            <div className="max-w-[220px] truncate text-sm">
              {nextChapter ? `第${nextChapter.number}章 ${nextChapter.title}` : "已是最后一章"}
            </div>
          </div>
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
