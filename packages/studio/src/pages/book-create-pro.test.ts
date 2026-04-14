import { describe, expect, it } from "vitest";
import {
  assembleBrief,
  validateStep,
  INITIAL_PRO_FORM,
} from "./BookCreatePro";
import type { ProFormState } from "./BookCreatePro";
import { validateBlueprint } from "../components/create/ProStepBlueprint";
import { validateWorld } from "../components/create/ProStepWorld";
import { validatePlot } from "../components/create/ProStepPlot";

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

const FULL_FORM: ProFormState = {
  blueprint: {
    title: "星际浪人",
    coreGenres: "科幻, 冒险",
    positioning: "一个失落星际探险家的救赎之旅",
    targetAudience: "18-35 岁男性读者",
    platformIntent: "起点中文网",
  },
  world: {
    worldSetting: "22 世纪的银河系，超光速旅行普及，人类与外星文明共存",
    protagonist: "林尘，前星际领航员，因事故失去飞船与伙伴，誓要找回真相",
  },
  plot: {
    mainConflict: "宇宙禁区里潜藏的秘密 vs 星际执法联盟的追杀",
    endingDirection: "开放式结局",
    styleRules: "节奏紧凑, 对话驱动",
    forbiddenPatterns: "主角无敌, 过长内心独白",
  },
};

// ---------------------------------------------------------------------------
// validateBlueprint
// ---------------------------------------------------------------------------

describe("validateBlueprint", () => {
  it("returns null when title and positioning are both present", () => {
    expect(validateBlueprint(FULL_FORM.blueprint)).toBeNull();
  });

  it("returns error key when title is empty", () => {
    expect(validateBlueprint({ ...FULL_FORM.blueprint, title: "" })).toBe("pro.step1.titleRequired");
  });

  it("returns error key when title is only whitespace", () => {
    expect(validateBlueprint({ ...FULL_FORM.blueprint, title: "   " })).toBe("pro.step1.titleRequired");
  });

  it("returns error key when positioning is empty", () => {
    expect(validateBlueprint({ ...FULL_FORM.blueprint, positioning: "" })).toBe("pro.step1.positioningRequired");
  });

  it("title is validated before positioning", () => {
    expect(validateBlueprint({ ...FULL_FORM.blueprint, title: "", positioning: "" })).toBe("pro.step1.titleRequired");
  });
});

// ---------------------------------------------------------------------------
// validateWorld
// ---------------------------------------------------------------------------

describe("validateWorld", () => {
  it("returns null when worldSetting and protagonist are present", () => {
    expect(validateWorld(FULL_FORM.world)).toBeNull();
  });

  it("returns error key when worldSetting is empty", () => {
    expect(validateWorld({ ...FULL_FORM.world, worldSetting: "" })).toBe("pro.step2.worldRequired");
  });

  it("returns error key when protagonist is empty", () => {
    expect(validateWorld({ ...FULL_FORM.world, protagonist: "" })).toBe("pro.step2.protagonistRequired");
  });
});

// ---------------------------------------------------------------------------
// validatePlot
// ---------------------------------------------------------------------------

describe("validatePlot", () => {
  it("returns null when mainConflict is present", () => {
    expect(validatePlot(FULL_FORM.plot)).toBeNull();
  });

  it("returns error key when mainConflict is empty", () => {
    expect(validatePlot({ ...FULL_FORM.plot, mainConflict: "" })).toBe("pro.step3.conflictRequired");
  });

  it("accepts missing optional fields", () => {
    expect(validatePlot({ ...FULL_FORM.plot, endingDirection: "", styleRules: "", forbiddenPatterns: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateStep
// ---------------------------------------------------------------------------

describe("validateStep", () => {
  it("validates step 0 against blueprint fields", () => {
    expect(validateStep(0, { ...FULL_FORM, blueprint: { ...FULL_FORM.blueprint, title: "" } })).toBe("pro.step1.titleRequired");
    expect(validateStep(0, FULL_FORM)).toBeNull();
  });

  it("validates step 1 against world fields", () => {
    expect(validateStep(1, { ...FULL_FORM, world: { ...FULL_FORM.world, worldSetting: "" } })).toBe("pro.step2.worldRequired");
    expect(validateStep(1, FULL_FORM)).toBeNull();
  });

  it("validates step 2 against plot fields", () => {
    expect(validateStep(2, { ...FULL_FORM, plot: { ...FULL_FORM.plot, mainConflict: "" } })).toBe("pro.step3.conflictRequired");
    expect(validateStep(2, FULL_FORM)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assembleBrief
// ---------------------------------------------------------------------------

describe("assembleBrief", () => {
  it("assembles a complete CreativeBrief from full form state", () => {
    const brief = assembleBrief(FULL_FORM);
    expect(brief.title).toBe("星际浪人");
    expect(brief.positioning).toBe("一个失落星际探险家的救赎之旅");
    expect(brief.worldSetting).toBe("22 世纪的银河系，超光速旅行普及，人类与外星文明共存");
    expect(brief.protagonist).toBe("林尘，前星际领航员，因事故失去飞船与伙伴，誓要找回真相");
    expect(brief.mainConflict).toBe("宇宙禁区里潜藏的秘密 vs 星际执法联盟的追杀");
    expect(brief.endingDirection).toBe("开放式结局");
  });

  it("splits comma-separated genres into an array", () => {
    const brief = assembleBrief(FULL_FORM);
    expect(brief.coreGenres).toEqual(["科幻", "冒险"]);
  });

  it("splits comma-separated style rules into an array", () => {
    const brief = assembleBrief(FULL_FORM);
    expect(brief.styleRules).toEqual(["节奏紧凑", "对话驱动"]);
  });

  it("splits comma-separated forbidden patterns into an array", () => {
    const brief = assembleBrief(FULL_FORM);
    expect(brief.forbiddenPatterns).toEqual(["主角无敌", "过长内心独白"]);
  });

  it("sets optional fields to undefined when blank", () => {
    const form: ProFormState = {
      ...FULL_FORM,
      blueprint: { ...FULL_FORM.blueprint, targetAudience: "", platformIntent: "" },
      plot: { ...FULL_FORM.plot, endingDirection: "" },
    };
    const brief = assembleBrief(form);
    expect(brief.targetAudience).toBeUndefined();
    expect(brief.platformIntent).toBeUndefined();
    expect(brief.endingDirection).toBeUndefined();
  });

  it("returns empty arrays when genre/style/forbidden fields are blank", () => {
    const form: ProFormState = {
      ...FULL_FORM,
      blueprint: { ...FULL_FORM.blueprint, coreGenres: "" },
      plot: { ...FULL_FORM.plot, styleRules: "", forbiddenPatterns: "" },
    };
    const brief = assembleBrief(form);
    expect(brief.coreGenres).toEqual([]);
    expect(brief.styleRules).toEqual([]);
    expect(brief.forbiddenPatterns).toEqual([]);
  });

  it("trims whitespace from all text fields", () => {
    const form: ProFormState = {
      ...FULL_FORM,
      blueprint: { ...FULL_FORM.blueprint, title: "  星际浪人  " },
    };
    expect(assembleBrief(form).title).toBe("星际浪人");
  });

  it("initial empty form produces an empty brief with correct shape", () => {
    const brief = assembleBrief(INITIAL_PRO_FORM);
    expect(brief.title).toBe("");
    expect(brief.coreGenres).toEqual([]);
    expect(brief.styleRules).toEqual([]);
    expect(brief.forbiddenPatterns).toEqual([]);
    expect(brief.targetAudience).toBeUndefined();
    expect(brief.endingDirection).toBeUndefined();
  });
});
