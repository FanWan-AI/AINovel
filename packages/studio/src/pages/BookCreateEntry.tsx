import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Zap, Layers } from "lucide-react";

interface Nav {
  toDashboard: () => void;
  toBookCreateSimple: () => void;
}

export function BookCreateEntry({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span className="text-border">/</span>
        <span>{t("bread.newBook")}</span>
      </div>

      {/* Heading */}
      <div className="space-y-2">
        <h1 className="font-serif text-3xl">{t("entry.title")}</h1>
        <p className="text-muted-foreground">{t("entry.subtitle")}</p>
      </div>

      {/* Mode Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Quick Start */}
        <button
          onClick={nav.toBookCreateSimple}
          className={`group text-left p-6 rounded-xl border ${c.card} bg-card hover:border-primary/40 transition-all space-y-4`}
        >
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary/20 transition-colors">
            <Zap size={20} />
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-base">{t("entry.quickTitle")}</div>
            <div className="text-sm text-muted-foreground leading-relaxed">{t("entry.quickDesc")}</div>
          </div>
          <div className={`inline-flex items-center px-4 py-2 rounded-md text-sm font-medium ${c.btnPrimary}`}>
            {t("entry.quickBtn")}
          </div>
        </button>

        {/* Professional Mode (coming soon) */}
        <div className={`text-left p-6 rounded-xl border border-border bg-card/50 opacity-60 space-y-4 cursor-not-allowed`}>
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
            <Layers size={20} />
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-base">{t("entry.proTitle")}</div>
            <div className="text-sm text-muted-foreground leading-relaxed">{t("entry.proDesc")}</div>
          </div>
          <div className={`inline-flex items-center px-4 py-2 rounded-md text-sm font-medium ${c.btnSecondary} opacity-60`}>
            {t("entry.proBtn")}
          </div>
        </div>
      </div>
    </div>
  );
}
