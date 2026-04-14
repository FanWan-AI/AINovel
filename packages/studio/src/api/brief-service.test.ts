import { describe, expect, it } from "vitest";
import {
  normalizeBriefText,
  normalizeRawInput,
  validateNormalizeBriefInput,
  PARAGRAPH_MAX_LENGTH,
  RAW_INPUT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./schemas/brief-schema";
import { normalizeBrief } from "./services/brief-service";

// ---------------------------------------------------------------------------
// normalizeBriefText — whitespace & punctuation normalization
// ---------------------------------------------------------------------------

describe("normalizeBriefText", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeBriefText("  hello  ")).toBe("hello");
  });

  it("collapses multiple spaces within a line to one", () => {
    expect(normalizeBriefText("hello   world")).toBe("hello world");
  });

  it("collapses tabs to a single space", () => {
    expect(normalizeBriefText("hello\t\tworld")).toBe("hello world");
  });

  it("normalizes CRLF line endings to LF", () => {
    expect(normalizeBriefText("line1\r\nline2")).toBe("line1\nline2");
  });

  it("normalizes CR-only line endings to LF", () => {
    expect(normalizeBriefText("line1\rline2")).toBe("line1\nline2");
  });

  it("collapses more than two consecutive blank lines to two", () => {
    const input = "para1\n\n\n\n\npara2";
    expect(normalizeBriefText(input)).toBe("para1\n\npara2");
  });

  it("converts full-width Chinese punctuation to half-width equivalents", () => {
    expect(normalizeBriefText("你好！世界？")).toBe("你好!世界?");
    expect(normalizeBriefText("时间：下午；地点：北京")).toBe("时间:下午;地点:北京");
    expect(normalizeBriefText("（括号）")).toBe("(括号)");
  });

  it("converts full-width space to regular space", () => {
    // U+3000 ideographic space
    expect(normalizeBriefText("你\u3000好")).toBe("你 好");
  });

  it("converts full-width curly quotes to straight quotes", () => {
    expect(normalizeBriefText("\u201C你好\u201D")).toBe('"你好"');
    expect(normalizeBriefText("\u2018你好\u2019")).toBe("'你好'");
  });

  it("preserves Chinese-specific punctuation unchanged", () => {
    // 。、『』「」【】《》〈〉 should remain as-is
    const preserved = "他说。然后、我们『出发』「好的」。";
    expect(normalizeBriefText(preserved)).toBe(preserved);
  });

  it("handles Chinese-English mixed text with abnormal whitespace", () => {
    const input = "这是   a mixed  text  with  English and 中文  words";
    expect(normalizeBriefText(input)).toBe("这是 a mixed text with English and 中文 words");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeBriefText("   \t  \n  ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// normalizeRawInput — per-paragraph truncation
// ---------------------------------------------------------------------------

describe("normalizeRawInput", () => {
  it("applies whitespace normalization to rawInput", () => {
    expect(normalizeRawInput("  hello！  ")).toBe("hello!");
  });

  it("truncates a paragraph exceeding PARAGRAPH_MAX_LENGTH at a sentence boundary", () => {
    // Build a paragraph just over the limit with a clear sentence boundary before the limit
    const sentence = "这是一个很长的句子。";
    const repeated = sentence.repeat(Math.ceil((PARAGRAPH_MAX_LENGTH + 100) / sentence.length));
    const result = normalizeRawInput(repeated);
    expect(result.length).toBeLessThanOrEqual(PARAGRAPH_MAX_LENGTH);
    // Should end at a sentence boundary (。 or similar)
    expect(result).toMatch(/[。!?.]\s*$/);
  });

  it("preserves a paragraph that is within PARAGRAPH_MAX_LENGTH", () => {
    const short = "这是一个简短的故事背景描述，主角是一名星际探险家。";
    expect(normalizeRawInput(short)).toBe(short);
  });

  it("handles rawInput exceeding RAW_INPUT_MAX_LENGTH by truncating total output", () => {
    const bigInput = "A".repeat(RAW_INPUT_MAX_LENGTH + 5000);
    const result = normalizeRawInput(bigInput);
    expect(result.length).toBeLessThanOrEqual(RAW_INPUT_MAX_LENGTH);
  });

  it("keeps multiple short paragraphs intact", () => {
    const input = "第一段。\n\n第二段。\n\n第三段。";
    expect(normalizeRawInput(input)).toBe("第一段。\n\n第二段。\n\n第三段。");
  });
});

// ---------------------------------------------------------------------------
// validateNormalizeBriefInput — structured field errors
// ---------------------------------------------------------------------------

describe("validateNormalizeBriefInput — structured error responses", () => {
  it("returns body error when request is not an object", () => {
    const result = validateNormalizeBriefInput("not-an-object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toMatchSnapshot();
    }
  });

  it("returns structured errors for multiple missing required fields", () => {
    const result = validateNormalizeBriefInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toMatchSnapshot();
      // Each error must have a field and message property (frontend-consumable)
      for (const err of result.errors) {
        expect(err).toHaveProperty("field");
        expect(err).toHaveProperty("message");
        expect(typeof err.field).toBe("string");
        expect(typeof err.message).toBe("string");
      }
    }
  });

  it("returns a field error when mode is invalid", () => {
    const result = validateNormalizeBriefInput({
      mode: "unknown",
      title: "测试",
      rawInput: "有效内容",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const modeError = result.errors.find((e) => e.field === "mode");
      expect(modeError).toBeDefined();
      expect(modeError).toMatchSnapshot();
    }
  });

  it("returns a title field error when title is empty after normalization", () => {
    const result = validateNormalizeBriefInput({
      mode: "simple",
      title: "   \t  ",
      rawInput: "有效内容",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const titleError = result.errors.find((e) => e.field === "title");
      expect(titleError).toBeDefined();
    }
  });

  it("returns a title field error when title exceeds max length", () => {
    const result = validateNormalizeBriefInput({
      mode: "simple",
      title: "A".repeat(TITLE_MAX_LENGTH + 1),
      rawInput: "有效内容",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const titleError = result.errors.find((e) => e.field === "title");
      expect(titleError).toBeDefined();
      expect(titleError).toMatchSnapshot();
    }
  });

  it("returns a language field error for unsupported language values", () => {
    const result = validateNormalizeBriefInput({
      mode: "simple",
      title: "测试",
      rawInput: "有效内容",
      language: "fr",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const langError = result.errors.find((e) => e.field === "language");
      expect(langError).toBeDefined();
      expect(langError).toMatchSnapshot();
    }
  });

  it("returns ok=true and normalized value for valid minimal input", () => {
    const result = validateNormalizeBriefInput({
      mode: "simple",
      title: "  星际浪人  ",
      rawInput: "一个失落的探险家踏上了找回自我的旅途。",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("星际浪人");
      expect(result.value.mode).toBe("simple");
    }
  });

  it("normalizes full-width punctuation in title and rawInput before returning", () => {
    const result = validateNormalizeBriefInput({
      mode: "pro",
      title: "星际浪人！",
      rawInput: "主角是一个孤独的战士？他的使命：拯救世界。",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("星际浪人!");
      expect(result.value.rawInput).toBe("主角是一个孤独的战士?他的使命:拯救世界。");
    }
  });

  it("normalizes abnormal whitespace in rawInput before returning", () => {
    const result = validateNormalizeBriefInput({
      mode: "simple",
      title: "测试书",
      rawInput: "  开头有多余空格   中间也有   末尾也有  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rawInput).toBe("开头有多余空格 中间也有 末尾也有");
    }
  });

  it("accepts rawInput that slightly exceeds RAW_INPUT_MAX_LENGTH by truncating it", () => {
    // Overly-long input should be silently truncated, not rejected
    const oversized = "有效内容。".repeat(3000); // well over 12000 chars
    const result = validateNormalizeBriefInput({
      mode: "simple",
      title: "测试书",
      rawInput: oversized,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rawInput.length).toBeLessThanOrEqual(RAW_INPUT_MAX_LENGTH);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeBrief — integration
// ---------------------------------------------------------------------------

describe("normalizeBrief", () => {
  it("returns a normalizedBrief with a briefId", () => {
    const result = normalizeBrief({
      mode: "simple",
      title: "星际浪人",
      rawInput: "一个失落的星际探险家踏上了找回自我的科幻冒险旅途。",
    });
    expect(result.briefId).toMatch(/^brief_/);
    expect(result.normalizedBrief.title).toBe("星际浪人");
  });

  it("extracts genres from rawInput", () => {
    const result = normalizeBrief({
      mode: "simple",
      title: "科幻冒险",
      rawInput: "这是一部科幻小说，讲述了星际旅行的故事。",
    });
    expect(result.normalizedBrief.coreGenres).toContain("科幻");
  });

  it("normalizes title punctuation in the returned brief", () => {
    const result = normalizeBrief({
      mode: "simple",
      title: "星际浪人！",
      rawInput: "这是一部科幻小说。",
    });
    expect(result.normalizedBrief.title).toBe("星际浪人!");
  });

  it("applies normalization to rawInput passed to extractors", () => {
    // rawInput with full-width punctuation should be handled correctly by extractors
    const result = normalizeBrief({
      mode: "simple",
      title: "测试",
      rawInput: "主角是张三。他面临的冲突：世界末日的危机。",
    });
    expect(result.normalizedBrief).toBeDefined();
    expect(typeof result.normalizedBrief.positioning).toBe("string");
  });
});
