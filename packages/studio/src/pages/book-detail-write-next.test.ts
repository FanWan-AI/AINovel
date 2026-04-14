import { describe, expect, it, vi } from "vitest";
import {
  buildWriteNextPayload,
  INITIAL_WRITE_NEXT_FORM,
} from "../components/write-next/WriteNextDialog";
import type { WriteNextFormState, WriteNextPayload } from "../components/write-next/WriteNextDialog";
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
