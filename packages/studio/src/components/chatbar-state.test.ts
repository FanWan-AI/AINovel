import { describe, expect, it } from "vitest";
import {
  buildChatActionApiPath,
  detectChatActionIntent,
  resolveChatActionSseUpdate,
  resolveDirectWriteTarget,
} from "./ChatBar";

describe("resolveDirectWriteTarget", () => {
  it("prefers the active book when the user is already inside a book flow", () => {
    expect(resolveDirectWriteTarget("beta", [
      { id: "alpha" },
      { id: "beta" },
    ])).toEqual({
      bookId: "beta",
      reason: "active",
    });
  });

  it("falls back to the only book when there is no active context", () => {
    expect(resolveDirectWriteTarget(undefined, [{ id: "solo" }])).toEqual({
      bookId: "solo",
      reason: "single",
    });
  });

  it("reports when there is no available target book", () => {
    expect(resolveDirectWriteTarget(undefined, [])).toEqual({
      bookId: null,
      reason: "missing",
    });
  });

  it("does not guess when multiple books exist without an active context", () => {
    expect(resolveDirectWriteTarget(undefined, [
      { id: "alpha" },
      { id: "beta" },
    ])).toEqual({
      bookId: null,
      reason: "ambiguous",
    });
  });
});

describe("detectChatActionIntent", () => {
  it("maps write-next / audit / market-radar prompts", () => {
    expect(detectChatActionIntent("写下一章")).toEqual({ type: "write-next" });
    expect(detectChatActionIntent("audit chapter 12")).toEqual({ type: "audit", chapterNumber: 12 });
    expect(detectChatActionIntent("扫描市场趋势")).toEqual({ type: "market-radar" });
  });

  it("returns audit intent without chapter when chapter is missing", () => {
    expect(detectChatActionIntent("请帮我审计一下")).toEqual({ type: "audit" });
  });
});

describe("buildChatActionApiPath", () => {
  it("builds API paths for all supported actions", () => {
    expect(buildChatActionApiPath({ type: "write-next" }, "book-1")).toBe("/books/book-1/write-next");
    expect(buildChatActionApiPath({ type: "audit", chapterNumber: 5 }, "book-1")).toBe("/books/book-1/audit/5");
    expect(buildChatActionApiPath({ type: "market-radar" }, null)).toBe("/radar/scan");
  });

  it("returns null when required API parameters are missing", () => {
    expect(buildChatActionApiPath({ type: "write-next" }, null)).toBeNull();
    expect(buildChatActionApiPath({ type: "audit" }, "book-1")).toBeNull();
  });
});

describe("resolveChatActionSseUpdate", () => {
  it("returns lifecycle feedback for start and completion events", () => {
    expect(resolveChatActionSseUpdate("audit:start", { chapter: 3 }, true)).toEqual({
      done: false,
      message: "⋯ 开始审计第3章…",
    });
    expect(resolveChatActionSseUpdate("audit:complete", { chapter: 3, passed: true }, true)).toEqual({
      done: true,
      message: "✓ 第3章审计通过",
    });
  });

  it("returns failure feedback for failed action events", () => {
    expect(resolveChatActionSseUpdate("write-next:fail", { error: "boom" }, false)).toEqual({
      done: true,
      message: "✗ boom",
    });
    expect(resolveChatActionSseUpdate("radar:error", { error: "timeout" }, false)).toEqual({
      done: true,
      message: "✗ Market radar failed: timeout",
    });
  });
});
