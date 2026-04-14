import { describe, expect, it } from "vitest";
import { daemonControlCompatMessageKey } from "./DaemonControl";

describe("daemonControlCompatMessageKey", () => {
  it("renders daemon migration copy key", () => {
    expect(daemonControlCompatMessageKey()).toBe("compat.daemonMoved");
  });
});
