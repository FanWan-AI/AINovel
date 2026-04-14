import { describe, expect, it } from "vitest";
import { strings } from "./use-i18n";
import type { StringKey } from "./use-i18n";

// ---------------------------------------------------------------------------
// The required i18n keys introduced or updated for this feature.
// The TypeScript compiler validates these are all valid StringKey values —
// a missing entry in strings would be a compile error here.
// ---------------------------------------------------------------------------

const REQUIRED_KEYS: StringKey[] = [
  // Primary action buttons
  "book.writeNext",
  // AI Suggestions panel
  "book.nextPlan",
  "book.generateNextPlan",
  "book.nextPlanHint",
  // Manual planning
  "book.manualPlanLabel",
  "writeNext.dialogTitle",
  // Quick write
  "writeNext.quickWrite",
  "writeNext.quickWriteTip",
  // Onboarding copy
  "book.noChapters",
];

// ---------------------------------------------------------------------------
// Key completeness — both zh and en must be present and non-empty
// ---------------------------------------------------------------------------

describe("use-i18n — key completeness (feat/copy onboarding upgrade)", () => {
  it("all required i18n keys exist in the strings map", () => {
    for (const key of REQUIRED_KEYS) {
      expect(strings[key], `key "${key}" must exist`).toBeDefined();
    }
  });

  it("all required keys have non-empty Chinese (zh) translations", () => {
    for (const key of REQUIRED_KEYS) {
      expect(strings[key]?.zh, `zh for key "${key}" must be non-empty`).toBeTruthy();
    }
  });

  it("all required keys have non-empty English (en) translations", () => {
    for (const key of REQUIRED_KEYS) {
      expect(strings[key]?.en, `en for key "${key}" must be non-empty`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance-criteria assertions: verify exact copy for key labels
// ---------------------------------------------------------------------------

describe("use-i18n — acceptance criteria copy values", () => {
  it("book.writeNext is '规划下章并写作' in Chinese", () => {
    expect(strings["book.writeNext"].zh).toBe("规划下章并写作");
  });

  it("book.writeNext is 'Plan & Write Next' in English", () => {
    expect(strings["book.writeNext"].en).toBe("Plan & Write Next");
  });

  it("writeNext.quickWrite is '快速写' in Chinese", () => {
    expect(strings["writeNext.quickWrite"].zh).toBe("快速写");
  });

  it("book.nextPlan is 'AI 生成建议' in Chinese", () => {
    expect(strings["book.nextPlan"].zh).toBe("AI 生成建议");
  });

  it("book.manualPlanLabel is '手动规划' in Chinese", () => {
    expect(strings["book.manualPlanLabel"].zh).toBe("手动规划");
  });

  it("writeNext.dialogTitle is '手动规划' in Chinese", () => {
    expect(strings["writeNext.dialogTitle"].zh).toBe("手动规划");
  });

  it("book.nextPlanHint covers all three onboarding points in Chinese", () => {
    const hint = strings["book.nextPlanHint"].zh;
    // Point 1: AI suggestions are based on written chapters
    expect(hint).toContain("AI 建议");
    expect(hint).toContain("已写的章节");
    // Point 2: Can edit manually before writing
    expect(hint).toContain("手动修改");
    // Point 3: Quick Write is fast but less controllable
    expect(hint).toContain("快速写");
    expect(hint).toContain("可控性低");
  });

  it("writeNext.quickWriteTip mentions speed and reduced control in Chinese", () => {
    const tip = strings["writeNext.quickWriteTip"].zh;
    expect(tip).toContain("速度快");
    expect(tip).toContain("可控性低");
  });
});
