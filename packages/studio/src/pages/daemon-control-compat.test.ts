import { describe, expect, it } from "vitest";
import { DAEMON_COMPAT_MESSAGE_KEY } from "./DaemonControl";

describe("DAEMON_COMPAT_MESSAGE_KEY", () => {
  it("exports daemon migration copy key", () => {
    expect(DAEMON_COMPAT_MESSAGE_KEY).toBe("compat.daemonMoved");
  });
});
