import { describe, expect, it, vi } from "vitest";
import { buildReviewDraft, validateReviewDraft, callConfirmCreate } from "./BookCreateReview";
import type { CreativeBrief } from "../shared/contracts";
import { postApi } from "../hooks/use-api";

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
    expect(validateReviewDraft({ ...draft, title: "" })).toBe("review.titleRequired");
  });

  it("returns an error key when title is only whitespace", () => {
    const draft = buildReviewDraft(stubBrief);
    expect(validateReviewDraft({ ...draft, title: "   " })).toBe("review.titleRequired");
  });

  it("accepts a title with leading/trailing whitespace as valid", () => {
    const draft = buildReviewDraft(stubBrief);
    // title " Hello " has non-whitespace content so it should pass
    expect(validateReviewDraft({ ...draft, title: " Hello " })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// callConfirmCreate
// ---------------------------------------------------------------------------

describe("callConfirmCreate", () => {
  const stubDraft = buildReviewDraft(stubBrief);

  it("calls postApi with the correct path and payload", async () => {
    const mockPost = vi.fn().mockResolvedValue({ status: "creating", bookId: "my-story" });
    const result = await callConfirmCreate(
      { mode: "simple", briefId: "brief_123", brief: stubBrief, draft: stubDraft },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    expect(result).toEqual({ status: "creating", bookId: "my-story" });
    expect(mockPost).toHaveBeenCalledOnce();
    const [path, body] = mockPost.mock.calls[0] as [string, unknown];
    expect(path).toBe("/v2/books/create/confirm");
    expect(body).toMatchObject({
      mode: "simple",
      briefId: "brief_123",
      bookConfig: { title: "My Story", genre: "奇幻" },
    });
  });

  it("derives genre from coreGenres[0]", async () => {
    const mockPost = vi.fn().mockResolvedValue({ status: "creating", bookId: "x" });
    await callConfirmCreate(
      { mode: "simple", briefId: null, brief: stubBrief, draft: stubDraft },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, { bookConfig: { genre: string } }];
    expect(body.bookConfig.genre).toBe("奇幻");
  });

  it("falls back to 'fiction' when coreGenres is empty", async () => {
    const briefNoGenre: CreativeBrief = { ...stubBrief, coreGenres: [] };
    const mockPost = vi.fn().mockResolvedValue({ status: "creating", bookId: "x" });
    await callConfirmCreate(
      { mode: "simple", briefId: null, brief: briefNoGenre, draft: stubDraft },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, { bookConfig: { genre: string } }];
    expect(body.bookConfig.genre).toBe("fiction");
  });

  it("merges draft edits into the brief sent to the server", async () => {
    const editedDraft = { ...stubDraft, title: "Updated Title", protagonist: "New Hero" };
    const mockPost = vi.fn().mockResolvedValue({ status: "creating", bookId: "updated-title" });
    await callConfirmCreate(
      { mode: "simple", briefId: null, brief: stubBrief, draft: editedDraft },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, { brief: CreativeBrief; bookConfig: { title: string } }];
    expect(body.brief.title).toBe("Updated Title");
    expect(body.brief.protagonist).toBe("New Hero");
    expect(body.bookConfig.title).toBe("Updated Title");
  });

  it("omits briefId from payload when briefId is null", async () => {
    const mockPost = vi.fn().mockResolvedValue({ status: "creating", bookId: "x" });
    await callConfirmCreate(
      { mode: "simple", briefId: null, brief: stubBrief, draft: stubDraft },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.briefId).toBeUndefined();
  });

  it("propagates errors thrown by the postApi implementation", async () => {
    const mockPost = vi.fn().mockRejectedValue(new Error("Network error"));
    await expect(
      callConfirmCreate(
        { mode: "simple", briefId: null, brief: stubBrief, draft: stubDraft },
        { postApiImpl: mockPost as unknown as typeof postApi },
      ),
    ).rejects.toThrow("Network error");
  });
});
