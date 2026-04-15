import { useEffect, useMemo, useState } from "react";
import { putApi, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";

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

interface Nav {
  toDashboard: () => void;
}

export type WritingStyleTemplate = "narrative-balance" | "dialogue-driven" | "cinematic";
export type ReviewStrictnessBaseline = "balanced" | "strict" | "strict-plus";
export type AntiAiTraceStrength = "medium" | "high" | "max";

export interface WritingGovernanceSettings {
  readonly schemaVersion: number;
  readonly styleTemplate: WritingStyleTemplate;
  readonly reviewStrictnessBaseline: ReviewStrictnessBaseline;
  readonly antiAiTraceStrength: AntiAiTraceStrength;
  readonly updatedAt: string;
  readonly extensions?: Record<string, unknown>;
}

export interface WritingGovernanceForm {
  readonly styleTemplate: WritingStyleTemplate;
  readonly reviewStrictnessBaseline: ReviewStrictnessBaseline;
  readonly antiAiTraceStrength: AntiAiTraceStrength;
}

export const DEFAULT_WRITING_GOVERNANCE_FORM: WritingGovernanceForm = {
  styleTemplate: "narrative-balance",
  reviewStrictnessBaseline: "balanced",
  antiAiTraceStrength: "medium",
};

export const BOOK_DETAIL_OPERATION_KEYS = [
  "plan-next-and-write",
  "quick-write",
  "draft",
  "chapter-rewrite",
  "chapter-revise",
  "chapter-anti-detect",
] as const;

export const WRITING_GOVERNANCE_KEYS = [
  "style-template-global",
  "review-strictness-baseline",
  "anti-ai-trace-strength",
] as const;

export function normalizeWritingGovernanceForm(
  settings?: Partial<WritingGovernanceSettings> | null,
): WritingGovernanceForm {
  return {
    styleTemplate:
      settings?.styleTemplate === "dialogue-driven" || settings?.styleTemplate === "cinematic"
        ? settings.styleTemplate
        : DEFAULT_WRITING_GOVERNANCE_FORM.styleTemplate,
    reviewStrictnessBaseline:
      settings?.reviewStrictnessBaseline === "strict" || settings?.reviewStrictnessBaseline === "strict-plus"
        ? settings.reviewStrictnessBaseline
        : DEFAULT_WRITING_GOVERNANCE_FORM.reviewStrictnessBaseline,
    antiAiTraceStrength:
      settings?.antiAiTraceStrength === "high" || settings?.antiAiTraceStrength === "max"
        ? settings.antiAiTraceStrength
        : DEFAULT_WRITING_GOVERNANCE_FORM.antiAiTraceStrength,
  };
}

export function buildWritingGovernancePayload(form: WritingGovernanceForm): WritingGovernanceForm {
  return {
    styleTemplate: form.styleTemplate,
    reviewStrictnessBaseline: form.reviewStrictnessBaseline,
    antiAiTraceStrength: form.antiAiTraceStrength,
  };
}

interface SaveWritingGovernanceOptions {
  readonly putApiImpl?: typeof putApi;
}

export async function saveWritingGovernance(
  form: WritingGovernanceForm,
  options: SaveWritingGovernanceOptions = {},
): Promise<void> {
  const putApiImpl = options.putApiImpl ?? putApi;
  await putApiImpl("/project/writing-governance", buildWritingGovernancePayload(form));
}

export function collectWritingDuplicateKeys({
  governanceKeys = WRITING_GOVERNANCE_KEYS,
  bookDetailKeys = BOOK_DETAIL_OPERATION_KEYS,
}: {
  governanceKeys?: ReadonlyArray<string>;
  bookDetailKeys?: ReadonlyArray<string>;
} = {}): ReadonlyArray<string> {
  const bookDetailSet = new Set(bookDetailKeys);
  return governanceKeys.filter((key) => bookDetailSet.has(key));
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
  const { data: writingGovernanceData, loading: writingGovernanceLoading, error: writingGovernanceError, refetch: refetchWritingGovernance } = useApi<{
    readonly settings: WritingGovernanceSettings;
  }>("/project/writing-governance");
  const [writingForm, setWritingForm] = useState<WritingGovernanceForm>(DEFAULT_WRITING_GOVERNANCE_FORM);
  const [savingWritingGovernance, setSavingWritingGovernance] = useState(false);
  const duplicateKeys = useMemo(() => collectWritingDuplicateKeys(), []);

  useEffect(() => {
    setWritingForm(normalizeWritingGovernanceForm(writingGovernanceData?.settings));
  }, [writingGovernanceData?.settings]);

  const renderWritingGovernancePanel = () => {
    if (writingGovernanceLoading) {
      return <p className="text-sm text-muted-foreground">加载写作偏好中...</p>;
    }
    if (writingGovernanceError) {
      return <p className="text-sm text-destructive">写作偏好加载失败：{writingGovernanceError}</p>;
    }

    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">写作偏好全局治理</h2>
          <p className="text-sm text-muted-foreground">系统级治理，不影响单次手动操作优先级。</p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-2 text-sm">
            <span className="font-medium text-foreground">写作风格模板全局偏好</span>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={writingForm.styleTemplate}
              onChange={(e) => setWritingForm((prev) => ({ ...prev, styleTemplate: e.target.value as WritingStyleTemplate }))}
            >
              <option value="narrative-balance">叙事均衡</option>
              <option value="dialogue-driven">对话驱动</option>
              <option value="cinematic">电影感镜头</option>
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="font-medium text-foreground">审查严格程度基线</span>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={writingForm.reviewStrictnessBaseline}
              onChange={(e) => setWritingForm((prev) => ({ ...prev, reviewStrictnessBaseline: e.target.value as ReviewStrictnessBaseline }))}
            >
              <option value="balanced">平衡</option>
              <option value="strict">严格</option>
              <option value="strict-plus">严格+</option>
            </select>
          </label>

          <label className="space-y-2 text-sm">
            <span className="font-medium text-foreground">反 AI 痕迹强度策略</span>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={writingForm.antiAiTraceStrength}
              onChange={(e) => setWritingForm((prev) => ({ ...prev, antiAiTraceStrength: e.target.value as AntiAiTraceStrength }))}
            >
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="max">极高</option>
            </select>
          </label>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {writingGovernanceData?.settings?.updatedAt
              ? `最近保存：${new Date(writingGovernanceData.settings.updatedAt).toLocaleString()}`
              : "尚未保存过写作偏好。"}
          </div>
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            disabled={savingWritingGovernance}
            onClick={async () => {
              setSavingWritingGovernance(true);
              try {
                await saveWritingGovernance(writingForm);
                await refetchWritingGovernance();
              } finally {
                setSavingWritingGovernance(false);
              }
            }}
          >
            {savingWritingGovernance ? "保存中..." : "保存全局策略"}
          </button>
        </div>

        <div className="space-y-3 rounded-md border border-border/70 bg-card/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">重复项对照表（写作偏好 vs BookDetail）</h3>
            <span className={`text-xs font-medium ${duplicateKeys.length === 0 ? "text-emerald-500" : "text-destructive"}`}>
              {duplicateKeys.length === 0 ? "无重复项" : `发现 ${duplicateKeys.length} 项重复`}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-muted-foreground">
                <th className="px-2 py-2 text-left font-medium">治理项</th>
                <th className="px-2 py-2 text-left font-medium">BookDetail 动作</th>
                <th className="px-2 py-2 text-left font-medium">结论</th>
              </tr>
            </thead>
            <tbody>
              {[
                { policy: "写作风格模板全局偏好", bookAction: "写下一章 / 快速写（单次执行）" },
                { policy: "审查严格程度基线", bookAction: "章节审校 / 修订（单次执行）" },
                { policy: "反 AI 痕迹强度策略", bookAction: "anti-detect（章节级动作）" },
              ].map((item) => (
                <tr key={item.policy} className="border-b border-border/40 last:border-b-0">
                  <td className="px-2 py-2">{item.policy}</td>
                  <td className="px-2 py-2 text-muted-foreground">{item.bookAction}</td>
                  <td className="px-2 py-2 text-emerald-500">职责分层，避免重复</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
          后续可扩展策略点：支持更细粒度风格模板版本、题材差异化基线与按模型提供方的治理覆盖。
        </div>
      </div>
    );
  };

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

      {activeTab === "writing" ? (
        <div className="rounded-lg border border-border px-6 py-6">
          {renderWritingGovernancePanel()}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-6 py-10">
          <h2 className="text-base font-semibold text-foreground">{t(activeTabDefinition.placeholderTitleKey)}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t(activeTabDefinition.placeholderDescKey)}</p>
        </div>
      )}
    </div>
  );
}
