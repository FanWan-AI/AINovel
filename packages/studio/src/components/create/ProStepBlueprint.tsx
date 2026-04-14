import type { TFunction } from "../../hooks/use-i18n";
import type { StringKey } from "../../hooks/use-i18n";
import { useColors } from "../../hooks/use-colors";
import type { Theme } from "../../hooks/use-theme";

export interface BlueprintFields {
  title: string;
  coreGenres: string;
  positioning: string;
  targetAudience: string;
  platformIntent: string;
}

export function validateBlueprint(fields: BlueprintFields): StringKey | null {
  if (!fields.title.trim()) return "pro.step1.titleRequired";
  if (!fields.positioning.trim()) return "pro.step1.positioningRequired";
  return null;
}

interface Props {
  fields: BlueprintFields;
  onChange: (fields: BlueprintFields) => void;
  error: string | null;
  theme: Theme;
  t: TFunction;
}

export function ProStepBlueprint({ fields, onChange, error, theme, t }: Props) {
  const c = useColors(theme);

  const set = (key: keyof BlueprintFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...fields, [key]: e.target.value });

  return (
    <div className="space-y-5">
      {error && (
        <div className={`border ${c.error} rounded-md px-4 py-3 text-sm`}>{error}</div>
      )}

      {/* Title */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step1.titleLabel")} <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={fields.title}
          onChange={set("title")}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          placeholder={t("pro.step1.titlePlaceholder")}
        />
      </div>

      {/* Core Genres */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step1.genresLabel")}
        </label>
        <input
          type="text"
          value={fields.coreGenres}
          onChange={set("coreGenres")}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          placeholder={t("pro.step1.genresPlaceholder")}
        />
      </div>

      {/* Positioning */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step1.positioningLabel")} <span className="text-destructive">*</span>
        </label>
        <textarea
          value={fields.positioning}
          onChange={set("positioning")}
          rows={3}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          placeholder={t("pro.step1.positioningPlaceholder")}
        />
      </div>

      {/* Target Audience */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step1.audienceLabel")}
        </label>
        <input
          type="text"
          value={fields.targetAudience}
          onChange={set("targetAudience")}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          placeholder={t("pro.step1.audiencePlaceholder")}
        />
      </div>

      {/* Platform Intent */}
      <div>
        <label className="block text-sm text-muted-foreground mb-2">
          {t("pro.step1.platformLabel")}
        </label>
        <input
          type="text"
          value={fields.platformIntent}
          onChange={set("platformIntent")}
          className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          placeholder={t("pro.step1.platformPlaceholder")}
        />
      </div>
    </div>
  );
}
