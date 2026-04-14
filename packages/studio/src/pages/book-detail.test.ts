import { describe, expect, it } from "vitest";
import { translateChapterStatus } from "./BookDetail";
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
