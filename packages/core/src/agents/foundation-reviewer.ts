import { BaseAgent } from "./base.js";
import type { ArchitectOutput } from "./architect.js";

export interface FoundationReviewResult {
  readonly passed: boolean;
  readonly totalScore: number;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly feedback: string;
  }>;
  readonly overallFeedback: string;
}

const PASS_THRESHOLD = 80;
const DIMENSION_FLOOR = 60;

export class FoundationReviewerAgent extends BaseAgent {
  get name(): string {
    return "foundation-reviewer";
  }

  async review(params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly platform?: string;
  }): Promise<FoundationReviewResult> {
    const isAdult = params.platform === "adult";
    const canonBlock = params.sourceCanon
      ? `\n## 原作正典参照\n${params.sourceCanon.slice(0, 8000)}\n`
      : "";
    const styleBlock = params.styleGuide
      ? `\n## 原作风格参照\n${params.styleGuide.slice(0, 2000)}\n`
      : "";

    const dimensions = isAdult
      ? this.adultDimensions(params.language)
      : params.mode === "original"
        ? this.originalDimensions(params.language)
        : this.derivativeDimensions(params.language, params.mode);

    const systemPrompt = isAdult
      ? (params.language === "en"
        ? this.buildAdultEnglishReviewPrompt(dimensions)
        : this.buildAdultChineseReviewPrompt(dimensions))
      : params.language === "en"
        ? this.buildEnglishReviewPrompt(dimensions, canonBlock, styleBlock)
        : this.buildChineseReviewPrompt(dimensions, canonBlock, styleBlock);

    const userPrompt = this.buildFoundationExcerpt(params.foundation, params.language);

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { maxTokens: 4096, temperature: 0.3 });

    return this.parseReviewResult(response.content, dimensions);
  }

  private adultDimensions(language: "zh" | "en"): ReadonlyArray<string> {
    return language === "en"
      ? [
          "Core Arousal Hook (Does the protagonist's ability/setting give a logical, escalating reason for erotic encounters throughout 40+ chapters?)",
          "Opening Hook (Can the first 3 chapters establish the protagonist's unique power AND create immediate tension with the first female lead?)",
          "World Coherence (Does the worldbuilding internally support the erotic premise — power systems, social hierarchy, taboo dynamics?)",
          "Female Lead Distinctiveness (Do the female leads have distinct body types, personalities, identity taboos, and psychological resistance arcs — not interchangeable?)",
          "Taboo Escalation Route (Does each volume introduce a qualitatively MORE forbidden taboo type than the last — identity rank, power level, scene setting?)",
        ]
      : [
          "核心爽点驱动（主角能力/世界观是否给了40章以上的情欲场景一个自洽且持续升级的存在理由？）",
          "开篇钩子（前3章能否快速建立主角的独特能力、生死危机，并和第一个女主制造张力？）",
          "世界一致性（世界观是否真正支撑情欲前提——权力体系、社会等级、禁忌逻辑是否自洽？）",
          "女主差异化（各女主的身份禁忌、外貌特征、性格底色、心理防线类型是否各不相同，不可互换？）",
          "禁忌升级路线（从第一卷到最后一卷，每卷的核心禁忌类型是否比上一卷更高阶、更禁忌、更有冲击力？）",
        ];
  }

  private buildAdultChineseReviewPrompt(dimensions: ReadonlyArray<string>): string {
    return `你是一位专业的成人向男频小说（H小说）策划编辑，正在审核一本成人向新书的基础设定。

【重要背景】这是一本成人向/H小说，以情欲征服为核心卖点，多女主后宫结构是标准配置，连续多章攻略同一女主是正常节奏，不是缺陷。你的评审标准必须基于成人向读者的实际期待，而非主流文学标准。

你需要从以下维度逐项打分（0-100），并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 评分标准
- 80+ 通过，可以开始写作
- 60-79 有明显问题，需要修改
- <60 方向性错误，需要重新设计

## 成人向评审原则（必须遵守）
- 不要以"连续N章同类节拍"为由扣分——H小说读者期待持续的情欲张力，这是类型特点不是缺陷
- 不要要求加入"非情欲类主线节拍"——情欲场景本身就是主线，权力斗争是调味品而非主菜
- 重点检查：每个女主的身份禁忌是否够独特，攻略路径的心理层次是否丰富，禁忌是否卷卷升级
- 不要以主流文学的道德标准或人物成长弧线标准评判H小说

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
分数：{0-100}
意见：{具体反馈}

=== DIMENSION: 2 ===
分数：{0-100}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
总分：{加权平均}
通过：{是/否}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}

审核时要准确。80分意味着"成人向读者会持续追更，不会觉得女主重复、禁忌无聊"。`;
  }

  private buildAdultEnglishReviewPrompt(dimensions: ReadonlyArray<string>): string {
    return `You are a professional adult fiction (eroge/harem) editor reviewing a new book's foundation.

[IMPORTANT] This is an adult/harem novel where erotic conquest is the PRIMARY value proposition. Multi-chapter pursuit of a single female lead is NORMAL pacing, not a flaw. Evaluate by adult reader expectations, NOT mainstream literary standards.

Score each dimension (0-100):

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Scoring
- 80+ Pass — ready to write
- 60-79 Needs revision
- <60 Fundamental problem

## Adult Review Principles
- Do NOT penalize "same beat for N chapters" — sustained erotic tension is the genre's core feature
- Do NOT demand non-erotic main plot beats — erotic scenes ARE the main plot
- Focus on: distinctiveness of taboo types, depth of psychological resistance arcs, whether each volume escalates the forbidden threshold

## Output format (strict)
=== DIMENSION: 1 ===
Score: {0-100}
Feedback: {specific feedback}

...

=== OVERALL ===
Total: {weighted average}
Passed: {yes/no}
Summary: {1-2 paragraphs}`;
  }

  private originalDimensions(language: "zh" | "en"): ReadonlyArray<string> {
    return language === "en"
      ? [
          "Core Conflict (Is there a clear, compelling central conflict that can sustain 40 chapters?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook?)",
          "World Coherence (Is the worldbuilding internally consistent and specific?)",
          "Character Differentiation (Are the main characters distinct in voice and motivation?)",
          "Pacing Feasibility (Does the volume outline have enough variety — not the same beat for 10 chapters?)",
        ]
      : [
          "核心冲突（是否有清晰且有足够张力的核心冲突支撑40章？）",
          "开篇节奏（前5章能否形成翻页驱动力？）",
          "世界一致性（世界观是否内洽且具体？）",
          "角色区分度（主要角色的声音和动机是否各不相同？）",
          "节奏可行性（卷纲是否有足够变化——不会连续10章同一种节拍？）",
        ];
  }

  private derivativeDimensions(language: "zh" | "en", mode: "fanfic" | "series"): ReadonlyArray<string> {
    const modeLabel = mode === "fanfic"
      ? (language === "en" ? "Fan Fiction" : "同人")
      : (language === "en" ? "Series" : "系列");

    return language === "en"
      ? [
          `Source DNA Preservation (Does the ${modeLabel} respect the original's world rules, character personalities, and established facts?)`,
          `New Narrative Space (Is there a clear divergence point or new territory that gives the story room to be ORIGINAL, not a retelling?)`,
          "Core Conflict (Is the new story's central conflict compelling and distinct from the original?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook without requiring 3 chapters of setup?)",
          `Pacing Feasibility (Does the outline avoid the trap of re-walking the original's plot beats?)`,
        ]
      : [
          `原作DNA保留（${modeLabel}是否尊重原作的世界规则、角色性格、已确立事实？）`,
          `新叙事空间（是否有明确的分岔点或新领域，让故事有原创空间，而非复述原作？）`,
          "核心冲突（新故事的核心冲突是否有足够张力且区别于原作？）",
          "开篇节奏（前5章能否形成翻页驱动力，不需要3章铺垫？）",
          `节奏可行性（卷纲是否避免了重走原作剧情节拍的陷阱？）`,
        ];
  }

  private buildChineseReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `你是一位资深小说编辑，正在审核一本新书的基础设定（世界观 + 大纲 + 规则）。

你需要从以下维度逐项打分（0-100），并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 评分标准
- 80+ 通过，可以开始写作
- 60-79 有明显问题，需要修改
- <60 方向性错误，需要重新设计

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
分数：{0-100}
意见：{具体反馈}

=== DIMENSION: 2 ===
分数：{0-100}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
总分：{加权平均}
通过：{是/否}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}
${canonBlock}${styleBlock}

审核时要严格。不要因为"还行"就给高分。80分意味着"可以直接开写，不需要改"。`;
  }

  private buildEnglishReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).

Score each dimension (0-100) with specific feedback:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Scoring
- 80+ Pass — ready to write
- 60-79 Needs revision
- <60 Fundamental direction problem

## Output format (strict)
=== DIMENSION: 1 ===
Score: {0-100}
Feedback: {specific feedback}

=== DIMENSION: 2 ===
Score: {0-100}
Feedback: {specific feedback}

...

=== OVERALL ===
Total: {weighted average}
Passed: {yes/no}
Summary: {1-2 paragraphs — biggest problem and best quality}
${canonBlock}${styleBlock}

Be strict. 80 means "ready to write without changes."`;
  }

  private buildFoundationExcerpt(foundation: ArchitectOutput, language: "zh" | "en"): string {
    return language === "en"
      ? `## Story Bible\n${foundation.storyBible.slice(0, 3000)}\n\n## Volume Outline\n${foundation.volumeOutline.slice(0, 3000)}\n\n## Book Rules\n${foundation.bookRules.slice(0, 1500)}\n\n## Initial State\n${foundation.currentState.slice(0, 1000)}\n\n## Initial Hooks\n${foundation.pendingHooks.slice(0, 1000)}`
      : `## 世界设定\n${foundation.storyBible.slice(0, 3000)}\n\n## 卷纲\n${foundation.volumeOutline.slice(0, 3000)}\n\n## 规则\n${foundation.bookRules.slice(0, 1500)}\n\n## 初始状态\n${foundation.currentState.slice(0, 1000)}\n\n## 初始伏笔\n${foundation.pendingHooks.slice(0, 1000)}`;
  }

  private parseReviewResult(
    content: string,
    dimensions: ReadonlyArray<string>,
  ): FoundationReviewResult {
    const parsedDimensions: Array<{ readonly name: string; readonly score: number; readonly feedback: string }> = [];

    for (let i = 0; i < dimensions.length; i++) {
      const regex = new RegExp(
        `=== DIMENSION: ${i + 1} ===\\s*[\\s\\S]*?(?:分数|Score)[：:]\\s*(\\d+)[\\s\\S]*?(?:意见|Feedback)[：:]\\s*([\\s\\S]*?)(?==== |$)`,
      );
      const match = content.match(regex);
      parsedDimensions.push({
        name: dimensions[i]!,
        score: match ? parseInt(match[1]!, 10) : 50,
        feedback: match ? match[2]!.trim() : "(parse failed)",
      });
    }

    const totalScore = parsedDimensions.length > 0
      ? Math.round(parsedDimensions.reduce((sum, d) => sum + d.score, 0) / parsedDimensions.length)
      : 0;
    const anyBelowFloor = parsedDimensions.some((d) => d.score < DIMENSION_FLOOR);
    const passed = totalScore >= PASS_THRESHOLD && !anyBelowFloor;

    const overallMatch = content.match(
      /=== OVERALL ===[\s\S]*?(?:总评|Summary)[：:]\s*([\s\S]*?)$/,
    );
    const overallFeedback = overallMatch ? overallMatch[1]!.trim() : "(parse failed)";

    return { passed, totalScore, dimensions: parsedDimensions, overallFeedback };
  }
}
