import { describe, expect, it } from "vitest";
import { normalizeMarkdownEvidence, parseJsonishEvidence } from "./StoryGraphView";

describe("normalizeMarkdownEvidence", () => {
  it("restores compacted markdown tables before rendering evidence", () => {
    const compacted = "| 字段 | 值 | |------|-----| | 当前章节 | 3 | | 当前位置 | 北京国贸区域 |";

    expect(normalizeMarkdownEvidence(compacted)).toBe([
      "| 字段 | 值 |",
      "| ------ | ----- |",
      "| 当前章节 | 3 |",
      "| 当前位置 | 北京国贸区域 |",
    ].join("\n"));
  });
});

describe("parseJsonishEvidence", () => {
  it("renders author intent json-ish evidence as readable fields", () => {
    const content = [
      '前置说明文字, "positioning": "女频职场爽文，主打逆袭",',
      '"worldSetting": "核心圈层\\n1. 精英层：北京 CBD 与金融街\\n2. 中间层：普通职场",',
      '"protagonist": "李书玥，海归精英，隐忍但清醒"',
    ].join(" ");

    expect(parseJsonishEvidence(content)).toEqual([
      { label: "定位", value: "女频职场爽文，主打逆袭" },
      { label: "世界设定", value: "核心圈层\n1. 精英层：北京 CBD 与金融街\n2. 中间层：普通职场" },
      { label: "主角", value: "李书玥，海归精英，隐忍但清醒" },
    ]);
  });
});
