import { describe, expect, it } from "vitest";
import { applyBriefUpdate } from "./use-create-flow";
import type { CreativeBrief } from "../shared/contracts";

const stubBrief: CreativeBrief = {
  title: "My Story",
  coreGenres: ["科幻"],
  positioning: "A sci-fi adventure",
  worldSetting: "Near-future earth",
  protagonist: "Aria",
  mainConflict: "Consciousness vs machine",
  styleRules: [],
  forbiddenPatterns: [],
};

describe("applyBriefUpdate", () => {
  it("returns null when current brief is null", () => {
    expect(applyBriefUpdate(null, { title: "New Title" })).toBeNull();
  });

  it("merges partial updates into the existing brief", () => {
    const updated = applyBriefUpdate(stubBrief, { title: "Updated Title" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated Title");
    expect(updated!.protagonist).toBe("Aria");
  });

  it("allows updating multiple fields at once", () => {
    const updated = applyBriefUpdate(stubBrief, {
      title: "New Title",
      protagonist: "Zara",
      mainConflict: "Human vs AI",
    });
    expect(updated!.title).toBe("New Title");
    expect(updated!.protagonist).toBe("Zara");
    expect(updated!.mainConflict).toBe("Human vs AI");
    expect(updated!.worldSetting).toBe("Near-future earth");
  });

  it("does not mutate the original brief", () => {
    applyBriefUpdate(stubBrief, { title: "Changed" });
    expect(stubBrief.title).toBe("My Story");
  });
});
