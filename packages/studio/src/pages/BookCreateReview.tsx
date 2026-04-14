import { useState } from "react";
import { postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { CreativeBrief, ConfirmCreateResponse } from "../shared/contracts";
import { useColors } from "../hooks/use-colors";

interface Nav {
  toDashboard: () => void;
  toBookCreateEntry: () => void;
  toBookCreateSimple: () => void;
  toBook: (bookId: string) => void;
}

interface CreateFlowProps {
  briefId: string | null;
  brief: CreativeBrief | null;
  updateBrief: (updates: Partial<CreativeBrief>) => void;
}

export interface ReviewDraft {
  title: string;
  positioning: string;
  worldSetting: string;
  protagonist: string;
  mainConflict: string;
}

export function buildReviewDraft(brief: CreativeBrief): ReviewDraft {
  return {
    title: brief.title,
    positioning: brief.positioning,
    worldSetting: brief.worldSetting,
    protagonist: brief.protagonist,
    mainConflict: brief.mainConflict,
  };
}

export function validateReviewDraft(draft: ReviewDraft): "review.titleRequired" | null {
  if (!draft.title.trim()) {
    return "review.titleRequired";
  }
  return null;
}

export interface ConfirmPayload {
  readonly mode: "simple";
  readonly briefId: string | null;
  readonly brief: CreativeBrief;
  readonly draft: ReviewDraft;
}

export async function callConfirmCreate(
  payload: ConfirmPayload,
  deps?: { readonly postApiImpl?: typeof postApi },
): Promise<ConfirmCreateResponse> {
  const post = deps?.postApiImpl ?? postApi;
  const genre = payload.brief.coreGenres[0] ?? "fiction";
  const mergedBrief: CreativeBrief = { ...payload.brief, ...payload.draft };
  return post<ConfirmCreateResponse>("/v2/books/create/confirm", {
    mode: payload.mode,
    briefId: payload.briefId ?? undefined,
    brief: mergedBrief,
    bookConfig: {
      title: payload.draft.title.trim(),
      genre,
    },
  });
}

export function BookCreateReview({
  nav,
  theme,
  t,
  flow,
}: {
  nav: Nav;
  theme: Theme;
  t: TFunction;
  flow: CreateFlowProps;
}) {
  const c = useColors(theme);
  const { briefId, brief, updateBrief } = flow;

  const [draft, setDraft] = useState<ReviewDraft | null>(
    brief ? buildReviewDraft(brief) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!brief || !draft) {
    return (
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
          <span className="text-border">/</span>
          <button onClick={nav.toBookCreateEntry} className={c.link}>{t("bread.newBook")}</button>
          <span className="text-border">/</span>
          <span>{t("review.title")}</span>
        </div>
        <h1 className="font-serif text-3xl">{t("review.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("review.noBrief")}</p>
        <button
          onClick={nav.toBookCreateSimple}
          className={`px-4 py-3 ${c.btnSecondary} rounded-md font-medium`}
        >
          {t("review.backToEdit")}
        </button>
      </div>
    );
  }

  const handleFieldChange = (field: keyof ReviewDraft, value: string) => {
    const updated = { ...draft, [field]: value };
    setDraft(updated);
    updateBrief(updated);
    setError(null);
  };

  const handleBack = () => {
    nav.toBookCreateSimple();
  };

  const handleContinue = async () => {
    const validationError = validateReviewDraft(draft);
    if (validationError) {
      setError(t(validationError));
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await callConfirmCreate({ mode: "simple", briefId, brief, draft });
      nav.toBook(response.bookId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
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
        <button onClick={nav.toBookCreateSimple} className={c.link}>{t("simple.title")}</button>
        <span className="text-border">/</span>
        <span>{t("review.title")}</span>
      </div>

      <h1 className="font-serif text-3xl">{t("review.title")}</h1>

      {error && (
        <div className={`border ${c.error} rounded-md px-4 py-3 text-sm`}>
          {error}
        </div>
      )}

      <div className="space-y-5">
        {/* Title */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("review.titleLabel")}</label>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => handleFieldChange("title", e.target.value)}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
          />
        </div>

        {/* Positioning */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("review.positioningLabel")}</label>
          <textarea
            value={draft.positioning}
            onChange={(e) => handleFieldChange("positioning", e.target.value)}
            rows={3}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          />
        </div>

        {/* World Setting */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("review.worldLabel")}</label>
          <textarea
            value={draft.worldSetting}
            onChange={(e) => handleFieldChange("worldSetting", e.target.value)}
            rows={3}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          />
        </div>

        {/* Protagonist */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("review.protagonistLabel")}</label>
          <textarea
            value={draft.protagonist}
            onChange={(e) => handleFieldChange("protagonist", e.target.value)}
            rows={2}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          />
        </div>

        {/* Main Conflict */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("review.conflictLabel")}</label>
          <textarea
            value={draft.mainConflict}
            onChange={(e) => handleFieldChange("mainConflict", e.target.value)}
            rows={2}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base resize-y`}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleBack}
          disabled={submitting}
          className={`flex-1 px-4 py-3 ${c.btnSecondary} rounded-md font-medium text-base disabled:opacity-50`}
        >
          {t("review.backToEdit")}
        </button>
        <button
          onClick={handleContinue}
          disabled={submitting}
          className={`flex-1 px-4 py-3 ${c.btnPrimary} rounded-md font-medium text-base disabled:opacity-50`}
        >
          {submitting ? t("review.confirming") : t("review.continue")}
        </button>
      </div>
    </div>
  );
}
