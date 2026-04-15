import { describe, expect, it, vi } from "vitest";
import {
  buildSettingsTabItems,
  normalizeSettingsTab,
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
