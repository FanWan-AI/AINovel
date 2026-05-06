/**
 * chat-to-book-wizard-service.test.ts
 *
 * Unit tests for the Chat-to-Book wizard:
 *  - detectConfirmation
 *  - processWizardTurn (first turn, refine turn, LLM failure)
 *  - draftToConfirmRequest
 */

import { describe, it, expect, vi } from "vitest";
import {
  detectConfirmation,
  processWizardTurn,
  draftToConfirmRequest,
  type WizardTurnInput,
} from "./chat-to-book-wizard-service";
import type { BookCreationDraftPayload } from "./assistant-artifact-service";

// ── detectConfirmation ─────────────────────────────────────────────────

describe("detectConfirmation", () => {
  it.each(["确认", "确认创建", "好的", "就这样", "没问题", "ok", "OK", "yes", "确定"])
  ("returns confirm for '%s'", (text) => {
    expect(detectConfirmation(text)).toBe("confirm");
  });

  it.each(["取消", "算了", "不要了", "重来", "cancel"])
  ("returns cancel for '%s'", (text) => {
    expect(detectConfirmation(text)).toBe("cancel");
  });

  it.each(["改书名", "换个女主", "修改主角设定", "调整一下爽点"])
  ("returns refine for '%s'", (text) => {
    expect(detectConfirmation(text)).toBe("refine");
  });
});

// ── processWizardTurn ──────────────────────────────────────────────────

const BASE_SESSION = "sess-123";

function makeInput(overrides: Partial<WizardTurnInput>): WizardTurnInput {
  return {
    sessionId: BASE_SESSION,
    userText: "帮我写一本都市爽文",
    llmCall: vi.fn(),
    ...overrides,
  };
}

const FULL_DRAFT_JSON = {
  title: "我在都市当神级学霸",
  genre: "都市爽文",
  audience: "男频",
  protagonist: "普通高中生觉醒系统",
  coreConflict: "学渣逆袭打脸",
  femaleLeads: "校花、助理、偶像",
  firstVolumePlan: "觉醒系统→校内称霸→引出反派",
  styleRules: ["节奏快", "爽点密集"],
  chapterWordCount: 3000,
};

describe("processWizardTurn — first turn (no prior draft)", () => {
  it("parses fenced JSON and returns narrative text", async () => {
    const llmResponse = `根据你的需求，我给你策划了这本书：\n\`\`\`json\n${JSON.stringify(FULL_DRAFT_JSON)}\n\`\`\`\n有没有要修改的？`;
    const input = makeInput({
      llmCall: vi.fn().mockResolvedValue(llmResponse),
    });

    const result = await processWizardTurn(input);

    expect(result.updatedDraft.title).toBe("我在都市当神级学霸");
    expect(result.updatedDraft.genre).toBe("都市爽文");
    expect(result.updatedDraft.styleRules).toEqual(["节奏快", "爽点密集"]);
    expect(result.updatedDraft.chapterWordCount).toBe(3000);
    expect(result.readyToConfirm).toBe(true);
    expect(result.responseText).toContain("修改");
  });

  it("parses bare JSON object when no fenced block is present", async () => {
    const llmResponse = `好的！${JSON.stringify(FULL_DRAFT_JSON)} 这是我的策划方案。`;
    const input = makeInput({
      llmCall: vi.fn().mockResolvedValue(llmResponse),
    });

    const result = await processWizardTurn(input);
    expect(result.updatedDraft.title).toBe("我在都市当神级学霸");
    expect(result.readyToConfirm).toBe(true);
  });

  it("returns fallback draft with no-confirm when LLM returns no JSON", async () => {
    const input = makeInput({
      llmCall: vi.fn().mockResolvedValue("暂时没有思路，请换一个描述方式。"),
    });

    const result = await processWizardTurn(input);
    expect(result.readyToConfirm).toBe(false);
    expect(result.updatedDraft.stage).toBe("gathering");
    expect(result.responseText.length).toBeGreaterThan(0);
  });

  it("returns graceful fallback when LLM throws", async () => {
    const input = makeInput({
      llmCall: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const result = await processWizardTurn(input);
    expect(result.readyToConfirm).toBe(false);
    expect(result.responseText).toContain("network error");
  });
});

describe("processWizardTurn — refine turn (with prior draft)", () => {
  const previousDraft: BookCreationDraftPayload = {
    stage: "draft_ready",
    title: "我在都市当神级学霸",
    genre: "都市爽文",
    audience: "男频",
    protagonist: "普通高中生觉醒系统",
    coreConflict: "学渣逆袭打脸",
    userRefinements: [],
  };

  it("applies refinement and records it in userRefinements", async () => {
    const revisedJson = { ...FULL_DRAFT_JSON, title: "我的名字叫无敌" };
    const llmResponse = `好的，书名已改为《我的名字叫无敌》。\n\`\`\`json\n${JSON.stringify(revisedJson)}\n\`\`\`\n还有什么要改的吗？`;
    const input = makeInput({
      userText: "改书名为：我的名字叫无敌",
      previousDraft,
      llmCall: vi.fn().mockResolvedValue(llmResponse),
    });

    const result = await processWizardTurn(input);
    expect(result.updatedDraft.title).toBe("我的名字叫无敌");
    expect(result.updatedDraft.userRefinements).toContain("改书名为：我的名字叫无敌");
    expect(result.readyToConfirm).toBe(true);
  });

  it("preserves optional fields from previousDraft when LLM omits them", async () => {
    const minimalJson = {
      title: "新书名",
      genre: "都市",
      audience: "男频",
      protagonist: "主角",
      coreConflict: "爽点",
    };
    const draftWithOptionals: BookCreationDraftPayload = {
      ...previousDraft,
      chapterWordCount: 2500,
      styleRules: ["慢热"],
    };
    const llmResponse = `\`\`\`json\n${JSON.stringify(minimalJson)}\n\`\`\``;
    const input = makeInput({
      userText: "改书名",
      previousDraft: draftWithOptionals,
      llmCall: vi.fn().mockResolvedValue(llmResponse),
    });

    const result = await processWizardTurn(input);
    expect(result.updatedDraft.chapterWordCount).toBe(2500);
    expect(result.updatedDraft.styleRules).toEqual(["慢热"]);
  });
});

// ── draftToConfirmRequest ──────────────────────────────────────────────

describe("draftToConfirmRequest", () => {
  const draft: BookCreationDraftPayload = {
    stage: "confirmed",
    title: "我在都市当神级学霸",
    genre: "都市爽文",
    audience: "男频",
    protagonist: "普通高中生觉醒系统",
    coreConflict: "学渣逆袭打脸",
    firstVolumePlan: "第一卷：觉醒",
    chapterWordCount: 3000,
    userRefinements: [],
  };

  it("maps title and genre to bookConfig", () => {
    const req = draftToConfirmRequest(draft);
    expect(req.bookConfig.title).toBe("我在都市当神级学霸");
    expect(req.bookConfig.genre).toBe("都市爽文");
  });

  it("maps chapterWordCount to bookConfig", () => {
    const req = draftToConfirmRequest(draft);
    expect(req.bookConfig.chapterWordCount).toBe(3000);
  });

  it("includes brief with protagonist and mainConflict", () => {
    const req = draftToConfirmRequest(draft);
    expect(req.brief.protagonist).toBe("普通高中生觉醒系统");
    expect(req.brief.mainConflict).toBe("学渣逆袭打脸");
  });

  it("defaults chapterWordCount to 3000 when not specified", () => {
    const draftNoWc = { ...draft, chapterWordCount: undefined };
    const req = draftToConfirmRequest(draftNoWc);
    expect(req.bookConfig.chapterWordCount).toBe(3000);
  });
});
