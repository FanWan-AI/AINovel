import { describe, expect, it } from "vitest";
import { translateChapterStatus } from "./BookDetail";
import { strings } from "../hooks/use-i18n";
import type { TFunction } from "../hooks/use-i18n";

// Minimal stub that echoes the translation key so tests stay readable without
// depending on the full i18n catalogue.
const t: TFunction = (key: string) => key;

// ---------------------------------------------------------------------------
// translateChapterStatus
// Maps raw API status strings to i18n display labels used in the
// controlled write-next flow (and elsewhere in the chapter list UI).
// ---------------------------------------------------------------------------

describe("translateChapterStatus", () => {
  it("maps ready-for-review to the expected i18n key", () => {
    expect(translateChapterStatus("ready-for-review", t)).toBe("chapter.readyForReview");
  });

  it("maps approved to the expected i18n key", () => {
    expect(translateChapterStatus("approved", t)).toBe("chapter.approved");
  });

  it("maps drafted to the expected i18n key", () => {
    expect(translateChapterStatus("drafted", t)).toBe("chapter.drafted");
  });

  it("maps needs-revision to the expected i18n key", () => {
    expect(translateChapterStatus("needs-revision", t)).toBe("chapter.needsRevision");
  });

  it("maps imported to the expected i18n key", () => {
    expect(translateChapterStatus("imported", t)).toBe("chapter.imported");
  });

  it("maps audit-failed to the expected i18n key", () => {
    expect(translateChapterStatus("audit-failed", t)).toBe("chapter.auditFailed");
  });

  it("passes through unknown status values unchanged", () => {
    expect(translateChapterStatus("some-unknown-status", t)).toBe("some-unknown-status");
    expect(translateChapterStatus("", t)).toBe("");
  });

  it("covers every status that the write-next pipeline can produce", () => {
    // These are the statuses the server writes into the chapter index after
    // write-next and draft operations complete. Keeping this list in sync with
    // the server contract ensures the UI never shows a raw API string to users.
    const pipelineStatuses = [
      "ready-for-review",
      "drafted",
      "needs-revision",
      "approved",
      "imported",
      "audit-failed",
    ];

    for (const status of pipelineStatuses) {
      const label = translateChapterStatus(status, t);
      // A properly mapped status is never the same as the raw status string
      // (the i18n key has a "chapter." prefix).
      expect(label).not.toBe(status);
      expect(label).toMatch(/^chapter\./);
    }
  });
});

// ---------------------------------------------------------------------------
// BookDetail copy assertions — verifies the i18n keys used in BookDetail.tsx
// render the correct copy per the feat(copy) onboarding upgrade spec.
// ---------------------------------------------------------------------------

describe("BookDetail — feat(copy) button label assertions", () => {
  it("primary write button label is '规划下章并写作' in Chinese", () => {
    // BookDetail renders: t("book.writeNext") for the primary write button
    expect(strings["book.writeNext"].zh).toBe("规划下章并写作");
  });

  it("quick-write button label is '快速写' in Chinese", () => {
    // BookDetail renders: t("writeNext.quickWrite") for the secondary quick-write button
    expect(strings["writeNext.quickWrite"].zh).toBe("快速写");
  });

  it("empty-chapter hint references the updated button name", () => {
    // book.noChapters is shown when there are no chapters yet
    expect(strings["book.noChapters"].zh).toContain("规划下章并写作");
  });

  it("NextPlanPanel section header is 'AI 生成建议' in Chinese", () => {
    // NextPlanPanel renders: t("book.nextPlan") as the section header
    expect(strings["book.nextPlan"].zh).toBe("AI 生成建议");
  });

  it("WriteNextDialog title is '手动规划' in Chinese", () => {
    // WriteNextDialog renders: t("writeNext.dialogTitle") as its header title
    expect(strings["writeNext.dialogTitle"].zh).toBe("手动规划");
  });

  it("book.manualPlanLabel provides the '手动规划' label key", () => {
    expect(strings["book.manualPlanLabel"].zh).toBe("手动规划");
  });
});

