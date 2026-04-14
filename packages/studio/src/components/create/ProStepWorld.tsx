import type { TFunction } from "../../hooks/use-i18n";
import type { StringKey } from "../../hooks/use-i18n";
import { useColors } from "../../hooks/use-colors";
import type { Theme } from "../../hooks/use-theme";

export interface WorldFields {
  worldSetting: string;
  protagonist: string;
}

export function validateWorld(fields: WorldFields): StringKey | null {
  if (!fields.worldSetting.trim()) return "pro.step2.worldRequired";
  if (!fields.protagonist.trim()) return "pro.step2.protagonistRequired";
  return null;
}

interface Props {
  fields: WorldFields;
  onChange: (fields: WorldFields) => void;
  error: string | null;
  theme: Theme;
  t: TFunction;
}

export function ProStepWorld({ fields, onChange, error, theme, t }: Props) {
  const c = useColors(theme);

  const set = (key: keyof WorldFields) => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    onChange({ ...fields, [key]: e.target.value });

  return (
    <div className="space-y-5">
      {error && (
        <div className={`border ${c.error} rounded-md px-4 py-3 text-sm`}>{error}</div>
      )}

      {/* World Setting */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step2.worldLabel")} <span className="text-destructive">*</span>
        </label>
        <textarea
          value={fields.worldSetting}
          onChange={set("worldSetting")}
          rows={5}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          placeholder={t("pro.step2.worldPlaceholder")}
        />
      </div>

      {/* Protagonist */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step2.protagonistLabel")} <span className="text-destructive">*</span>
        </label>
        <textarea
          value={fields.protagonist}
          onChange={set("protagonist")}
          rows={4}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          placeholder={t("pro.step2.protagonistPlaceholder")}
        />
      </div>
    </div>
  );
}
