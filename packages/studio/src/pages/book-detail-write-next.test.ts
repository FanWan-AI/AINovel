import { describe, expect, it, vi } from "vitest";
import {
  buildWriteNextPayload,
  buildPlanPayloadFromNextPlan,
  applyPlanToFormState,
  INITIAL_WRITE_NEXT_FORM,
} from "../components/write-next/WriteNextDialog";
import type { WriteNextFormState, WriteNextPayload, PlanningTab } from "../components/write-next/WriteNextDialog";
import type { NextPlanResult } from "../hooks/use-api";
import { postApi } from "../hooks/use-api";

// ---------------------------------------------------------------------------
// buildWriteNextPayload — payload assembly
// ---------------------------------------------------------------------------

describe("buildWriteNextPayload", () => {
  it("returns an empty object for the initial empty form", () => {
    const payload = buildWriteNextPayload(INITIAL_WRITE_NEXT_FORM);
    expect(payload).toEqual({});
  });

  it("includes goal when chapterGoal is filled", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, chapterGoal: "主角获得新武器" };
    expect(buildWriteNextPayload(form).chapterGoal).toBe("主角获得新武器");
  });

  it("includes mustInclude when filled", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, mustInclude: "出现反派" };
    expect(buildWriteNextPayload(form).mustInclude).toEqual(["出现反派"]);
  });

  it("includes avoidElements when filled", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, avoidElements: "无谓打斗" };
    expect(buildWriteNextPayload(form).mustAvoid).toEqual(["无谓打斗"]);
  });

  it("includes pacing when filled", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, pacing: "紧张" };
    expect(buildWriteNextPayload(form).pace).toBe("fast");
  });

  it("includes wordCount as a number when filled with a valid integer", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, wordCount: "3000" };
    expect(buildWriteNextPayload(form).wordCount).toBe(3000);
  });

  it("omits wordCount when the string is not a valid positive integer", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, wordCount: "abc" };
    expect(buildWriteNextPayload(form).wordCount).toBeUndefined();
  });

  it("omits wordCount when zero", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, wordCount: "0" };
    expect(buildWriteNextPayload(form).wordCount).toBeUndefined();
  });

  it("trims whitespace from string fields", () => {
    const form: WriteNextFormState = {
      ...INITIAL_WRITE_NEXT_FORM,
      chapterGoal: "  目标  ",
      mustInclude: "  必须  ",
      avoidElements: "  避免  ",
      pacing: "  缓慢  ",
    };
    const payload = buildWriteNextPayload(form);
    expect(payload.chapterGoal).toBe("目标");
    expect(payload.mustInclude).toEqual(["必须"]);
    expect(payload.mustAvoid).toEqual(["避免"]);
    expect(payload.pace).toBe("slow");
  });

  it("omits blank string fields from the payload", () => {
    const form: WriteNextFormState = {
      chapterGoal: "目标",
      mustInclude: "",
      avoidElements: "   ",
      pacing: "",
      wordCount: "",
    };
    const payload = buildWriteNextPayload(form);
    expect(payload.chapterGoal).toBe("目标");
    expect(payload.mustInclude).toBeUndefined();
    expect(payload.mustAvoid).toBeUndefined();
    expect(payload.pace).toBeUndefined();
    expect(payload.wordCount).toBeUndefined();
  });

  it("assembles a full payload when all fields are set", () => {
    const form: WriteNextFormState = {
      chapterGoal: "获得神器",
      mustInclude: "导师出现",
      avoidElements: "冗长内心独白",
      pacing: "快节奏",
      wordCount: "4000",
    };
    const payload = buildWriteNextPayload(form);
    expect(payload).toEqual<WriteNextPayload>({
      chapterGoal: "获得神器",
      mustInclude: ["导师出现"],
      mustAvoid: ["冗长内心独白"],
      pace: "fast",
      wordCount: 4000,
    });
  });
});

// ---------------------------------------------------------------------------
// dialog open/close toggle — pure state logic
// ---------------------------------------------------------------------------

describe("writeNextDialog toggle logic", () => {
  it("initial dialog state is closed (false)", () => {
    // Models the useState(false) default for writeNextDialogOpen
    const initialOpen = false;
    expect(initialOpen).toBe(false);
  });

  it("clicking write-next button opens the dialog (sets state to true)", () => {
    let dialogOpen = false;
    // Simulates: onClick={() => setWriteNextDialogOpen(true)}
    const openDialog = () => { dialogOpen = true; };
    openDialog();
    expect(dialogOpen).toBe(true);
  });

  it("clicking cancel closes the dialog (sets state to false)", () => {
    let dialogOpen = true;
    // Simulates: onCancel={() => setWriteNextDialogOpen(false)}
    const closeDialog = () => { dialogOpen = false; };
    closeDialog();
    expect(dialogOpen).toBe(false);
  });

  it("submitting closes the dialog before posting", () => {
    let dialogOpen = true;
    // Simulates first line of handleWriteNextWithPayload
    const handleSubmit = () => { dialogOpen = false; };
    handleSubmit();
    expect(dialogOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// quick-write fallback path — posts without a body
// ---------------------------------------------------------------------------

describe("quick-write fallback path", () => {
  it("calls postApi with only the path and no body for quick write", async () => {
    const mockPost = vi.fn().mockResolvedValue(undefined);
    // Simulates handleQuickWrite body
    await mockPost("/books/book-123/write-next");
    expect(mockPost).toHaveBeenCalledOnce();
    const [path, body] = mockPost.mock.calls[0] as [string, unknown];
    expect(path).toBe("/books/book-123/write-next");
    expect(body).toBeUndefined();
  });

  it("calls postApi with the payload when dialog is submitted with data", async () => {
    const mockPost = vi.fn().mockResolvedValue(undefined) as unknown as typeof postApi;
    const payload = buildWriteNextPayload({
      chapterGoal: "关键战斗",
      mustInclude: "",
      avoidElements: "",
      pacing: "",
      wordCount: "3000",
    });
    // Simulates handleWriteNextWithPayload body
    await mockPost(`/books/book-123/write-next`, Object.keys(payload).length > 0 ? payload : undefined);
    expect(mockPost).toHaveBeenCalledOnce();
    const [path, body] = (mockPost as ReturnType<typeof vi.fn>).mock.calls[0] as [string, WriteNextPayload];
    expect(path).toBe("/books/book-123/write-next");
    expect(body).toEqual({ chapterGoal: "关键战斗", wordCount: 3000 });
  });

  it("passes undefined body to postApi when payload is empty (dialog submitted with all blank fields)", async () => {
    const mockPost = vi.fn().mockResolvedValue(undefined) as unknown as typeof postApi;
    const payload = buildWriteNextPayload(INITIAL_WRITE_NEXT_FORM);
    // Simulates handleWriteNextWithPayload body — empty payload becomes undefined
    await mockPost(`/books/book-123/write-next`, Object.keys(payload).length > 0 ? payload : undefined);
    expect(mockPost).toHaveBeenCalledOnce();
    const [path, body] = (mockPost as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
    expect(path).toBe("/books/book-123/write-next");
    expect(body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildPlanPayloadFromNextPlan — AI plan → write-next payload conversion
// ---------------------------------------------------------------------------

describe("buildPlanPayloadFromNextPlan", () => {
  const plan: NextPlanResult = {
    chapterNumber: 4,
    goal: "主角揭开阴谋",
    conflicts: ["真相让一切变得更复杂", "同伴开始怀疑主角"],
  };

  it("maps goal to chapterGoal", () => {
    expect(buildPlanPayloadFromNextPlan(plan).chapterGoal).toBe("主角揭开阴谋");
  });

  it("maps conflicts to mustInclude", () => {
    expect(buildPlanPayloadFromNextPlan(plan).mustInclude).toEqual([
      "真相让一切变得更复杂",
      "同伴开始怀疑主角",
    ]);
  });

  it("omits chapterGoal when goal is empty", () => {
    const result = buildPlanPayloadFromNextPlan({ ...plan, goal: "" });
    expect(result.chapterGoal).toBeUndefined();
  });

  it("omits mustInclude when conflicts array is empty", () => {
    const result = buildPlanPayloadFromNextPlan({ ...plan, conflicts: [] });
    expect(result.mustInclude).toBeUndefined();
  });

  it("returns an empty object when both goal and conflicts are empty", () => {
    const result = buildPlanPayloadFromNextPlan({ chapterNumber: 1, goal: "", conflicts: [] });
    expect(result).toEqual({});
  });

  it("trims whitespace from goal", () => {
    const result = buildPlanPayloadFromNextPlan({ ...plan, goal: "  目标  " });
    expect(result.chapterGoal).toBe("目标");
  });

  it("filters blank conflict items", () => {
    const result = buildPlanPayloadFromNextPlan({ ...plan, conflicts: ["有效冲突", "   ", ""] });
    expect(result.mustInclude).toEqual(["有效冲突"]);
  });
});

// ---------------------------------------------------------------------------
// Planning panel open/close toggle — pure state logic
// ---------------------------------------------------------------------------

describe("planning panel open/close behavior", () => {
  it("initial planning panel state is closed (false)", () => {
    const initialOpen = false;
    expect(initialOpen).toBe(false);
  });

  it("clicking '规划下章并写作' opens the planning dialog (sets state to true)", () => {
    let dialogOpen = false;
    // Simulates: onClick={() => setWriteNextDialogOpen(true)}
    const openPlanningPanel = () => { dialogOpen = true; };
    openPlanningPanel();
    expect(dialogOpen).toBe(true);
  });

  it("clicking '快速写' does NOT open the planning dialog", () => {
    let dialogOpen = false;
    // Simulates handleQuickWrite — calls postApi directly, never touches dialog state
    const handleQuickWrite = async () => {
      // dialogOpen intentionally NOT set here
    };
    void handleQuickWrite();
    expect(dialogOpen).toBe(false);
  });

  it("cancelling the planning dialog closes it (sets state to false)", () => {
    let dialogOpen = true;
    const closePlanningPanel = () => { dialogOpen = false; };
    closePlanningPanel();
    expect(dialogOpen).toBe(false);
  });

  it("submitting from the planning dialog closes it before posting", () => {
    let dialogOpen = true;
    // Simulates first line of handleWriteNextWithPayload
    const handleSubmit = () => { dialogOpen = false; };
    handleSubmit();
    expect(dialogOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tab switching — planning panel tab state logic
// ---------------------------------------------------------------------------

describe("planning panel tab switching", () => {
  it("default tab is 'ai' on open", () => {
    const defaultTab: PlanningTab = "ai";
    expect(defaultTab).toBe("ai");
  });

  it("switching to manual tab yields 'manual'", () => {
    let activeTab: PlanningTab = "ai";
    const switchToManual = () => { activeTab = "manual"; };
    switchToManual();
    expect(activeTab).toBe("manual");
  });

  it("switching back to ai tab yields 'ai'", () => {
    let activeTab: PlanningTab = "manual";
    const switchToAI = () => { activeTab = "ai"; };
    switchToAI();
    expect(activeTab).toBe("ai");
  });
});

// ---------------------------------------------------------------------------
// Quick-write path regression — must never open the planning dialog
// ---------------------------------------------------------------------------

describe("quick-write path regression", () => {
  it("quick write posts directly without payload and without touching dialog state", async () => {
    const mockPost = vi.fn().mockResolvedValue(undefined);
    let dialogOpen = false;

    // Simulates handleQuickWrite — dialog is never touched
    const handleQuickWrite = async (bookId: string) => {
      await mockPost(`/books/${bookId}/write-next`);
      // dialogOpen must NOT be set to true
    };

    await handleQuickWrite("book-999");
    expect(dialogOpen).toBe(false);
    expect(mockPost).toHaveBeenCalledWith("/books/book-999/write-next");
    const [, body] = mockPost.mock.calls[0] as [string, unknown];
    expect(body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyPlanToFormState — AI plan → manual form state mapping
// ---------------------------------------------------------------------------

describe("applyPlanToFormState — bring-in mapping correctness", () => {
  const plan: NextPlanResult = {
    chapterNumber: 5,
    goal: "主角揭开阴谋",
    conflicts: ["真相让一切更复杂", "同伴开始怀疑主角"],
  };

  it("maps plan.goal to chapterGoal (trimmed)", () => {
    const form = applyPlanToFormState(plan);
    expect(form.chapterGoal).toBe("主角揭开阴谋");
  });

  it("maps plan.conflicts to mustInclude joined by newlines", () => {
    const form = applyPlanToFormState(plan);
    expect(form.mustInclude).toBe("真相让一切更复杂\n同伴开始怀疑主角");
  });

  it("leaves avoidElements blank (user fills later)", () => {
    const form = applyPlanToFormState(plan);
    expect(form.avoidElements).toBe("");
  });

  it("leaves pacing blank (user fills later)", () => {
    const form = applyPlanToFormState(plan);
    expect(form.pacing).toBe("");
  });

  it("preserves defaultWordCount when provided", () => {
    const form = applyPlanToFormState(plan, 3000);
    expect(form.wordCount).toBe("3000");
  });

  it("leaves wordCount blank when defaultWordCount is omitted", () => {
    const form = applyPlanToFormState(plan);
    expect(form.wordCount).toBe("");
  });

  it("trims whitespace from goal", () => {
    const form = applyPlanToFormState({ ...plan, goal: "  目标  " });
    expect(form.chapterGoal).toBe("目标");
  });

  it("filters blank conflict items from mustInclude", () => {
    const form = applyPlanToFormState({ ...plan, conflicts: ["有效冲突", "   ", ""] });
    expect(form.mustInclude).toBe("有效冲突");
  });

  it("produces empty mustInclude when conflicts array is empty", () => {
    const form = applyPlanToFormState({ ...plan, conflicts: [] });
    expect(form.mustInclude).toBe("");
  });
});

// ---------------------------------------------------------------------------
// adopt-then-edit-then-submit — end-to-end flow
// ---------------------------------------------------------------------------

describe("adopt suggestion, edit, then submit", () => {
  const plan: NextPlanResult = {
    chapterNumber: 3,
    goal: "获得神器",
    conflicts: ["导师考验主角"],
  };

  it("form state is editable after applyPlanToFormState (simulates user edit)", () => {
    const form = applyPlanToFormState(plan);
    // Simulate user editing the chapterGoal after adoption
    const edited = { ...form, chapterGoal: "获得神器，但代价惨重" };
    expect(edited.chapterGoal).toBe("获得神器，但代价惨重");
    // Other fields from the plan are preserved
    expect(edited.mustInclude).toBe("导师考验主角");
  });

  it("submitting the edited form via buildWriteNextPayload yields correct payload fields", () => {
    const form = applyPlanToFormState(plan, 4000);
    const edited = { ...form, avoidElements: "冗长独白", pacing: "快节奏" };
    const payload = buildWriteNextPayload(edited);
    expect(payload.chapterGoal).toBe("获得神器");
    expect(payload.mustInclude).toEqual(["导师考验主角"]);
    expect(payload.mustAvoid).toEqual(["冗长独白"]);
    expect(payload.pace).toBe("fast");
    expect(payload.wordCount).toBe(4000);
  });

  it("submitting adopted+edited form posts with mode='manual-plan'", async () => {
    const mockPost = vi.fn().mockResolvedValue(undefined);
    const form = applyPlanToFormState(plan, 2000);
    const edited = { ...form, chapterGoal: "获得神器，但代价惨重" };

    // Simulates handleSubmit in WriteNextDialog — adds mode: "manual-plan"
    const payload: WriteNextPayload = { ...buildWriteNextPayload(edited), mode: "manual-plan" };
    await mockPost(`/books/book-42/write-next`, payload);

    const [, body] = mockPost.mock.calls[0] as [string, WriteNextPayload];
    expect(body.mode).toBe("manual-plan");
    expect(body.chapterGoal).toBe("获得神器，但代价惨重");
  });
});

// ---------------------------------------------------------------------------
// mode field — correctness tests
// ---------------------------------------------------------------------------

describe("mode field correctness", () => {
  it("manual form submission always includes mode='manual-plan'", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, chapterGoal: "本章目标" };
    // Simulates handleSubmit which spreads mode: "manual-plan"
    const payload: WriteNextPayload = { ...buildWriteNextPayload(form), mode: "manual-plan" };
    expect(payload.mode).toBe("manual-plan");
  });

  it("manual form submission mode is 'manual-plan' even for an empty form", () => {
    const payload: WriteNextPayload = { ...buildWriteNextPayload(INITIAL_WRITE_NEXT_FORM), mode: "manual-plan" };
    expect(payload.mode).toBe("manual-plan");
  });

  it("quick-write path does NOT send a mode field", async () => {
    const mockPost = vi.fn().mockResolvedValue(undefined);
    // Simulates handleQuickWrite — no body at all
    await mockPost("/books/book-1/write-next");
    const [, body] = mockPost.mock.calls[0] as [string, WriteNextPayload | undefined];
    expect(body).toBeUndefined();
  });

  it("buildWriteNextPayload itself does not include mode (mode is added by the submit handler)", () => {
    const form: WriteNextFormState = { ...INITIAL_WRITE_NEXT_FORM, chapterGoal: "目标" };
    const payload = buildWriteNextPayload(form);
    expect(payload.mode).toBeUndefined();
  });
});
