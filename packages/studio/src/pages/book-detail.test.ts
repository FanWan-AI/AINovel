import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  canApproveChapterStatus,
  canRejectChapterStatus,
  getTopActionIds,
  parseChapterLifecycleEvent,
  QUICK_WRITE_CHAPTER_OPTIONS,
  ReleaseCandidatePanel,
  resolveChapterTaskActionType,
  resolveReleaseCandidateBadge,
  resolveRunUnchangedReason,
  supportsRunDiff,
  translateChapterStatus,
} from "./BookDetail";
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

describe("chapter review action visibility", () => {
  it("allows approving only ready-for-review chapters", () => {
    expect(canApproveChapterStatus("ready-for-review")).toBe(true);
    expect(canApproveChapterStatus("audit-failed")).toBe(false);
    expect(canApproveChapterStatus("approved")).toBe(false);
  });

  it("allows rejecting both ready-for-review and audit-failed chapters", () => {
    expect(canRejectChapterStatus("ready-for-review")).toBe(true);
    expect(canRejectChapterStatus("audit-failed")).toBe(true);
    expect(canRejectChapterStatus("approved")).toBe(false);
    expect(canRejectChapterStatus("drafted")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dual-button rendering — verifies only 2 top actions are exposed
// ---------------------------------------------------------------------------

describe("getTopActionIds — dual-button contract", () => {
  it("returns exactly two action IDs", () => {
    const actions = getTopActionIds();
    expect(actions).toHaveLength(2);
  });

  it("exposes planNextAndWrite as the first action", () => {
    const [first] = getTopActionIds();
    expect(first).toBe("planNextAndWrite");
  });

  it("exposes quickWrite as the second action", () => {
    const [, second] = getTopActionIds();
    expect(second).toBe("quickWrite");
  });

  it("does not expose the old draftOnly or writeNext action IDs", () => {
    const actions = getTopActionIds() as ReadonlyArray<string>;
    expect(actions).not.toContain("draftOnly");
    expect(actions).not.toContain("writeNext");
  });
});

describe("quick write chapter count options", () => {
  it("offers exactly 1 through 6 chapters", () => {
    expect(QUICK_WRITE_CHAPTER_OPTIONS).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("resolveReleaseCandidateBadge", () => {
  it("prioritizes persisted release-candidate status over transient eligibility", () => {
    expect(resolveReleaseCandidateBadge(true, false)).toMatchObject({
      label: "已标记发布候选",
    });
  });

  it("shows pass/fail states for eligible and blocked books", () => {
    expect(resolveReleaseCandidateBadge(false, true)).toMatchObject({
      label: "门禁已通过",
    });
    expect(resolveReleaseCandidateBadge(false, false)).toMatchObject({
      label: "未达发布门禁",
    });
  });
});

describe("ReleaseCandidatePanel", () => {
  it("renders blocking reasons when a book is not yet eligible", () => {
    const html = renderToStaticMarkup(createElement(ReleaseCandidatePanel, {
      fallbackIsReleaseCandidate: false,
      evaluation: {
        bookId: "demo-book",
        isReleaseCandidate: false,
        eligible: false,
        publishQualityGate: 80,
        overallScore: 76,
        autopilotLevel: "guarded",
        gates: [
          { gateId: "quality", label: "质量分", passed: false, blocking: true, reason: "全书质量分 76 未达到发布阈值 80。" },
          { gateId: "manual_confirmation", label: "人工确认", passed: false, blocking: true, reason: "尚未确认已完成人工通读。" },
        ],
        blockingReasons: ["全书质量分 76 未达到发布阈值 80。", "尚未确认已完成人工通读。"],
        checkpoint: {
          stage: "release-candidate",
          requiredApproval: true,
          status: "pending",
          reason: "发布候选阶段 checkpoint 等待人工确认。",
        },
      },
      loading: false,
      error: null,
      manualConfirmed: false,
      pendingAction: null,
      onToggleManualConfirmed: vi.fn(),
      onRefresh: vi.fn(),
      onMark: vi.fn(),
      onCancel: vi.fn(),
    }));

    expect(html).toContain("发布候选");
    expect(html).toContain("未达发布门禁");
    expect(html).toContain("尚未确认已完成人工通读。");
    expect(html).toContain("当前阻断原因");
  });

  it("renders marked candidate state and skip-manual hint for autopilot", () => {
    const html = renderToStaticMarkup(createElement(ReleaseCandidatePanel, {
      fallbackIsReleaseCandidate: true,
      evaluation: {
        bookId: "demo-book",
        isReleaseCandidate: true,
        eligible: true,
        publishQualityGate: 70,
        overallScore: 84,
        autopilotLevel: "autopilot",
        gates: [
          { gateId: "quality", label: "质量分", passed: true, blocking: true, reason: "全书质量分 84 已达到发布阈值 70。" },
          { gateId: "manual_confirmation", label: "人工确认", passed: true, blocking: true, reason: "当前策略为 autopilot/L3，发布候选阶段允许跳过人工通读确认。" },
        ],
        blockingReasons: [],
        checkpoint: {
          stage: "release-candidate",
          requiredApproval: true,
          status: "approved",
          reason: "发布候选阶段 checkpoint 已满足人工确认门禁。",
        },
      },
      loading: false,
      error: null,
      manualConfirmed: false,
      pendingAction: null,
      onToggleManualConfirmed: vi.fn(),
      onRefresh: vi.fn(),
      onMark: vi.fn(),
      onCancel: vi.fn(),
    }));

    expect(html).toContain("已标记发布候选");
    expect(html).toContain("当前 autopilot/L3 策略可跳过人工通读确认");
    expect(html).toContain("取消候选");
  });
});

describe("parseChapterLifecycleEvent", () => {
  it("parses unified chapter lifecycle events", () => {
    expect(parseChapterLifecycleEvent("anti-detect:success")).toEqual({
      action: "anti-detect",
      stage: "success",
    });
    expect(parseChapterLifecycleEvent("resync:unchanged")).toEqual({
      action: "resync",
      stage: "unchanged",
    });
  });

  it("maps legacy complete/error events to success/fail", () => {
    expect(parseChapterLifecycleEvent("revise:complete")).toEqual({
      action: "revise",
      stage: "success",
    });
    expect(parseChapterLifecycleEvent("rewrite:error")).toEqual({
      action: "rewrite",
      stage: "fail",
    });
  });
});

describe("resolveChapterTaskActionType", () => {
  it("maps rewrite and resync dialog kinds directly", () => {
    expect(resolveChapterTaskActionType("rewrite")).toBe("rewrite");
    expect(resolveChapterTaskActionType("resync")).toBe("resync");
  });

  it("maps revise modes to task action types", () => {
    expect(resolveChapterTaskActionType("revise", "spot-fix")).toBe("spot-fix");
    expect(resolveChapterTaskActionType("revise", "polish")).toBe("polish");
    expect(resolveChapterTaskActionType("revise", "rework")).toBe("rework");
    expect(resolveChapterTaskActionType("revise", "rewrite")).toBe("rewrite");
    expect(resolveChapterTaskActionType("revise", "anti-detect")).toBe("anti-detect");
  });
});

describe("supportsRunDiff", () => {
  it("allows revise/rewrite/anti-detect runs", () => {
    expect(supportsRunDiff("revise")).toBe(true);
    expect(supportsRunDiff("rewrite")).toBe(true);
    expect(supportsRunDiff("anti-detect")).toBe(true);
  });

  it("ignores unsupported action types", () => {
    expect(supportsRunDiff("resync")).toBe(false);
    expect(supportsRunDiff("spot-fix")).toBe(false);
  });
});

describe("resolveRunUnchangedReason", () => {
  it("returns explicit reason when provided", () => {
    expect(resolveRunUnchangedReason("unchanged", "  no-op  ", "fallback")).toBe("no-op");
  });

  it("uses fallback reason only for unchanged runs", () => {
    expect(resolveRunUnchangedReason("unchanged", null, "fallback")).toBe("fallback");
    expect(resolveRunUnchangedReason("applied", null, "fallback")).toBeNull();
  });
});
