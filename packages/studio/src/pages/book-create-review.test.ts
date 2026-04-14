import { describe, expect, it } from "vitest";
import { buildReviewDraft, validateReviewDraft } from "./BookCreateReview";
import type { CreativeBrief } from "../shared/contracts";

const stubBrief: CreativeBrief = {
  title: "My Story",
  coreGenres: ["奇幻"],
  positioning: "Epic fantasy adventure",
  worldSetting: "A magical realm",
  protagonist: "Hero",
  mainConflict: "Good vs Evil",
  styleRules: [],
  forbiddenPatterns: [],
};

describe("buildReviewDraft", () => {
  it("extracts the editable fields from a CreativeBrief", () => {
    const draft = buildReviewDraft(stubBrief);
    expect(draft.title).toBe("My Story");
    expect(draft.positioning).toBe("Epic fantasy adventure");
    expect(draft.worldSetting).toBe("A magical realm");
    expect(draft.protagonist).toBe("Hero");
    expect(draft.mainConflict).toBe("Good vs Evil");
  });

  it("does not include non-editable fields", () => {
    const draft = buildReviewDraft(stubBrief);
    expect(Object.keys(draft)).toEqual([
      "title",
      "positioning",
      "worldSetting",
      "protagonist",
      "mainConflict",
    ]);
  });
});

describe("validateReviewDraft", () => {
  it("returns null when all required fields are present", () => {
    const draft = buildReviewDraft(stubBrief);
    expect(validateReviewDraft(draft)).toBeNull();
  });

  it("returns an error key when title is empty", () => {
    const draft = buildReviewDraft(stubBrief);
    expect(validateReviewDraft({ ...draft, title: "" })).toBe("title_required");
  });

  it("returns an error key when title is only whitespace", () => {
    const draft = buildReviewDraft(stubBrief);
    expect(validateReviewDraft({ ...draft, title: "   " })).toBe("title_required");
  });

  it("accepts a title with leading/trailing whitespace as valid", () => {
    const draft = buildReviewDraft(stubBrief);
    // title " Hello " has non-whitespace content so it should pass
    expect(validateReviewDraft({ ...draft, title: " Hello " })).toBeNull();
  });
});
