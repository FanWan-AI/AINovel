import { describe, expect, it, vi } from "vitest";
import {
  buildSettingsTabItems,
  collectWritingDuplicateKeys,
  normalizeSettingsTab,
  normalizeWritingGovernanceForm,
  resolveSettingsTabContent,
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
  });
});

describe("buildSettingsTabItems", () => {
  const t = ((key: string) => key) as TFunction;

  it("builds five tabs and marks the active one", () => {
    const items = buildSettingsTabItems({
      tab: "genre",
      onTabChange: vi.fn(),
      t,
    });

    expect(items).toHaveLength(5);
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
});

describe("resolveSettingsTabContent", () => {
  it("maps provider, genre and writing tabs to content panels", () => {
    expect(resolveSettingsTabContent("provider")).toBe("provider");
    expect(resolveSettingsTabContent("genre")).toBe("genre");
    expect(resolveSettingsTabContent("writing")).toBe("writing");
  });

  it("keeps non-migrated tabs on placeholder content", () => {
    expect(resolveSettingsTabContent("locale")).toBe("placeholder");
    expect(resolveSettingsTabContent("appearance")).toBe("placeholder");
  });

  it("falls back unknown tab input to provider content via normalizeSettingsTab", () => {
    expect(resolveSettingsTabContent("unknown" as never)).toBe("provider");
  });
});
