import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";

interface Nav {
  toDashboard: () => void;
}

export function AssistantView({ nav, theme: _theme, t: _t }: { nav: Nav; theme: Theme; t: TFunction }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className="hover:text-primary transition-colors">Home</button>
        <span className="text-border">/</span>
        <span>Assistant</span>
      </div>
      <div className="rounded-lg border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">
        Assistant page placeholder
      </div>
    </div>
  );
}
