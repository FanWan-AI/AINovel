import { describe, expect, it } from "vitest";
import {
  deriveActiveBookId,
  mapRouteToActivePage,
  resolveLegacyRoute,
  routeToRuntimeCenterFromLegacy,
  routeToSettingsFromLegacy,
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
