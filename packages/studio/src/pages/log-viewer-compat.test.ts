import { describe, expect, it } from "vitest";
import { LOG_VIEWER_COMPAT_MESSAGE_KEY } from "./LogViewer";

describe("LOG_VIEWER_COMPAT_MESSAGE_KEY", () => {
  it("exports logs migration copy key", () => {
    expect(LOG_VIEWER_COMPAT_MESSAGE_KEY).toBe("compat.logsMoved");
  });
});
