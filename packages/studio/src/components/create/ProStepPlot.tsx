import type { TFunction } from "../../hooks/use-i18n";
import type { StringKey } from "../../hooks/use-i18n";
import { useColors } from "../../hooks/use-colors";
import type { Theme } from "../../hooks/use-theme";

export interface PlotFields {
  mainConflict: string;
  endingDirection: string;
  styleRules: string;
  forbiddenPatterns: string;
}

export function validatePlot(fields: PlotFields): StringKey | null {
  if (!fields.mainConflict.trim()) return "pro.step3.conflictRequired";
  return null;
}

interface Props {
  fields: PlotFields;
  onChange: (fields: PlotFields) => void;
  error: string | null;
  theme: Theme;
  t: TFunction;
}

export function ProStepPlot({ fields, onChange, error, theme, t }: Props) {
  const c = useColors(theme);

  const set = (key: keyof PlotFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...fields, [key]: e.target.value });

  return (
    <div className="space-y-5">
      {error && (
        <div className={`border ${c.error} rounded-md px-4 py-3 text-sm`}>{error}</div>
      )}

      {/* Main Conflict */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step3.conflictLabel")} <span className="text-destructive">*</span>
        </label>
        <textarea
          value={fields.mainConflict}
          onChange={set("mainConflict")}
          rows={4}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          placeholder={t("pro.step3.conflictPlaceholder")}
        />
      </div>

      {/* Ending Direction */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step3.endingLabel")}
        </label>
        <input
          type="text"
          value={fields.endingDirection}
          onChange={set("endingDirection")}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          placeholder={t("pro.step3.endingPlaceholder")}
        />
      </div>

      {/* Style Rules */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step3.styleLabel")}
        </label>
        <input
          type="text"
          value={fields.styleRules}
          onChange={set("styleRules")}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          placeholder={t("pro.step3.stylePlaceholder")}
        />
      </div>

      {/* Forbidden Patterns */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step3.forbiddenLabel")}
        </label>
        <input
          type="text"
          value={fields.forbiddenPatterns}
          onChange={set("forbiddenPatterns")}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          placeholder={t("pro.step3.forbiddenPlaceholder")}
        />
      </div>
    </div>
  );
}
