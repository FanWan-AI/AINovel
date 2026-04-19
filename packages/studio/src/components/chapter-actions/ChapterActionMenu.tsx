import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Wand2, PenLine, RefreshCw, History, ChevronDown } from "lucide-react";
import type { TFunction } from "../../hooks/use-i18n";

type ReviseMode = "spot-fix" | "polish" | "rework" | "anti-detect" | "chapter-redesign";
type ChapterActionKind = "revise" | "rewrite" | "resync" | "rewrite-in-place";

export interface ChapterActionMenuProps {
  readonly chapterNumber: number;
  readonly disabled: boolean;
  readonly t: TFunction;
  readonly onAction: (kind: ChapterActionKind, mode?: ReviseMode) => void;
  readonly onViewVersions?: () => void;
}

interface MenuItem {
  readonly label: string;
  readonly tooltip: string;
  readonly kind: ChapterActionKind;
  readonly mode?: ReviseMode;
  readonly icon?: React.ReactNode;
}

interface MenuGroup {
  readonly id: string;
  readonly label: string;
  readonly tooltip: string;
  readonly icon: React.ReactNode;
  readonly items: ReadonlyArray<MenuItem>;
  readonly danger?: boolean;
}

/* ---- Floating dropdown rendered via portal ---- */
function FloatingDropdown({
  anchorRef,
  items,
  danger,
  disabled,
  onSelect,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  items: ReadonlyArray<MenuItem>;
  danger?: boolean;
  disabled: boolean;
  onSelect: (item: MenuItem) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 220;
    let left = rect.left;
    if (left + menuWidth > window.innerWidth - 8) {
      left = rect.right - menuWidth;
    }
    setPos({ top: rect.bottom + 6, left });
  }, [anchorRef]);

  return createPortal(
    <div
      ref={menuRef}
      data-chapter-dropdown
      style={{ top: pos.top, left: pos.left }}
      className="fixed z-[200] w-[220px] rounded-2xl border border-border/40 bg-card/95 backdrop-blur-xl shadow-2xl shadow-black/15 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150"
    >
      <div className="py-1.5">
        {items.map((item, idx) => (
          <button
            key={idx}
            disabled={disabled}
            onClick={() => onSelect(item)}
            title={item.tooltip}
            className={`
              w-full text-left px-4 py-2.5 text-[12px] font-medium transition-colors disabled:opacity-50
              flex items-center gap-2.5
              ${danger
                ? "text-foreground hover:bg-destructive/8 hover:text-destructive"
                : "text-foreground hover:bg-primary/8 hover:text-primary"
              }
            `}
          >
            {item.icon && <span className="opacity-50 shrink-0">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function ChapterActionMenu({
  chapterNumber: _chapterNumber,
  disabled,
  t,
  onAction,
  onViewVersions,
}: ChapterActionMenuProps) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      /* Also skip if clicking inside the portal dropdown */
      const target = e.target as HTMLElement;
      if (target.closest("[data-chapter-dropdown]")) return;
      setOpenGroup(null);
    }
  }, []);

  useEffect(() => {
    if (openGroup) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [openGroup, handleClickOutside]);

  const groups: MenuGroup[] = [
    {
      id: "refine",
      label: t("book.refine"),
      tooltip: t("book.refineTooltip"),
      icon: <Wand2 size={13} />,
      items: [
        { label: t("book.fixIssues"), tooltip: t("book.fixIssuesTooltip"), kind: "revise", mode: "spot-fix", icon: <Wand2 size={12} /> },
        { label: t("book.polishExpression"), tooltip: t("book.polishExpressionTooltip"), kind: "revise", mode: "polish", icon: <Wand2 size={12} /> },
        { label: t("book.reduceAiTrace"), tooltip: t("book.reduceAiTraceTooltip"), kind: "revise", mode: "anti-detect", icon: <Wand2 size={12} /> },
      ],
    },
    {
      id: "rewrite-in-place",
      label: t("book.rewriteInPlace"),
      tooltip: t("book.rewriteInPlaceTooltip"),
      icon: <PenLine size={13} />,
      items: [
        { label: t("book.lightRewrite"), tooltip: t("book.lightRewriteTooltip"), kind: "rewrite-in-place", mode: "rework", icon: <PenLine size={12} /> },
        { label: t("book.deepRewrite"), tooltip: t("book.deepRewriteTooltip"), kind: "rewrite-in-place", mode: "chapter-redesign", icon: <PenLine size={12} /> },
        { label: t("book.targetedRewrite"), tooltip: t("book.targetedRewriteTooltip"), kind: "rewrite-in-place", mode: "chapter-redesign", icon: <PenLine size={12} /> },
      ],
    },
    {
      id: "regenerate",
      label: t("book.regenerate"),
      tooltip: t("book.regenerateTooltip"),
      icon: <RefreshCw size={13} />,
      danger: true,
      items: [
        { label: t("book.regenerateChapter"), tooltip: t("book.regenerateChapterTooltip"), kind: "rewrite", icon: <RefreshCw size={12} /> },
        { label: t("book.regenerateWithBrief"), tooltip: t("book.regenerateWithBriefTooltip"), kind: "rewrite", icon: <RefreshCw size={12} /> },
      ],
    },
    {
      id: "versions",
      label: t("book.versions"),
      tooltip: t("book.versionsTooltip"),
      icon: <History size={13} />,
      items: [],
    },
  ];

  return (
    <div ref={containerRef} className="flex items-center gap-1.5">
      {groups.map((group) => {
        const isOpen = openGroup === group.id;
        const hasDropdown = group.id !== "versions" && group.items.length > 0;
        return (
          <div key={group.id} className="relative">
            <button
              ref={(el) => { buttonRefs.current[group.id] = el; }}
              disabled={disabled}
              onClick={() => {
                if (group.id === "versions" && onViewVersions) {
                  onViewVersions();
                  return;
                }
                setOpenGroup(isOpen ? null : group.id);
              }}
              title={group.tooltip}
              className={`
                inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 text-[11px] font-bold rounded-lg
                border transition-all disabled:opacity-50 cursor-pointer
                ${group.danger
                  ? `border-border/50 bg-secondary text-muted-foreground hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30
                     ${isOpen ? "text-destructive bg-destructive/10 border-destructive/30 shadow-sm" : ""}`
                  : `border-border/50 bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/30
                     ${isOpen ? "text-primary bg-primary/10 border-primary/30 shadow-sm" : ""}`
                }
              `}
            >
              {group.icon}
              <span>{group.label}</span>
              {hasDropdown && (
                <ChevronDown
                  size={10}
                  className={`opacity-40 transition-transform ${isOpen ? "rotate-180" : ""}`}
                />
              )}
            </button>

            {isOpen && hasDropdown && (
              <FloatingDropdown
                anchorRef={{ current: buttonRefs.current[group.id] ?? null }}
                items={group.items}
                danger={group.danger}
                disabled={disabled}
                onSelect={(item) => {
                  onAction(item.kind, item.mode);
                  setOpenGroup(null);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
