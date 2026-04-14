import { describe, expect, it } from "vitest";
import { logViewerCompatMessageKey } from "./LogViewer";

describe("logViewerCompatMessageKey", () => {
  it("renders logs migration copy key", () => {
    expect(logViewerCompatMessageKey()).toBe("compat.logsMoved");
  });
});
