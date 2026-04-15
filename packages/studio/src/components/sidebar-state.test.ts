import { describe, expect, it, vi } from "vitest";
import { buildSystemSidebarItems } from "./Sidebar";

describe("buildSystemSidebarItems", () => {
  const t = ((key: string) => key) as (key: "nav.assistant" | "nav.runtimeCenter" | "nav.running") => string;

  it("only keeps assistant and runtime center in system section", () => {
    const items = buildSystemSidebarItems({
      nav: { toAssistant: vi.fn(), toRuntimeCenter: vi.fn() },
      activePage: "dashboard",
      daemonRunning: false,
      t,
    });

    expect(items.map((item) => item.key)).toEqual(["assistant", "runtime-center"]);
  });

  it("routes assistant entry to assistant page", () => {
    const toAssistant = vi.fn();
    const items = buildSystemSidebarItems({
      nav: { toAssistant, toRuntimeCenter: vi.fn() },
      activePage: "dashboard",
      daemonRunning: false,
      t,
    });

    items[0]?.onClick();

    expect(toAssistant).toHaveBeenCalledTimes(1);
    expect(items[0]?.active).toBe(false);
  });
});
