import { useState } from "react";
import { postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import type { NormalizeBriefResponse } from "../shared/contracts";

interface Nav {
  toDashboard: () => void;
  toBookCreateEntry: () => void;
}

export interface NormalizeBriefPayload {
  readonly mode: "simple";
  readonly title: string;
  readonly rawInput: string;
  readonly platform?: string;
  readonly language?: string;
}

export async function callNormalizeBrief(
  payload: NormalizeBriefPayload,
  deps?: { readonly postApiImpl?: typeof postApi },
): Promise<NormalizeBriefResponse> {
  const post = deps?.postApiImpl ?? postApi;
  return post<NormalizeBriefResponse>("/v2/books/create/brief/normalize", payload);
}

export function BookCreateSimple({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);

  const [title, setTitle] = useState("");
  const [rawInput, setRawInput] = useState("");
  const [normalizing, setNormalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NormalizeBriefResponse | null>(null);

  const handleNormalize = async () => {
    if (!title.trim()) {
      setError(t("simple.titleRequired"));
      return;
    }
    if (!rawInput.trim()) {
      setError(t("simple.inputRequired"));
      return;
    }

    setNormalizing(true);
    setError(null);
    setResult(null);

    try {
      const response = await callNormalizeBrief({ mode: "simple", title: title.trim(), rawInput: rawInput.trim() });
      setResult(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNormalizing(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span className="text-border">/</span>
        <button onClick={nav.toBookCreateEntry} className={c.link}>{t("bread.newBook")}</button>
        <span className="text-border">/</span>
        <span>{t("simple.title")}</span>
      </div>

      <h1 className="font-serif text-3xl">{t("simple.title")}</h1>

      {/* Error banner */}
      {error && (
        <div className={`border ${c.error} rounded-md px-4 py-3 text-sm`}>
          {error}
        </div>
      )}

      <div className="space-y-5">
        {/* Book title */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("simple.bookTitleLabel")}</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
            placeholder={t("simple.bookTitlePlaceholder")}
          />
        </div>

        {/* Raw creative input */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("simple.rawInputLabel")}</label>
          <textarea
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            rows={8}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
            placeholder={t("simple.rawInputPlaceholder")}
          />
        </div>
      </div>

      <button
        onClick={handleNormalize}
        disabled={normalizing}
        className={`w-full px-4 py-3 ${c.btnPrimary} rounded-md disabled:opacity-50 font-medium text-base`}
      >
        {normalizing ? t("simple.normalizing") : t("simple.normalizeBtn")}
      </button>

      {/* Result display */}
      {result && (
        <div className="space-y-4">
          <h2 className="font-semibold text-lg">{t("simple.briefResult")}</h2>
          <div className={`rounded-xl border ${c.cardStatic} bg-card p-5`}>
            <BriefSummary brief={result.normalizedBrief} />
          </div>
        </div>
      )}
    </div>
  );
}

function BriefSummary({ brief }: { brief: NormalizeBriefResponse["normalizedBrief"] }) {
  const rows: Array<{ label: string; value: string | undefined }> = [
    { label: "标题 / Title", value: brief.title },
    { label: "核心类型 / Genres", value: brief.coreGenres.join("、") },
    { label: "定位 / Positioning", value: brief.positioning },
    { label: "世界观 / World Setting", value: brief.worldSetting },
    { label: "主角 / Protagonist", value: brief.protagonist },
    { label: "主冲突 / Main Conflict", value: brief.mainConflict },
    { label: "结局方向 / Ending", value: brief.endingDirection },
    { label: "风格规则 / Style Rules", value: brief.styleRules.length > 0 ? brief.styleRules.join("、") : undefined },
    { label: "禁区 / Forbidden Patterns", value: brief.forbiddenPatterns.length > 0 ? brief.forbiddenPatterns.join("、") : undefined },
    { label: "目标受众 / Audience", value: brief.targetAudience },
    { label: "平台 / Platform", value: brief.platformIntent },
  ];

  return (
    <dl className="space-y-3">
      {rows.map(({ label, value }) =>
        value ? (
          <div key={label} className="grid grid-cols-[160px_1fr] gap-2 text-sm">
            <dt className="text-muted-foreground shrink-0">{label}</dt>
            <dd className="text-foreground break-words">{value}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
