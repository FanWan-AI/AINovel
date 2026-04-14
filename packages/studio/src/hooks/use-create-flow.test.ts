import { describe, expect, it, beforeEach } from "vitest";
import { applyBriefUpdate, loadDraft, saveDraft, clearDraft, canNavigateToStep, PRO_DRAFT_KEY } from "./use-create-flow";
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

// ---------------------------------------------------------------------------
// Draft persistence helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory Storage stub for testing without a DOM. */
function makeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  };
}

describe("PRO_DRAFT_KEY", () => {
  it("is a non-empty string", () => {
    expect(typeof PRO_DRAFT_KEY).toBe("string");
    expect(PRO_DRAFT_KEY.length).toBeGreaterThan(0);
  });
});

describe("loadDraft", () => {
  let storage: ReturnType<typeof makeStorage>;
  beforeEach(() => { storage = makeStorage(); });

  it("returns null when storage is empty", () => {
    expect(loadDraft("key", storage)).toBeNull();
  });

  it("returns null when stored value is invalid JSON", () => {
    storage.setItem("key", "not-json{");
    expect(loadDraft("key", storage)).toBeNull();
  });

  it("returns parsed value when valid JSON is stored", () => {
    const data = { step: 1, form: { title: "Test" } };
    storage.setItem("key", JSON.stringify(data));
    expect(loadDraft("key", storage)).toEqual(data);
  });
});

describe("saveDraft", () => {
  let storage: ReturnType<typeof makeStorage>;
  beforeEach(() => { storage = makeStorage(); });

  it("stores the value as JSON", () => {
    const data = { step: 0, form: { title: "Hello" } };
    saveDraft("key", data, storage);
    expect(storage.getItem("key")).toBe(JSON.stringify(data));
  });

  it("overwrites a previously saved draft", () => {
    saveDraft("key", { step: 0 }, storage);
    saveDraft("key", { step: 2 }, storage);
    expect(loadDraft<{ step: number }>("key", storage)?.step).toBe(2);
  });
});

describe("clearDraft", () => {
  let storage: ReturnType<typeof makeStorage>;
  beforeEach(() => { storage = makeStorage(); });

  it("removes an existing draft so loadDraft returns null", () => {
    saveDraft("key", { step: 1 }, storage);
    clearDraft("key", storage);
    expect(loadDraft("key", storage)).toBeNull();
  });

  it("does not throw when no draft is stored", () => {
    expect(() => clearDraft("key", storage)).not.toThrow();
  });
});

describe("draft round-trip", () => {
  it("save then load returns the original object", () => {
    const storage = makeStorage();
    const payload = { step: 2, form: { title: "大唐" } };
    saveDraft(PRO_DRAFT_KEY, payload, storage);
    expect(loadDraft(PRO_DRAFT_KEY, storage)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Step guard
// ---------------------------------------------------------------------------

describe("canNavigateToStep", () => {
  it("always allows navigating to step 0", () => {
    expect(canNavigateToStep(0, -1)).toBe(true);
    expect(canNavigateToStep(0, 0)).toBe(true);
    expect(canNavigateToStep(0, 2)).toBe(true);
  });

  it("allows the next step when the current step is validated", () => {
    // highestValidated = 0 means step 0 is done → may go to step 1
    expect(canNavigateToStep(1, 0)).toBe(true);
  });

  it("blocks jumping two or more steps ahead", () => {
    // highestValidated = 0 → step 2 is locked
    expect(canNavigateToStep(2, 0)).toBe(false);
  });

  it("allows revisiting completed earlier steps", () => {
    // highestValidated = 2 → all steps available
    expect(canNavigateToStep(0, 2)).toBe(true);
    expect(canNavigateToStep(1, 2)).toBe(true);
    expect(canNavigateToStep(2, 2)).toBe(true);
  });

  it("blocks the next-next step when nothing is validated yet", () => {
    // highestValidated = -1 → only step 0 is available
    expect(canNavigateToStep(1, -1)).toBe(false);
    expect(canNavigateToStep(2, -1)).toBe(false);
  });
});
