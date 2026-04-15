import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";

export type SettingsTab = "provider" | "genre";

interface Nav {
  toDashboard: () => void;
}

export function SettingsView({
  nav,
  tab,
}: {
  nav: Nav;
  tab?: SettingsTab;
  theme: Theme;
  t: TFunction;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className="hover:text-primary transition-colors">Home</button>
        <span className="text-border">/</span>
        <span>Settings</span>
      </div>
      <div className="rounded-lg border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">
        Settings page placeholder{tab ? ` (tab=${tab})` : ""}
      </div>
    </div>
  );
}
