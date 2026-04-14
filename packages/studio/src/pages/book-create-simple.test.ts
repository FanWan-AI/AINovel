import { describe, expect, it, vi } from "vitest";
import { assembleBriefText, callNormalizeBrief } from "./BookCreateSimple";
import { postApi } from "../hooks/use-api";

// ---------------------------------------------------------------------------
// assembleBriefText — unit tests
// ---------------------------------------------------------------------------

describe("assembleBriefText", () => {
  it("returns the raw input when optional fields are all empty", () => {
    expect(assembleBriefText("我的故事", "", "", "")).toBe("我的故事");
  });

  it("returns an empty string when every input is empty", () => {
    expect(assembleBriefText("", "", "", "")).toBe("");
  });

  it("includes positioning when provided", () => {
    const result = assembleBriefText("", "都市女强人逆袭", "", "");
    expect(result).toBe("定位：都市女强人逆袭");
  });

  it("includes targetReaders when provided", () => {
    const result = assembleBriefText("", "", "18-30 岁女性", "");
    expect(result).toBe("目标读者：18-30 岁女性");
  });

  it("includes stylePreference when provided", () => {
    const result = assembleBriefText("", "", "", "轻松幽默");
    expect(result).toBe("风格：轻松幽默");
  });

  it("combines raw input and all optional fields in order", () => {
    const result = assembleBriefText("我的故事", "逆袭爽文", "年轻女性", "节奏快");
    expect(result).toBe("我的故事\n定位：逆袭爽文\n目标读者：年轻女性\n风格：节奏快");
  });

  it("trims whitespace from each field before including it", () => {
    const result = assembleBriefText("  故事  ", "  定位  ", "  读者  ", "  风格  ");
    expect(result).toBe("故事\n定位：定位\n目标读者：读者\n风格：风格");
  });

  it("skips fields that are only whitespace", () => {
    const result = assembleBriefText("故事", "   ", "读者", "   ");
    expect(result).toBe("故事\n目标读者：读者");
  });

  it("combines only optional fields when rawInput is empty", () => {
    const result = assembleBriefText("", "逆袭", "女性读者", "轻松");
    expect(result).toBe("定位：逆袭\n目标读者：女性读者\n风格：轻松");
  });
});

// ---------------------------------------------------------------------------
// callNormalizeBrief — submit payload tests
// ---------------------------------------------------------------------------

const stubBriefResponse = {
  briefId: "brief_001",
  normalizedBrief: {
    title: "测试书名",
    coreGenres: ["奇幻"],
    positioning: "逆袭成长",
    worldSetting: "架空古代王朝",
    protagonist: "寒门学子",
    mainConflict: "权贵打压 vs 主角逆袭",
    styleRules: [],
    forbiddenPatterns: [],
  },
};

describe("callNormalizeBrief", () => {
  it("calls the correct endpoint with title and rawInput", async () => {
    const mockPost = vi.fn().mockResolvedValue(stubBriefResponse);
    await callNormalizeBrief(
      { mode: "simple", title: "测试书名", rawInput: "一段故事描述" },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    expect(mockPost).toHaveBeenCalledOnce();
    const [path, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/v2/books/create/brief/normalize");
    expect(body).toMatchObject({ mode: "simple", title: "测试书名", rawInput: "一段故事描述" });
  });

  it("works with an empty rawInput (title-only submission)", async () => {
    const mockPost = vi.fn().mockResolvedValue(stubBriefResponse);
    await callNormalizeBrief(
      { mode: "simple", title: "仅书名", rawInput: "" },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({ mode: "simple", title: "仅书名", rawInput: "" });
  });

  it("returns the normalized brief response", async () => {
    const mockPost = vi.fn().mockResolvedValue(stubBriefResponse);
    const result = await callNormalizeBrief(
      { mode: "simple", title: "测试书名", rawInput: "故事" },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    expect(result.briefId).toBe("brief_001");
    expect(result.normalizedBrief.title).toBe("测试书名");
  });

  it("propagates errors thrown by the postApi implementation", async () => {
    const mockPost = vi.fn().mockRejectedValue(new Error("Network error"));
    await expect(
      callNormalizeBrief(
        { mode: "simple", title: "书名", rawInput: "" },
        { postApiImpl: mockPost as unknown as typeof postApi },
      ),
    ).rejects.toThrow("Network error");
  });
});

// ---------------------------------------------------------------------------
// Compatibility: brief assembly integrates with callNormalizeBrief payload
// ---------------------------------------------------------------------------

describe("submit payload includes assembled brief text", () => {
  it("assembles optional fields into rawInput before calling the API", async () => {
    const mockPost = vi.fn().mockResolvedValue(stubBriefResponse);
    const combined = assembleBriefText("", "逆袭爽文", "女性读者", "轻松");
    await callNormalizeBrief(
      { mode: "simple", title: "我的书", rawInput: combined },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.rawInput).toContain("定位：逆袭爽文");
    expect(body.rawInput).toContain("目标读者：女性读者");
    expect(body.rawInput).toContain("风格：轻松");
  });

  it("empty optional fields do not appear in rawInput", async () => {
    const mockPost = vi.fn().mockResolvedValue(stubBriefResponse);
    const combined = assembleBriefText("纯书名场景", "", "", "");
    await callNormalizeBrief(
      { mode: "simple", title: "我的书", rawInput: combined },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.rawInput).toBe("纯书名场景");
    expect(String(body.rawInput)).not.toContain("定位");
    expect(String(body.rawInput)).not.toContain("目标读者");
    expect(String(body.rawInput)).not.toContain("风格");
  });

  it("all fields empty: rawInput is empty string (no dirty data)", async () => {
    const mockPost = vi.fn().mockResolvedValue(stubBriefResponse);
    const combined = assembleBriefText("", "", "", "");
    await callNormalizeBrief(
      { mode: "simple", title: "我的书", rawInput: combined },
      { postApiImpl: mockPost as unknown as typeof postApi },
    );
    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.rawInput).toBe("");
  });
});
