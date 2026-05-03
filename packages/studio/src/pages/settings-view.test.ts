import { describe, expect, it, vi } from "vitest";
import {
  buildSettingsTabItems,
  buildBookLengthPreferenceDraft,
  clampBookLengthTolerance,
  collectWritingDuplicateKeys,
  formatBookLengthRange,
  normalizeSettingsTab,
  normalizeAssistantStrategyForm,
  normalizeWritingGovernanceForm,
  resolveSettingsTabContent,
  saveAssistantStrategy,
  saveBookLengthPreference,
  saveWritingGovernance,
} from "./SettingsView";
import type { TFunction } from "../hooks/use-i18n";

describe("normalizeSettingsTab", () => {
  it("falls back to provider when tab is missing or invalid", () => {
    expect(normalizeSettingsTab()).toBe("provider");
    expect(normalizeSettingsTab("unknown")).toBe("provider");
  });

  it("accepts all supported settings tabs", () => {
    expect(normalizeSettingsTab("locale")).toBe("locale");
    expect(normalizeSettingsTab("provider")).toBe("provider");
    expect(normalizeSettingsTab("genre")).toBe("genre");
    expect(normalizeSettingsTab("appearance")).toBe("appearance");
    expect(normalizeSettingsTab("writing")).toBe("writing");
    expect(normalizeSettingsTab("assistant")).toBe("assistant");
  });
});

describe("buildSettingsTabItems", () => {
  const t = ((key: string) => key) as TFunction;

  it("builds six tabs and marks the active one", () => {
    const items = buildSettingsTabItems({
      tab: "genre",
      onTabChange: vi.fn(),
      t,
    });

    expect(items).toHaveLength(6);
    expect(items.filter((item) => item.active).map((item) => item.key)).toEqual(["genre"]);
  });

  it("invokes tab change callback when a tab item is clicked", () => {
    const onTabChange = vi.fn();
    const items = buildSettingsTabItems({
      tab: "provider",
      onTabChange,
      t,
    });

    const writingTab = items.find((item) => item.key === "writing");
    writingTab?.onClick();

    expect(onTabChange).toHaveBeenCalledWith("writing");
  });
});

describe("writing governance helpers", () => {
  it("normalizes missing settings to defaults", () => {
    expect(normalizeWritingGovernanceForm()).toEqual({
      styleTemplate: "narrative-balance",
      reviewStrictnessBaseline: "balanced",
      antiAiTraceStrength: "medium",
    });
  });

  it("saves governance form to project endpoint", async () => {
    const putApiImpl = vi.fn().mockResolvedValue(undefined);
    await saveWritingGovernance({
      styleTemplate: "dialogue-driven",
      reviewStrictnessBaseline: "strict",
      antiAiTraceStrength: "high",
    }, { putApiImpl });
    expect(putApiImpl).toHaveBeenCalledWith("/project/writing-governance", {
      styleTemplate: "dialogue-driven",
      reviewStrictnessBaseline: "strict",
      antiAiTraceStrength: "high",
    });
  });

  it("rethrows save errors from API call", async () => {
    const putApiImpl = vi.fn().mockRejectedValue(new Error("save failed"));
    await expect(saveWritingGovernance({
      styleTemplate: "dialogue-driven",
      reviewStrictnessBaseline: "strict",
      antiAiTraceStrength: "high",
    }, { putApiImpl })).rejects.toThrow("save failed");
  });

  it("guards duplicate keys against BookDetail operation keys", () => {
    expect(collectWritingDuplicateKeys()).toEqual([]);
    expect(collectWritingDuplicateKeys({
      governanceKeys: ["plan-next-and-write", "style-template-global"],
      bookDetailKeys: ["plan-next-and-write", "quick-write"],
    })).toEqual(["plan-next-and-write"]);
  });

  it("builds per-book length drafts with a visible accepted range", () => {
    const draft = buildBookLengthPreferenceDraft({
      id: "book-1",
      title: "测试书",
      chapterWordCount: 3000,
      chapterLengthTolerancePercent: 30,
    });

    expect(draft).toEqual({
      chapterWordCount: 3000,
      chapterLengthTolerancePercent: 30,
    });
    expect(formatBookLengthRange(draft)).toBe("2100-3900 字");
  });

  it("clamps book length tolerance to the supported author controls", () => {
    expect(clampBookLengthTolerance(5)).toBe(10);
    expect(clampBookLengthTolerance(90)).toBe(80);
    expect(clampBookLengthTolerance(Number.NaN)).toBe(30);
  });

  it("saves per-book length preferences to the book endpoint", async () => {
    const putApiImpl = vi.fn().mockResolvedValue(undefined);
    await saveBookLengthPreference("book-1", {
      chapterWordCount: 3200,
      chapterLengthTolerancePercent: 40,
    }, { putApiImpl });

    expect(putApiImpl).toHaveBeenCalledWith("/books/book-1", {
      chapterWordCount: 3200,
      chapterLengthTolerancePercent: 40,
    });
  });
});

describe("assistant strategy helpers", () => {
  it("normalizes missing assistant strategy settings to defaults", () => {
    expect(normalizeAssistantStrategyForm()).toEqual({
      autopilotLevel: "guarded",
      autoFixThreshold: 85,
      maxAutoFixIterations: 3,
      budgetLimit: 0,
      budgetCurrency: "tokens",
      approvalSkills: [],
      publishQualityGate: 80,
    });
  });

  it("saves assistant strategy form to project endpoint", async () => {
    const putApiImpl = vi.fn().mockResolvedValue(undefined);
    await saveAssistantStrategy({
      autopilotLevel: "manual",
      autoFixThreshold: 90,
      maxAutoFixIterations: 4,
      budgetLimit: 1200,
      budgetCurrency: "tokens",
      approvalSkills: ["trusted.anti-detect"],
      publishQualityGate: 88,
    }, { putApiImpl });
    expect(putApiImpl).toHaveBeenCalledWith("/project/assistant-strategy", {
      autopilotLevel: "manual",
      autoFixThreshold: 90,
      maxAutoFixIterations: 4,
      budget: {
        limit: 1200,
        currency: "tokens",
      },
      approvalSkills: ["trusted.anti-detect"],
      publishQualityGate: 88,
    });
  });
});

describe("resolveSettingsTabContent", () => {
  it("maps provider, genre, writing and assistant tabs to content panels", () => {
    expect(resolveSettingsTabContent("provider")).toBe("provider");
    expect(resolveSettingsTabContent("genre")).toBe("genre");
    expect(resolveSettingsTabContent("writing")).toBe("writing");
    expect(resolveSettingsTabContent("assistant")).toBe("assistant");
  });

  it("keeps non-migrated tabs on placeholder content", () => {
    expect(resolveSettingsTabContent("locale")).toBe("placeholder");
    expect(resolveSettingsTabContent("appearance")).toBe("placeholder");
  });

  it("falls back unknown tab input to provider content via normalizeSettingsTab", () => {
    expect(resolveSettingsTabContent("unknown" as never)).toBe("provider");
  });
});
