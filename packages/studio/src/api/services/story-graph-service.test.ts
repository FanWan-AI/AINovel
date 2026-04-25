import { describe, expect, it } from "vitest";
import { buildStoryGraph } from "./story-graph-service";

describe("buildStoryGraph", () => {
  it("builds an evidence-backed story graph from truth files and chapters", () => {
    const graph = buildStoryGraph({
      bookId: "book-alpha",
      title: "神级红颜进化系统",
      chapters: [
        { number: 1, title: "咖啡馆初遇", status: "approved", wordCount: 3200 },
        { number: 2, title: "仓库线索", status: "draft", wordCount: 2800 },
      ],
      truthFiles: {
        "author_intent.md": "核心爽点：系统、逆袭、关系张力。",
        "story_bible.md": "主角：万凡。女主：林薇。",
        "character_matrix.md": [
          "| 人物 | 定位 | 当前关系 | 状态 |",
          "| --- | --- | --- | --- |",
          "| 万凡 | 主角 | 与林薇形成同盟 | active |",
          "| 林薇 | 女主 | 与万凡互相信任 | active |",
        ].join("\n"),
        "pending_hooks.md": [
          "| hook_id | 伏笔 | 状态 |",
          "| --- | --- | --- |",
          "| H1 | 仓库密钥的真正来源 | 待回收 |",
        ].join("\n"),
        "book_rules.md": "- 必须保持系统奖励有代价\n- 禁止系统直接奖励现金",
        "current_state.md": "当前位置：第2章仓库线索\n当前目标：确认仓库密钥来源",
        "chapter_summaries.md": "第1章 万凡在咖啡馆遇到林薇。\n第2章 万凡追查仓库密钥。",
      },
      generatedAt: "2026-04-24T00:00:00.000Z",
    });

    expect(graph.bookId).toBe("book-alpha");
    expect(graph.nodes.some((node) => node.type === "book" && node.label === "神级红颜进化系统")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "character" && node.label === "万凡")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "hook" && node.label === "仓库密钥的真正来源")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "rule" && node.label.includes("禁止系统直接奖励现金"))).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "appears_in" && edge.label === "出场")).toBe(true);
    expect(graph.nodes.every((node) => node.evidence.length > 0)).toBe(true);
  });

  it("keeps long theme evidence useful instead of clipping it into fragments", () => {
    const longWorld = Array.from({ length: 18 }, (_, index) => `第${index + 1}层信息：职场压力、家庭牵引、爽点反击继续推进。`).join("");
    const graph = buildStoryGraph({
      bookId: "book-beta",
      title: "新骆驼祥子",
      chapters: [{ number: 1, title: "入职日", status: "draft", wordCount: 3000 }],
      truthFiles: {
        "author_intent.md": `"positioning": "女频爽文", "worldSetting": "${longWorld}尾部标记-完整证据", "protagonist": "李书玥"`,
      },
      generatedAt: "2026-04-24T00:00:00.000Z",
    });

    const theme = graph.nodes.find((node) => node.type === "theme" && node.label === "爽点");

    expect(theme?.description).toContain("尾部标记-完整证据");
    expect(theme?.evidence[0]?.excerpt).toContain("尾部标记-完整证据");
  });

  it("extracts theme evidence from the complete author-intent field", () => {
    const graph = buildStoryGraph({
      bookId: "book-gamma",
      title: "新骆驼祥子",
      chapters: [{ number: 1, title: "入职日", status: "draft", wordCount: 3000 }],
      truthFiles: {
        "author_intent.md": JSON.stringify({
          positioning: "爽点密集的女频逆袭。",
          worldSetting: "底层圈层包括普通工薪家庭、邻里和烟火气，是女主的起点。",
          protagonist: "李书玥，出身北京普通工薪家庭。",
        }, null, 2),
      },
      generatedAt: "2026-04-24T00:00:00.000Z",
    });

    const theme = graph.nodes.find((node) => node.type === "theme" && node.label === "家庭");

    expect(theme?.description).toContain('"worldSetting"');
    expect(theme?.description).toContain("普通工薪家庭");
    expect(theme?.description).not.toMatch(/^庭/u);
  });
});
