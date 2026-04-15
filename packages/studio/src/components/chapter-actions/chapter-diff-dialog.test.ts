import { describe, expect, it } from "vitest";
import { buildDiffRows, buildInlineDiffSegments } from "./ChapterDiffDialog";

describe("buildDiffRows", () => {
  it("marks modified lines as change rows", () => {
    const rows = buildDiffRows(
      "第一行\n旧句子\n第三行",
      "第一行\n新句子\n第三行",
    );
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({
      kind: "change",
      beforeText: "旧句子",
      afterText: "新句子",
    });
  });

  it("keeps pure additions and removals", () => {
    const rows = buildDiffRows("A\nB", "A\nB\nC");
    expect(rows.at(-1)).toEqual({
      kind: "add",
      beforeText: null,
      afterText: "C",
    });
  });
});

describe("buildInlineDiffSegments", () => {
  it("produces add/remove segments for changed tokens", () => {
    const segments = buildInlineDiffSegments(
      "主角走进仓库",
      "主角冲进仓库",
    );
    expect(segments.before.some((segment) => segment.kind === "remove")).toBe(true);
    expect(segments.after.some((segment) => segment.kind === "add")).toBe(true);
  });
});
