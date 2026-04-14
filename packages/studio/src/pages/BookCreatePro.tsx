import { useState, useEffect } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { CreativeBrief } from "../shared/contracts";
import { useColors } from "../hooks/use-colors";
import { ProStepIndicator } from "../components/create/ProStepIndicator";
import {
  ProStepBlueprint,
  validateBlueprint,
} from "../components/create/ProStepBlueprint";
import type { BlueprintFields } from "../components/create/ProStepBlueprint";
import { ProStepWorld, validateWorld } from "../components/create/ProStepWorld";
import type { WorldFields } from "../components/create/ProStepWorld";
import { ProStepPlot, validatePlot } from "../components/create/ProStepPlot";
import type { PlotFields } from "../components/create/ProStepPlot";
import {
  PRO_DRAFT_KEY,
  loadDraft,
  saveDraft,
  clearDraft,
  canNavigateToStep,
} from "../hooks/use-create-flow";

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

export interface ProFormState {
  blueprint: BlueprintFields;
  world: WorldFields;
  plot: PlotFields;
}

/** Shape of the data persisted to localStorage between sessions. */
export interface ProDraftData {
  form: ProFormState;
  /** The highest step index the user has successfully validated (−1 = none). */
  highestValidated: number;
}

export const INITIAL_PRO_FORM: ProFormState = {
  blueprint: {
    title: "",
    coreGenres: "",
    positioning: "",
    targetAudience: "",
    platformIntent: "",
  },
  world: {
    worldSetting: "",
    protagonist: "",
  },
  plot: {
    mainConflict: "",
    endingDirection: "",
    styleRules: "",
    forbiddenPatterns: "",
  },
};

/** Converts comma-separated string to a trimmed, non-empty string array. */
function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Assembles a {@link CreativeBrief} from the multi-step form state. */
export function assembleBrief(form: ProFormState): CreativeBrief {
  return {
    title: form.blueprint.title.trim(),
    coreGenres: splitCsv(form.blueprint.coreGenres),
    positioning: form.blueprint.positioning.trim(),
    worldSetting: form.world.worldSetting.trim(),
    protagonist: form.world.protagonist.trim(),
    mainConflict: form.plot.mainConflict.trim(),
    endingDirection: form.plot.endingDirection.trim() || undefined,
    styleRules: splitCsv(form.plot.styleRules),
    forbiddenPatterns: splitCsv(form.plot.forbiddenPatterns),
    targetAudience: form.blueprint.targetAudience.trim() || undefined,
    platformIntent: form.blueprint.platformIntent.trim() || undefined,
  };
}

export type ProStep = 0 | 1 | 2;

/** Returns a validation error key for the given step, or null if valid. */
export function validateStep(step: ProStep, form: ProFormState): ReturnType<typeof validateBlueprint> {
  if (step === 0) return validateBlueprint(form.blueprint);
  if (step === 1) return validateWorld(form.world);
  return validatePlot(form.plot);
}

// ---------------------------------------------------------------------------
// Nav interface
// ---------------------------------------------------------------------------

interface Nav {
  toDashboard: () => void;
  toBookCreateEntry: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BookCreatePro({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);

  // Restore draft from localStorage — each lazy initializer reads from the same key;
  // the two synchronous reads are negligible and the simplest correct approach.
  const [form, setForm] = useState<ProFormState>(() => loadDraft<ProDraftData>(PRO_DRAFT_KEY)?.form ?? INITIAL_PRO_FORM);
  const [highestValidated, setHighestValidated] = useState<number>(() => loadDraft<ProDraftData>(PRO_DRAFT_KEY)?.highestValidated ?? -1);
  const [step, setStep] = useState<ProStep>(0);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<CreativeBrief | null>(null);

  // Auto-save draft whenever form or highestValidated changes.
  useEffect(() => {
    saveDraft<ProDraftData>(PRO_DRAFT_KEY, { form, highestValidated });
  }, [form, highestValidated]);

  const stepsMeta = [
    { index: 0, label: t("pro.step1.label") },
    { index: 1, label: t("pro.step2.label") },
    { index: 2, label: t("pro.step3.label") },
  ];

  const handleNext = () => {
    const errKey = validateStep(step, form);
    if (errKey) {
      setError(t(errKey));
      return;
    }
    setError(null);
    // Record that this step has been validated.
    setHighestValidated((prev) => Math.max(prev, step));
    if (step < 2) {
      setStep((step + 1) as ProStep);
    } else {
      // Final step — assemble brief
      setBrief(assembleBrief(form));
    }
  };

  const handleBack = () => {
    setError(null);
    if (step > 0) {
      setStep((step - 1) as ProStep);
    } else {
      nav.toBookCreateEntry();
    }
  };

  /** Navigate to a specific step via the step indicator (step guard applies). */
  const handleStepClick = (index: number) => {
    if (!canNavigateToStep(index, highestValidated)) return;
    setError(null);
    setStep(index as ProStep);
  };

  /** Clears the persisted draft and resets the form to its initial state. */
  const handleClearDraft = () => {
    clearDraft(PRO_DRAFT_KEY);
    setForm(INITIAL_PRO_FORM);
    setHighestValidated(-1);
    setStep(0);
    setError(null);
    setBrief(null);
  };

  // Brief summary view shown after completing all steps
  if (brief) {
    return (
      <div className="max-w-2xl mx-auto space-y-8">
        <Breadcrumb nav={nav} t={t} c={c} />
        <h1 className="font-serif text-3xl">{t("pro.briefTitle")}</h1>

        <div className={`border ${c.cardStatic} rounded-xl p-6 space-y-4 bg-card`}>
          <BriefField label={t("review.titleLabel")} value={brief.title} />
          <BriefField label={t("review.positioningLabel")} value={brief.positioning} />
          <BriefField label={t("review.worldLabel")} value={brief.worldSetting} />
          <BriefField label={t("review.protagonistLabel")} value={brief.protagonist} />
          <BriefField label={t("review.conflictLabel")} value={brief.mainConflict} />
          {brief.endingDirection && (
            <BriefField label={t("pro.step3.endingLabel")} value={brief.endingDirection} />
          )}
          {brief.coreGenres.length > 0 && (
            <BriefField label={t("pro.step1.genresLabel")} value={brief.coreGenres.join(", ")} />
          )}
          {brief.targetAudience && (
            <BriefField label={t("pro.step1.audienceLabel")} value={brief.targetAudience} />
          )}
          {brief.platformIntent && (
            <BriefField label={t("pro.step1.platformLabel")} value={brief.platformIntent} />
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => { setBrief(null); setStep(0); }}
            className={`flex-1 px-4 py-3 ${c.btnSecondary} rounded-md font-medium text-base`}
          >
            {t("pro.editAgain")}
          </button>
          <button
            onClick={nav.toDashboard}
            className={`flex-1 px-4 py-3 ${c.btnPrimary} rounded-md font-medium text-base`}
          >
            {t("pro.done")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <Breadcrumb nav={nav} t={t} c={c} />

      <h1 className="font-serif text-3xl">{t("pro.pageTitle")}</h1>

      {/* Step indicator — supports click-to-jump with step guard */}
      <ProStepIndicator
        steps={stepsMeta}
        currentStep={step}
        highestValidated={highestValidated}
        onStepClick={handleStepClick}
      />

      {/* Step heading */}
      <div className="space-y-1">
        <h2 className="font-semibold text-lg">{stepsMeta[step].label}</h2>
        <p className="text-sm text-muted-foreground">{t(STEP_SUBTITLES[step])}</p>
      </div>

      {/* Step body */}
      {step === 0 && (
        <ProStepBlueprint
          fields={form.blueprint}
          onChange={(blueprint) => { setForm({ ...form, blueprint }); setError(null); }}
          error={error}
          theme={theme}
          t={t}
        />
      )}
      {step === 1 && (
        <ProStepWorld
          fields={form.world}
          onChange={(world) => { setForm({ ...form, world }); setError(null); }}
          error={error}
          theme={theme}
          t={t}
        />
      )}
      {step === 2 && (
        <ProStepPlot
          fields={form.plot}
          onChange={(plot) => { setForm({ ...form, plot }); setError(null); }}
          error={error}
          theme={theme}
          t={t}
        />
      )}

      {/* Navigation buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleBack}
          className={`flex-1 px-4 py-3 ${c.btnSecondary} rounded-md font-medium text-base`}
        >
          {t("pro.back")}
        </button>
        <button
          onClick={handleNext}
          className={`flex-1 px-4 py-3 ${c.btnPrimary} rounded-md font-medium text-base`}
        >
          {step < 2 ? t("pro.next") : t("pro.finish")}
        </button>
      </div>

      {/* Clear draft */}
      <div className="flex justify-end">
        <button
          onClick={handleClearDraft}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive transition-colors"
        >
          {t("pro.clearDraft")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

import type { StringKey } from "../hooks/use-i18n";

const STEP_SUBTITLES: [StringKey, StringKey, StringKey] = [
  "pro.step1.subtitle",
  "pro.step2.subtitle",
  "pro.step3.subtitle",
];

function Breadcrumb({
  nav,
  t,
  c,
}: {
  nav: Nav;
  t: TFunction;
  c: ReturnType<typeof useColors>;
}) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
      <span className="text-border">/</span>
      <button onClick={nav.toBookCreateEntry} className={c.link}>{t("bread.newBook")}</button>
      <span className="text-border">/</span>
      <span>{t("pro.pageTitle")}</span>
    </div>
  );
}

function BriefField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{label}</dt>
      <dd className="text-sm text-foreground leading-relaxed">{value}</dd>
    </div>
  );
}
