import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { ConfigView } from "./ConfigView";
import { GenreManager } from "./GenreManager";

export type SettingsTab = "locale" | "provider" | "genre" | "appearance" | "writing";

interface SettingsTabDefinition {
  readonly key: SettingsTab;
  readonly labelKey:
    | "settings.tab.locale"
    | "settings.tab.provider"
    | "settings.tab.genre"
    | "settings.tab.appearance"
    | "settings.tab.writing";
  readonly placeholderTitleKey:
    | "settings.placeholder.locale.title"
    | "settings.placeholder.provider.title"
    | "settings.placeholder.genre.title"
    | "settings.placeholder.appearance.title"
    | "settings.placeholder.writing.title";
  readonly placeholderDescKey:
    | "settings.placeholder.locale.desc"
    | "settings.placeholder.provider.desc"
    | "settings.placeholder.genre.desc"
    | "settings.placeholder.appearance.desc"
    | "settings.placeholder.writing.desc";
}

export const SETTINGS_TAB_DEFINITIONS: ReadonlyArray<SettingsTabDefinition> = [
  {
    key: "locale",
    labelKey: "settings.tab.locale",
    placeholderTitleKey: "settings.placeholder.locale.title",
    placeholderDescKey: "settings.placeholder.locale.desc",
  },
  {
    key: "provider",
    labelKey: "settings.tab.provider",
    placeholderTitleKey: "settings.placeholder.provider.title",
    placeholderDescKey: "settings.placeholder.provider.desc",
  },
  {
    key: "genre",
    labelKey: "settings.tab.genre",
    placeholderTitleKey: "settings.placeholder.genre.title",
    placeholderDescKey: "settings.placeholder.genre.desc",
  },
  {
    key: "appearance",
    labelKey: "settings.tab.appearance",
    placeholderTitleKey: "settings.placeholder.appearance.title",
    placeholderDescKey: "settings.placeholder.appearance.desc",
  },
  {
    key: "writing",
    labelKey: "settings.tab.writing",
    placeholderTitleKey: "settings.placeholder.writing.title",
    placeholderDescKey: "settings.placeholder.writing.desc",
  },
] as const;

export const DEFAULT_SETTINGS_TAB: SettingsTab = "provider";

export function normalizeSettingsTab(tab?: string): SettingsTab {
  const matched = SETTINGS_TAB_DEFINITIONS.find((item) => item.key === tab);
  return matched?.key ?? DEFAULT_SETTINGS_TAB;
}

export function buildSettingsTabItems({
  tab,
  onTabChange,
  t,
}: {
  tab?: SettingsTab;
  onTabChange: (nextTab: SettingsTab) => void;
  t: TFunction;
}) {
  const activeTab = normalizeSettingsTab(tab);
  return SETTINGS_TAB_DEFINITIONS.map((item) => ({
    key: item.key,
    label: t(item.labelKey),
    active: item.key === activeTab,
    onClick: () => onTabChange(item.key),
  }));
}

export type SettingsTabContent = "provider" | "genre" | "placeholder";

export function resolveSettingsTabContent(tab?: SettingsTab): SettingsTabContent {
  const activeTab = normalizeSettingsTab(tab);
  if (activeTab === "provider" || activeTab === "genre") {
    return activeTab;
  }
  return "placeholder";
}

interface Nav {
  toDashboard: () => void;
}

export function SettingsView({
  nav,
  tab,
  onTabChange,
  theme: _theme,
  t,
}: {
  nav: Nav;
  tab?: SettingsTab;
  onTabChange: (nextTab: SettingsTab) => void;
  theme: Theme;
  t: TFunction;
}) {
  const activeTab = normalizeSettingsTab(tab);
  const tabItems = buildSettingsTabItems({ tab: activeTab, onTabChange, t });
  const activeTabDefinition = SETTINGS_TAB_DEFINITIONS.find((item) => item.key === activeTab) ?? SETTINGS_TAB_DEFINITIONS[0];
  const tabContent = resolveSettingsTabContent(activeTab);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className="hover:text-primary transition-colors">{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("settings.title")}</span>
      </div>

      <div className="space-y-3">
        <h1 className="font-serif text-3xl">{t("settings.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card/40 p-2">
        <div className="flex min-w-max gap-2">
          {tabItems.map((item) => (
            <button
              key={item.key}
              onClick={item.onClick}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                item.active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tabContent === "provider" && <ConfigView nav={nav} theme={_theme} t={t} />}
      {tabContent === "genre" && <GenreManager nav={nav} theme={_theme} t={t} />}
      {tabContent === "placeholder" && (
        <div className="rounded-lg border border-dashed border-border px-6 py-10">
          <h2 className="text-base font-semibold text-foreground">{t(activeTabDefinition.placeholderTitleKey)}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t(activeTabDefinition.placeholderDescKey)}</p>
        </div>
      )}
    </div>
  );
}
