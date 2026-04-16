import { describe, expect, it, vi } from "vitest";
import {
  buildHeaderQuickActions,
  deriveActiveBookId,
  mapRouteToActivePage,
  parseSettingsTabFromQuery,
  resolveLegacyRoute,
  resolveInitialRouteFromSearch,
  routeToRuntimeCenterFromLegacy,
  routeToSettingsFromLegacy,
  routeToAssistant,
} from "./App";

describe("deriveActiveBookId", () => {
  it("returns the current book across book-centered routes", () => {
    expect(deriveActiveBookId({ page: "book", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "chapter", bookId: "beta", chapterNumber: 3 })).toBe("beta");
    expect(deriveActiveBookId({ page: "truth", bookId: "gamma" })).toBe("gamma");
    expect(deriveActiveBookId({ page: "analytics", bookId: "delta" })).toBe("delta");
  });

  it("returns undefined for non-book routes", () => {
    expect(deriveActiveBookId({ page: "dashboard" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "assistant" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "settings" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "style" })).toBeUndefined();
  });

  it("returns undefined for runtime-center route", () => {
    expect(deriveActiveBookId({ page: "runtime-center" })).toBeUndefined();
  });
});

describe("routeToRuntimeCenterFromLegacy", () => {
  it("redirects daemon entry to runtime center", () => {
    expect(routeToRuntimeCenterFromLegacy("daemon")).toEqual({ page: "runtime-center" });
  });

  it("redirects logs entry to runtime center", () => {
    expect(routeToRuntimeCenterFromLegacy("logs")).toEqual({ page: "runtime-center" });
  });
});

describe("routeToSettingsFromLegacy", () => {
  it("redirects config entry to settings provider tab", () => {
    expect(routeToSettingsFromLegacy("config")).toEqual({ page: "settings", tab: "provider" });
  });

  it("redirects genres entry to settings genre tab", () => {
    expect(routeToSettingsFromLegacy("genres")).toEqual({ page: "settings", tab: "genre" });
  });
});

describe("settings tab query parsing", () => {
  it("parses valid settings tab from search params", () => {
    expect(parseSettingsTabFromQuery("?tab=genre")).toBe("genre");
    expect(parseSettingsTabFromQuery("?tab=writing")).toBe("writing");
  });

  it("returns provider tab for invalid tab values and undefined when missing", () => {
    expect(parseSettingsTabFromQuery("?tab=unknown")).toBe("provider");
    expect(parseSettingsTabFromQuery("")).toBeUndefined();
  });

  it("resolves initial route to settings when tab query exists", () => {
    expect(resolveInitialRouteFromSearch("?tab=appearance")).toEqual({ page: "settings", tab: "appearance" });
    expect(resolveInitialRouteFromSearch("")).toEqual({ page: "dashboard" });
  });
});

describe("resolveLegacyRoute", () => {
  it("resolves config and genres legacy routes", () => {
    expect(resolveLegacyRoute({ page: "config" })).toEqual({ page: "settings", tab: "provider" });
    expect(resolveLegacyRoute({ page: "genres" })).toEqual({ page: "settings", tab: "genre" });
  });

  it("keeps non-legacy routes unchanged", () => {
    expect(resolveLegacyRoute({ page: "assistant" })).toEqual({ page: "assistant" });
    expect(resolveLegacyRoute({ page: "runtime-center" })).toEqual({ page: "runtime-center" });
  });
});

describe("mapRouteToActivePage", () => {
  it("maps settings tabs back to legacy active keys for sidebar highlighting", () => {
    expect(mapRouteToActivePage({ page: "settings", tab: "provider" })).toBe("config");
    expect(mapRouteToActivePage({ page: "settings", tab: "genre" })).toBe("genres");
  });

  it("keeps normal route page or active book key", () => {
    expect(mapRouteToActivePage({ page: "assistant" })).toBe("assistant");
    expect(mapRouteToActivePage({ page: "book", bookId: "book-a" }, "book-a")).toBe("book:book-a");
  });
});

describe("buildHeaderQuickActions", () => {
  it("keeps AI Assistant before settings in header quick actions", () => {
    const actions = buildHeaderQuickActions({
      currentRoute: { page: "dashboard" },
      nav: { toAssistant: vi.fn(), toSettings: vi.fn() },
    });

    expect(actions.map((action) => action.key)).toEqual(["assistant", "settings"]);
  });

  it("wires assistant/settings navigation callbacks", () => {
    const toAssistant = vi.fn();
    const toSettings = vi.fn();
    const actions = buildHeaderQuickActions({
      currentRoute: { page: "assistant" },
      nav: { toAssistant, toSettings },
    });

    actions[0]?.onClick();
    actions[1]?.onClick();

    expect(toAssistant).toHaveBeenCalledTimes(1);
    expect(toSettings).toHaveBeenCalledTimes(1);
    expect(actions[0]?.active).toBe(true);
    expect(actions[1]?.active).toBe(false);
  });
});

describe("routeToAssistant", () => {
  it("returns assistant route with trimmed prompt payload for ChatBar handoff", () => {
    expect(routeToAssistant("  审计第5章  ", 123456)).toEqual({
      page: "assistant",
      prompt: "审计第5章",
      promptKey: "123456",
    });
  });

  it("returns plain assistant route when prompt is empty", () => {
    expect(routeToAssistant("   ")).toEqual({ page: "assistant" });
    expect(routeToAssistant()).toEqual({ page: "assistant" });
  });
});
