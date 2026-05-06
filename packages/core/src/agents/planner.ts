import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import { parseBookRules } from "../models/book-rules.js";
import {
  ChapterBlueprintSchema,
  ChapterIntentSchema,
  ChapterSteeringContractSchema,
  type ChapterBlueprint,
  type ChapterConflict,
  type ChapterIntent,
  type ChapterSteeringContract,
} from "../models/input-governance.js";
import {
  parseChapterSummariesMarkdown,
  renderHookSnapshot,
  renderSummarySnapshot,
  retrieveMemorySelection,
} from "../utils/memory-retrieval.js";
import { analyzeChapterCadence } from "../utils/chapter-cadence.js";
import { buildPlannerHookAgenda } from "../utils/hook-agenda.js";

export interface PlanChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
  readonly confirmedChapterBlueprint?: ChapterBlueprint;
}

export interface PlanChapterOutput {
  readonly intent: ChapterIntent;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
}

export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planChapter(input: PlanChapterInput): Promise<PlanChapterOutput> {
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const sourcePaths = {
      authorIntent: join(storyDir, "author_intent.md"),
      currentFocus: join(storyDir, "current_focus.md"),
      storyBible: join(storyDir, "story_bible.md"),
      volumeOutline: join(storyDir, "volume_outline.md"),
      chapterSummaries: join(storyDir, "chapter_summaries.md"),
      bookRules: join(storyDir, "book_rules.md"),
      currentState: join(storyDir, "current_state.md"),
    } as const;

    const [
      authorIntent,
      currentFocus,
      storyBible,
      volumeOutline,
      chapterSummaries,
      bookRulesRaw,
      currentState,
    ] = await Promise.all([
      this.readFileOrDefault(sourcePaths.authorIntent),
      this.readFileOrDefault(sourcePaths.currentFocus),
      this.readFileOrDefault(sourcePaths.storyBible),
      this.readFileOrDefault(sourcePaths.volumeOutline),
      this.readFileOrDefault(sourcePaths.chapterSummaries),
      this.readFileOrDefault(sourcePaths.bookRules),
      this.readFileOrDefault(sourcePaths.currentState),
    ]);

    const outlineNode = this.findOutlineNode(volumeOutline, input.chapterNumber);
    const matchedOutlineAnchor = this.hasMatchedOutlineAnchor(volumeOutline, input.chapterNumber);
    const steeringContract = this.parseExternalSteeringContract(input.externalContext);
    const confirmedBlueprint = input.confirmedChapterBlueprint
      ?? this.parseExternalConfirmedBlueprint(input.externalContext);
    const goal = steeringContract?.goal
      ?? confirmedBlueprint?.openingHook
      ?? this.deriveGoal(input.externalContext, currentFocus, authorIntent, outlineNode, input.chapterNumber);
    const parsedRules = parseBookRules(bookRulesRaw);
    const mustKeep = this.unique([
      ...this.collectMustKeep(currentState, storyBible),
      ...(steeringContract?.mustInclude ?? []),
    ]).slice(0, 10);
    const mustAvoid = this.unique([
      ...this.collectMustAvoid(currentFocus, parsedRules.rules.prohibitions),
      ...(steeringContract?.mustAvoid ?? []),
    ]).slice(0, 12);
    const styleEmphasis = this.collectStyleEmphasis(authorIntent, currentFocus);
    const conflicts = this.collectConflicts(input.externalContext, currentFocus, outlineNode, volumeOutline);
    const planningAnchor = conflicts.length > 0 ? undefined : outlineNode;
    const memorySelection = await retrieveMemorySelection({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      goal,
      outlineNode: planningAnchor,
      mustKeep,
    });
    const activeHookCount = memorySelection.activeHooks.filter(
      (hook) => hook.status !== "resolved" && hook.status !== "deferred",
    ).length;
    const hookAgenda = buildPlannerHookAgenda({
      hooks: memorySelection.activeHooks,
      chapterNumber: input.chapterNumber,
      targetChapters: input.book.targetChapters,
      language: input.book.language ?? "zh",
    });
    const directives = this.buildStructuredDirectives({
      chapterNumber: input.chapterNumber,
      language: input.book.language,
      volumeOutline,
      outlineNode,
      matchedOutlineAnchor,
      chapterSummaries,
    });

    const blueprint = confirmedBlueprint ?? this.buildChapterBlueprint({
      language: input.book.language ?? "zh",
      goal,
      outlineNode,
      steeringContract,
      sceneDirective: directives.sceneDirective,
      hookAgendaSummary: hookAgenda.mustAdvance.length > 0
        ? hookAgenda.mustAdvance.join(", ")
        : undefined,
      platform: input.book.platform,
      chapterNumber: input.chapterNumber,
    });

    const intent = ChapterIntentSchema.parse({
      chapter: input.chapterNumber,
      goal,
      outlineNode,
      ...directives,
      mustKeep,
      mustAvoid,
      styleEmphasis,
      ...(steeringContract ? { steeringContract } : {}),
      blueprint,
      userContractPriority: confirmedBlueprint ? "hard" : (steeringContract?.priority ?? "normal"),
      conflicts,
      hookAgenda,
    });

    const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
    const intentMarkdown = this.renderIntentMarkdown(
      intent,
      input.book.language ?? "zh",
      renderHookSnapshot(memorySelection.hooks, input.book.language ?? "zh"),
      renderSummarySnapshot(memorySelection.summaries, input.book.language ?? "zh"),
      activeHookCount,
    );
    await writeFile(runtimePath, intentMarkdown, "utf-8");

    return {
      intent,
      intentMarkdown,
      plannerInputs: [
        ...Object.values(sourcePaths),
        join(storyDir, "pending_hooks.md"),
        ...(memorySelection.dbPath ? [memorySelection.dbPath] : []),
      ],
      runtimePath,
    };
  }

  private buildStructuredDirectives(input: {
    readonly chapterNumber: number;
    readonly language?: string;
    readonly volumeOutline: string;
    readonly outlineNode: string | undefined;
    readonly matchedOutlineAnchor: boolean;
    readonly chapterSummaries: string;
  }): Pick<ChapterIntent, "sceneDirective" | "arcDirective" | "moodDirective" | "titleDirective"> {
    const recentSummaries = parseChapterSummariesMarkdown(input.chapterSummaries)
      .filter((summary) => summary.chapter < input.chapterNumber)
      .sort((left, right) => left.chapter - right.chapter)
      .slice(-4);
    const cadence = analyzeChapterCadence({
      language: this.isChineseLanguage(input.language) ? "zh" : "en",
      rows: recentSummaries.map((summary) => ({
        chapter: summary.chapter,
        title: summary.title,
        mood: summary.mood,
        chapterType: summary.chapterType,
      })),
    });

    return {
      arcDirective: this.buildArcDirective(
        input.language,
        input.volumeOutline,
        input.outlineNode,
        input.matchedOutlineAnchor,
      ),
      sceneDirective: this.buildSceneDirective(input.language, cadence),
      moodDirective: this.buildMoodDirective(input.language, cadence),
      titleDirective: this.buildTitleDirective(input.language, cadence),
    };
  }

  private deriveGoal(
    externalContext: string | undefined,
    currentFocus: string,
    authorIntent: string,
    outlineNode: string | undefined,
    chapterNumber: number,
  ): string {
    const first = this.extractFirstDirective(externalContext);
    if (first) return first;
    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (localOverride) return localOverride;
    const outline = this.extractFirstDirective(outlineNode);
    if (outline) return outline;
    const focus = this.extractFocusGoal(currentFocus);
    if (focus) return focus;
    const author = this.extractFirstDirective(authorIntent);
    if (author) return author;
    return `Advance chapter ${chapterNumber} with clear narrative focus.`;
  }

  private stripMetaCommand(text: string): string {
    const stripped = text
      .replace(/^(?:请\s*)?(?:写|续写|继续写)(?:下一章|第.{0,4}章|一章|章节)?[，,。\s：:]+/u, "")
      .trim();
    return stripped.length > 0 ? stripped : text.trim();
  }

  private extractImplicitRequirements(text: string): string[] {
    const items: string[] = [];
    // Match clauses containing 必须/一定要: capture up to ~20 chars around the marker
    const re = /([^，。；,.！!?？\n]{0,10}(?:必须(?:要)?|一定要)[^，。；,.！!?？\n]{0,15})/gu;
    let match;
    while ((match = re.exec(text)) !== null) {
      const clause = match[1].replace(/^[，。；,.\s]+|[，。；,.\s]+$/gu, "").trim();
      if (clause.length > 2 && !items.includes(clause)) items.push(clause);
    }
    return items.slice(0, 5);
  }

  private extractImplicitAvoidances(text: string): string[] {
    const items: string[] = [];
    const re = /(?:不要|不能|别(?![人说的])|避免)([^，。；,.！!?？\n]{2,15})/gu;
    let match;
    while ((match = re.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length > 1 && !items.includes(item)) items.push(item);
    }
    return items.slice(0, 5);
  }

  private parseExternalSteeringContract(externalContext?: string): ChapterSteeringContract | undefined {
    if (!externalContext || externalContext.trim().length === 0) return undefined;

    const rawGoal = this.extractSectionFirstDirective(externalContext, [
      "chapter goal",
      "goal",
      "本章目标",
      "章节目标",
      "author brief",
      "brief",
      "创作简述",
      "用户建议",
    ]) ?? this.extractFirstDirective(externalContext);
    const goal = rawGoal ? this.stripMetaCommand(rawGoal) : undefined;

    const sectionMustInclude = this.extractSectionList(externalContext, [
      "must include",
      "include",
      "必须包含",
      "必须出现",
      "一定要写",
    ]);
    const mustInclude = sectionMustInclude.length > 0
      ? sectionMustInclude
      : this.extractImplicitRequirements(externalContext);

    const sectionMustAvoid = this.extractSectionList(externalContext, [
      "must avoid",
      "avoid",
      "避免元素",
      "避免",
      "不要写",
    ]);
    const mustAvoid = sectionMustAvoid.length > 0
      ? sectionMustAvoid
      : this.extractImplicitAvoidances(externalContext);
    const sceneBeats = this.extractSectionList(externalContext, [
      "scene beats",
      "beats",
      "场景节拍",
      "剧情节拍",
      "场景安排",
    ]);
    const payoffRequired = this.extractSectionFirstDirective(externalContext, [
      "payoff required",
      "payoff",
      "爽点",
      "回报",
      "兑现",
    ]);
    const endingHook = this.extractSectionFirstDirective(externalContext, [
      "ending hook",
      "hook",
      "章尾钩子",
      "结尾钩子",
      "悬念",
    ]);
    const priorityText = this.extractSectionFirstDirective(externalContext, [
      "priority",
      "优先级",
    ]);
    const priority = /hard|必须|强制|硬约束/i.test(priorityText ?? externalContext)
      ? "hard"
      : /soft|参考|可选/i.test(priorityText ?? "")
        ? "soft"
        : "normal";

    return ChapterSteeringContractSchema.parse({
      ...(goal ? { goal } : {}),
      mustInclude,
      mustAvoid,
      sceneBeats,
      ...(payoffRequired ? { payoffRequired } : {}),
      ...(endingHook ? { endingHook } : {}),
      priority,
      rawRequest: externalContext.trim(),
    });
  }

  private parseExternalConfirmedBlueprint(externalContext?: string): ChapterBlueprint | undefined {
    if (!externalContext || externalContext.trim().length === 0) return undefined;

    const jsonSection = this.extractSection(externalContext, [
      "structured blueprint json",
      "chapter blueprint json",
      "confirmed blueprint json",
      "结构化蓝图 json",
    ]);
    const jsonCandidate = jsonSection ? this.extractJsonObject(jsonSection) : undefined;
    if (jsonCandidate) {
      try {
        const raw = JSON.parse(jsonCandidate);
        const parsed = ChapterBlueprintSchema.safeParse(raw);
        if (parsed.success && parsed.data.status === "confirmed") {
          return parsed.data;
        }
      } catch {
        // Fall back to markdown parsing below.
      }
    }

    const blueprintSection = this.extractSection(externalContext, ["chapter blueprint", "章节蓝图"]);
    if (!blueprintSection || !/status:\s*confirmed|状态[:：]\s*confirmed/i.test(blueprintSection)) {
      return undefined;
    }

    const openingHook = this.extractSectionFirstDirective(blueprintSection, ["opening hook", "开场钩子"]);
    const payoffRequired = this.extractSectionFirstDirective(blueprintSection, ["payoff required", "兑现要求", "爽点兑现"]);
    const endingHook = this.extractSectionFirstDirective(blueprintSection, ["ending hook", "章尾钩子", "结尾钩子"]);
    const sceneLines = this.extractSectionList(blueprintSection, ["scenes", "scene beats", "场景", "场景节拍"]);
    if (!openingHook || !payoffRequired || !endingHook || sceneLines.length < 5) {
      return undefined;
    }

    const scenes = sceneLines.slice(0, 8).map((line) => this.parseBlueprintSceneLine(line));
    const parsed = ChapterBlueprintSchema.safeParse({
      openingHook,
      scenes,
      payoffRequired,
      endingHook,
      status: "confirmed",
      version: 1,
      sourceArtifactIds: [],
    });
    return parsed.success ? parsed.data : undefined;
  }

  private extractJsonObject(content: string): string | undefined {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced?.startsWith("{")) return fenced;
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) return content.slice(start, end + 1);
    return undefined;
  }

  private parseBlueprintSceneLine(line: string): ChapterBlueprint["scenes"][number] {
    const cleaned = line.replace(/^\d+[.)、]\s*/, "").trim();
    const parts = new Map<string, string>();
    for (const part of cleaned.split(/\s+\|\s+/)) {
      const match = part.match(/^([^:：]+)[:：]\s*(.+)$/u);
      if (match?.[1] && match[2]) {
        parts.set(match[1].trim().toLowerCase(), match[2].trim());
      }
    }
    const beat = parts.get("beat") ?? cleaned;
    return {
      beat,
      conflict: parts.get("conflict") ?? "该场景必须有可见阻力，不能只总结推进。",
      informationGap: parts.get("informationgap") ?? parts.get("information gap"),
      turn: parts.get("turn") ?? "该场景必须发生局势转折。",
      payoff: parts.get("payoff") ?? "该场景必须给出可见兑现。",
      cost: parts.get("cost") ?? "该场景的收益必须伴随代价或风险。",
    };
  }

  private buildChapterBlueprint(input: {
    readonly language: "zh" | "en";
    readonly goal: string;
    readonly outlineNode?: string;
    readonly steeringContract?: ChapterSteeringContract;
    readonly sceneDirective?: string;
    readonly hookAgendaSummary?: string;
    readonly platform?: string;
    readonly chapterNumber?: number;
  }): ChapterBlueprint {
    const isEn = input.language === "en";
    const isAdult = input.platform === "adult";
    const contract = input.steeringContract;
    const mustIncludeItems = contract?.mustInclude ?? [];

    // For adult platform (Chinese), always use adult-specific erotic scene beats
    if (isAdult && !isEn) {
      const adultSceneSeeds = [
        `开场：在前100字内触发明确的情欲引力——${input.goal}，通过权力差/禁忌关系/身体细节（她的呼吸变化、体态、特定部位的视觉暗示）立刻让读者感受到"什么要发生了"；禁止纯粹的场景铺垫开头`,
        `拉扯博弈（★最核心，≥400字）：女性角色真实的多次抵抗（不是象征性一次），主角通过精准观察+掌控逐步破防；每次抵抗后有具体的身体层面进展；★必须至少一次边缘控制——把她带到高潮边缘然后突然停手，逼她开口`,
        `第一道突破（阴蒂/乳头初次接触）：完整呈现那一触的三重反应——①身体不可控反应（收缩/颤抖/湿润）②心理激烈抗拒的内心独白（"为什么会……"）③被迫承认（在羞耻中挤出的半句话）`,
        `深入展开（五感全开，≥700字）：插入或完整口交；★全程追踪身体敏感度递进曲线——每次进出都比上次感觉更强、更满；私密部位充满感、阴道壁主动收缩感必须具体描写；对白进入直白骚话+哭腔呻吟阶段；心理推进到主动索取`,
        `高潮慢镜头（★边缘控制后的最终兑现，必须写满≥400字）：先进行一到两次边缘控制（带她到边缘再停）→逼她主动开口用直白词汇索取→最终兑现；高潮本体必须逐格呈现：最终触发点、哪个部位痉挛收缩、呻吟如何变化、体液状态、意识断片的几秒、脱力落地；禁止"她达到了顶点"一句带过`,
        `余韵+章尾钩子：高潮后私密处持续颤抖+液体感+皮肤超敏感期（碰一下仍是痉挛）；心理层面羞耻与隐秘满足并存；章尾引出下一个更高阶的征服目标，让读者对更深的禁忌产生明确期待`,
      ];
      const adultPayoff = contract?.payoffRequired
        ?? `女性角色经历完整的边缘控制后在最大渴望状态下高潮（至少两次推至边缘再给予兑现）；高潮场景≥400字慢镜头，读者感受到真实的生理共鸣`;
      const adultEndingHook = contract?.endingHook
        ?? `章尾让读者感觉本章欲望已部分释放，同时对下一章更深的禁忌产生期待`;
      return ChapterBlueprintSchema.parse({
        openingHook: contract?.goal ?? input.goal,
        scenes: adultSceneSeeds.map((beat, index) => ({
          beat,
          conflict: index < mustIncludeItems.length
            ? `围绕"${mustIncludeItems[index]}"直接推进情欲场景，不能模糊带过`
            : `本节拍必须有可见的情欲进展，不能只是心理描写或氛围铺垫`,
          informationGap: input.hookAgendaSummary
            ? `利用伏笔压力：${input.hookAgendaSummary}`
            : (input.outlineNode ?? input.goal),
          turn: `本节拍结束时，女性角色的防线状态必须比开始时更松动——用具体的身体反应或对白来体现`,
          payoff: adultPayoff,
          cost: `征服必须付出对等代价：时间/情感/暴露/风险——不能无代价地无限推进`,
        })),
        payoffRequired: adultPayoff,
        endingHook: adultEndingHook,
        contractSatisfaction: [
          ...(contract?.goal ? [`目标：${contract.goal}`] : []),
          ...((contract?.mustInclude ?? []).map((item) => `必须包含：${item}`)),
          ...((contract?.mustAvoid ?? []).map((item) => `必须避免：${item}`)),
        ],
      });
    }

    const defaultSceneSeeds = isEn
      ? [
          `Open on a concrete pressure point tied to: ${input.goal}`,
          mustIncludeItems.length > 0
            ? `Force the protagonist to directly confront: ${mustIncludeItems[0]}—no detours`
            : "Force the protagonist to make an active choice under incomplete information.",
          mustIncludeItems.length > 1
            ? `Build toward: ${mustIncludeItems.slice(1).join(", ")}, with resistance from a capable opponent`
            : "Introduce resistance from a competent opponent or ally with their own agenda.",
          "Land a visible payoff, reversal, or cost before the chapter ends.",
          "Close on a hook that grows out of the payoff — a new question, not vague atmosphere.",
        ]
      : [
          `用一个具体压力点开场，直接指向：${input.goal}`,
          mustIncludeItems.length > 0
            ? `主角必须直面：${mustIncludeItems[0]}，不能回避或绕路`
            : "让主角在信息不完整时做出主动选择。",
          mustIncludeItems.length > 1
            ? `推进至：${mustIncludeItems.slice(1).join("、")}，对手或盟友制造直接阻力`
            : "让有能力的对手或盟友制造阻力，体现其独立诉求。",
          "章内必须落下一个可见爽点、反转或代价。",
          "章尾用兑现后的自然新问题制造悬念，不能只靠氛围句收尾。",
        ];

    const sceneSeeds = contract?.sceneBeats.length
      ? (contract.sceneBeats.length >= 5
          ? contract.sceneBeats.slice(0, 6)
          : [...contract.sceneBeats, ...defaultSceneSeeds].slice(0, 6))
      : defaultSceneSeeds;

    const payoff = contract?.payoffRequired
      ?? (isEn
        ? "Give the reader a concrete change in leverage, knowledge, relationship, or resources."
        : "给读者一个具体可感的变化：筹码、信息、关系或资源必须至少改变一项。");
    const endingHook = contract?.endingHook
      ?? (isEn
        ? "End on a renewed question created by the payoff, not on vague atmosphere."
        : "章尾钩子必须由本章兑现后的新问题自然产生，不能只靠氛围句收尾。");

    return ChapterBlueprintSchema.parse({
      openingHook: contract?.goal ?? input.goal,
      scenes: sceneSeeds.map((beat, index) => ({
        beat,
        conflict: isEn
          ? (index < mustIncludeItems.length
              ? `Confront "${mustIncludeItems[index]}" directly—no summary-only progress.`
              : `Scene ${index + 1} must contain direct resistance, not summary-only progress.`)
          : (index < mustIncludeItems.length
              ? `围绕"${mustIncludeItems[index]}"直接交锋，不能模糊带过`
              : `第${index + 1}个场景必须有直接阻力，不能只用总结推进。`),
        informationGap: input.hookAgendaSummary
          ? (isEn ? `Use hook pressure: ${input.hookAgendaSummary}` : `利用伏笔压力：${input.hookAgendaSummary}`)
          : (input.outlineNode ?? input.sceneDirective ?? input.goal),
        turn: isEn
          ? "Make the situation meaningfully different by the end of the beat."
          : "该节拍结束时，局势必须发生可见变化。",
        payoff,
        cost: isEn
          ? "Attach a cost, exposure, debt, or new risk to the gain."
          : "收益必须伴随代价、暴露、欠债或新风险。",
      })),
      payoffRequired: payoff,
      endingHook,
      contractSatisfaction: [
        ...(contract?.goal ? [isEn ? `Goal: ${contract.goal}` : `目标：${contract.goal}`] : []),
        ...((contract?.mustInclude ?? []).map((item) => isEn ? `Must include: ${item}` : `必须包含：${item}`)),
        ...((contract?.mustAvoid ?? []).map((item) => isEn ? `Must avoid: ${item}` : `必须避免：${item}`)),
      ],
    });
  }

  private collectMustKeep(currentState: string, storyBible: string): string[] {
    return this.unique([
      ...this.extractListItems(currentState, 2),
      ...this.extractListItems(storyBible, 2),
    ]).slice(0, 4);
  }

  private collectMustAvoid(currentFocus: string, prohibitions: ReadonlyArray<string>): string[] {
    const avoidSection = this.extractSection(currentFocus, [
      "avoid",
      "must avoid",
      "禁止",
      "避免",
      "避雷",
    ]);
    const focusAvoids = avoidSection
      ? this.extractListItems(avoidSection, 10)
      : currentFocus
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          line.startsWith("-") &&
          /avoid|don't|do not|不要|别|禁止/i.test(line),
        )
        .map((line) => this.cleanListItem(line))
        .filter((line): line is string => Boolean(line));

    return this.unique([...focusAvoids, ...prohibitions]).slice(0, 6);
  }

  private extractSectionFirstDirective(content: string, headings: ReadonlyArray<string>): string | undefined {
    const section = this.extractSection(content, headings);
    return this.extractFirstDirective(section ?? "");
  }

  private extractSectionList(content: string, headings: ReadonlyArray<string>): string[] {
    const section = this.extractSection(content, headings);
    if (!section) return [];
    const listed = this.extractListItems(section, 12);
    if (listed.length > 0) return listed;
    return section
      .split(/\n|；|;|，|,/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !this.isTemplatePlaceholder(line))
      .slice(0, 8);
  }

  private collectStyleEmphasis(authorIntent: string, currentFocus: string): string[] {
    return this.unique([
      ...this.extractFocusStyleItems(currentFocus),
      ...this.extractListItems(authorIntent, 2),
    ]).slice(0, 4);
  }

  private collectConflicts(
    externalContext: string | undefined,
    currentFocus: string,
    outlineNode: string | undefined,
    volumeOutline: string,
  ): ChapterConflict[] {
    const outlineText = outlineNode ?? volumeOutline;
    if (!outlineText || outlineText === "(文件尚未创建)") return [];
    if (externalContext) {
      const indicatesOverride = /ignore|skip|defer|instead|不要|别|先别|暂停/i.test(externalContext);
      if (!indicatesOverride && this.hasKeywordOverlap(externalContext, outlineText)) return [];

      return [
        {
          type: "outline_vs_request",
          resolution: "allow local outline deferral",
        },
      ];
    }

    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (!localOverride || !outlineNode) {
      return [];
    }

    return [
      {
        type: "outline_vs_current_focus",
        resolution: "allow explicit current focus override",
        detail: localOverride,
      },
    ];
  }

  private extractFirstDirective(content?: string): string | undefined {
    if (!content) return undefined;
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        line.length > 0
        && !line.startsWith("#")
        && !line.startsWith("-")
        && !this.isTemplatePlaceholder(line),
      );
  }

  private extractListItems(content: string, limit: number): string[] {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => this.cleanListItem(line))
      .filter((line): line is string => Boolean(line))
      .slice(0, limit);
  }

  private extractFocusGoal(currentFocus: string): string | undefined {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    const directives = this.extractFocusStyleItems(focusSection, 3);
    if (directives.length === 0) {
      return this.extractFirstDirective(focusSection);
    }
    return directives.join(this.containsChinese(focusSection) ? "；" : "; ");
  }

  private extractLocalOverrideGoal(currentFocus: string): string | undefined {
    const overrideSection = this.extractSection(currentFocus, [
      "local override",
      "explicit override",
      "chapter override",
      "local task override",
      "局部覆盖",
      "本章覆盖",
      "临时覆盖",
      "当前覆盖",
    ]);
    if (!overrideSection) {
      return undefined;
    }

    const directives = this.extractListItems(overrideSection, 3);
    if (directives.length > 0) {
      return directives.join(this.containsChinese(overrideSection) ? "；" : "; ");
    }

    return this.extractFirstDirective(overrideSection);
  }

  private extractFocusStyleItems(currentFocus: string, limit = 3): string[] {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    return this.extractListItems(focusSection, limit);
  }

  private buildArcDirective(
    language: string | undefined,
    volumeOutline: string,
    outlineNode: string | undefined,
    matchedOutlineAnchor: boolean,
  ): string | undefined {
    if (matchedOutlineAnchor || !outlineNode || volumeOutline === "(文件尚未创建)") {
      return undefined;
    }

    return this.isChineseLanguage(language)
      ? "不要继续依赖卷纲的 fallback 指令，必须把本章推进到新的弧线节点或地点变化。"
      : "Do not keep leaning on the outline fallback. Force this chapter toward a fresh arc beat or location change.";
  }

  private buildSceneDirective(
    language: string | undefined,
    cadence: ReturnType<typeof analyzeChapterCadence>,
  ): string | undefined {
    if (cadence.scenePressure?.pressure !== "high") {
      return undefined;
    }
    const repeatedType = cadence.scenePressure.repeatedType;

    return this.isChineseLanguage(language)
      ? `最近章节连续停留在“${repeatedType}”，本章必须更换场景容器、地点或行动方式。`
      : `Recent chapters are stuck in repeated ${repeatedType} beats. Change the scene container, location, or action pattern this chapter.`;
  }

  private buildMoodDirective(
    language: string | undefined,
    cadence: ReturnType<typeof analyzeChapterCadence>,
  ): string | undefined {
    if (cadence.moodPressure?.pressure !== "high") {
      return undefined;
    }
    const moods = cadence.moodPressure.recentMoods;

    return this.isChineseLanguage(language)
      ? `最近${moods.length}章情绪持续高压（${moods.slice(0, 3).join("、")}），本章必须降调——安排日常/喘息/温情/幽默场景，让读者呼吸。`
      : `The last ${moods.length} chapters have been relentlessly tense (${moods.slice(0, 3).join(", ")}). This chapter must downshift — write a quieter scene with warmth, humor, or breathing room.`;
  }

  private buildTitleDirective(
    language: string | undefined,
    cadence: ReturnType<typeof analyzeChapterCadence>,
  ): string | undefined {
    if (cadence.titlePressure?.pressure !== "high") {
      return undefined;
    }
    const repeatedToken = cadence.titlePressure.repeatedToken;

    return this.isChineseLanguage(language)
      ? `标题不要再围绕“${repeatedToken}”重复命名，换一个新的意象或动作焦点。`
      : `Avoid another ${repeatedToken}-centric title. Pick a new image or action focus for this chapter title.`;
  }

  private renderHookBudget(activeCount: number, language: "zh" | "en"): string {
    const cap = 12;
    if (activeCount < 10) {
      return language === "en"
        ? `### Hook Budget\n- ${activeCount} active hooks (capacity: ${cap})`
        : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔（容量：${cap}）`;
    }
    const remaining = Math.max(0, cap - activeCount);
    return language === "en"
      ? `### Hook Budget\n- ${activeCount} active hooks — approaching capacity (${cap}). Only ${remaining} new hook(s) allowed. Prioritize resolving existing debt over opening new threads.`
      : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔——接近容量上限（${cap}）。仅剩 ${remaining} 个新坑位。优先回收旧债，不要轻易开新线。`;
  }

  private extractSection(content: string, headings: ReadonlyArray<string>): string | undefined {
    const targets = headings.map((heading) => this.normalizeHeading(heading));
    const lines = content.split("\n");
    let buffer: string[] | null = null;
    let sectionLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s*(.+?)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const heading = this.normalizeHeading(headingMatch[2]!);

        if (buffer && level <= sectionLevel) {
          break;
        }

        if (targets.includes(heading)) {
          buffer = [];
          sectionLevel = level;
          continue;
        }
      }

      if (buffer) {
        buffer.push(line);
      }
    }

    const section = buffer?.join("\n").trim();
    return section && section.length > 0 ? section : undefined;
  }

  private normalizeHeading(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/[*_`:#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanListItem(line: string): string | undefined {
    const cleaned = line.replace(/^-\s*/, "").trim();
    if (cleaned.length === 0) return undefined;
    if (/^[-|]+$/.test(cleaned)) return undefined;
    if (this.isTemplatePlaceholder(cleaned)) return undefined;
    return cleaned;
  }

  private isTemplatePlaceholder(line: string): boolean {
    const normalized = line.trim();
    if (!normalized) return false;

    return (
      /^\((describe|briefly describe|write)\b[\s\S]*\)$/i.test(normalized)
      || /^（(?:在这里描述|描述|填写|写下)[\s\S]*）$/u.test(normalized)
    );
  }

  private containsChinese(content: string): boolean {
    return /[\u4e00-\u9fff]/.test(content);
  }

  private findOutlineNode(volumeOutline: string, chapterNumber: number): string | undefined {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchExactOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[1]);
      if (inlineContent) {
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchRangeOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[3]);
      if (inlineContent) {
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!this.isOutlineAnchorLine(line)) continue;

      const exactMatch = this.matchAnyExactOutlineLine(line);
      if (exactMatch) {
        const inlineContent = this.cleanOutlineContent(exactMatch[1]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const rangeMatch = this.matchAnyRangeOutlineLine(line);
      if (rangeMatch) {
        const inlineContent = this.cleanOutlineContent(rangeMatch[3]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }

      break;
    }

    return this.extractFirstDirective(volumeOutline);
  }

  private cleanOutlineContent(content?: string): string | undefined {
    const cleaned = content?.trim();
    if (!cleaned) return undefined;
    if (/^[*_`~:：-]+$/.test(cleaned)) return undefined;
    return cleaned;
  }

  private findNextOutlineContent(lines: ReadonlyArray<string>, startIndex: number): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) {
        continue;
      }

      if (this.isOutlineAnchorLine(line)) {
        return undefined;
      }

      if (line.startsWith("#")) {
        continue;
      }

      const cleaned = this.cleanOutlineContent(line);
      if (cleaned) {
        return cleaned;
      }
    }

    return undefined;
  }

  private hasMatchedOutlineAnchor(volumeOutline: string, chapterNumber: number): boolean {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.some((line) =>
      this.matchExactOutlineLine(line, chapterNumber) !== undefined
      || this.matchRangeOutlineLine(line, chapterNumber) !== undefined,
    );
  }

  private matchExactOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const patterns = [
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?Chapter\\s*${chapterNumber}(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`, "i"),
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?第\\s*${chapterNumber}\\s*章(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`),
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchAnyExactOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*\d+(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*\d+\s*章(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchRangeOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const match = this.matchAnyRangeOutlineLine(line);
    if (!match) return undefined;
    if (this.isChapterWithinRange(match[1], match[2], chapterNumber)) {
      return match;
    }

    return undefined;
  }

  private matchAnyRangeOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*(\d+)\s*[-~–—]\s*(\d+)\b(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private isOutlineAnchorLine(line: string): boolean {
    return this.matchAnyExactOutlineLine(line) !== undefined
      || this.matchAnyRangeOutlineLine(line) !== undefined;
  }

  private isChapterWithinRange(startText: string | undefined, endText: string | undefined, chapterNumber: number): boolean {
    const start = Number.parseInt(startText ?? "", 10);
    const end = Number.parseInt(endText ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    return chapterNumber >= lower && chapterNumber <= upper;
  }

  private hasKeywordOverlap(left: string, right: string): boolean {
    const keywords = this.extractKeywords(left);
    if (keywords.length === 0) return false;
    const normalizedRight = right.toLowerCase();
    return keywords.some((keyword) => normalizedRight.includes(keyword.toLowerCase()));
  }

  private extractKeywords(content: string): string[] {
    const english = content.match(/[a-z]{4,}/gi) ?? [];
    const chinese = content.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
    return this.unique([...english, ...chinese]);
  }

  private renderIntentMarkdown(
    intent: ChapterIntent,
    language: "zh" | "en",
    pendingHooks: string,
    chapterSummaries: string,
    activeHookCount: number,
  ): string {
    const conflictLines = intent.conflicts.length > 0
      ? intent.conflicts.map((conflict) => `- ${conflict.type}: ${conflict.resolution}`).join("\n")
      : "- none";

    const mustKeep = intent.mustKeep.length > 0
      ? intent.mustKeep.map((item) => `- ${item}`).join("\n")
      : "- none";

    const mustAvoid = intent.mustAvoid.length > 0
      ? intent.mustAvoid.map((item) => `- ${item}`).join("\n")
      : "- none";

    const styleEmphasis = intent.styleEmphasis.length > 0
      ? intent.styleEmphasis.map((item) => `- ${item}`).join("\n")
      : "- none";
    const steeringContract = intent.steeringContract
      ? [
          intent.steeringContract.rawRequest ? `- rawRequest: ${intent.steeringContract.rawRequest}` : undefined,
          intent.steeringContract.goal ? `- goal: ${intent.steeringContract.goal}` : undefined,
          `- priority: ${intent.steeringContract.priority}`,
          intent.steeringContract.mustInclude.length > 0
            ? `- mustInclude: ${intent.steeringContract.mustInclude.join("；")}`
            : undefined,
          intent.steeringContract.mustAvoid.length > 0
            ? `- mustAvoid: ${intent.steeringContract.mustAvoid.join("；")}`
            : undefined,
          intent.steeringContract.sceneBeats.length > 0
            ? `- sceneBeats: ${intent.steeringContract.sceneBeats.join("；")}`
            : undefined,
          intent.steeringContract.payoffRequired ? `- payoffRequired: ${intent.steeringContract.payoffRequired}` : undefined,
          intent.steeringContract.endingHook ? `- endingHook: ${intent.steeringContract.endingHook}` : undefined,
        ].filter(Boolean).join("\n")
      : "- none";
    const blueprint = intent.blueprint
      ? [
          `- openingHook: ${intent.blueprint.openingHook}`,
          `- payoffRequired: ${intent.blueprint.payoffRequired}`,
          `- endingHook: ${intent.blueprint.endingHook}`,
          "",
          "### Scene Beats",
          ...intent.blueprint.scenes.map((scene, index) => [
            `${index + 1}. ${scene.beat}`,
            `   - conflict: ${scene.conflict}`,
            `   - informationGap: ${scene.informationGap}`,
            `   - turn: ${scene.turn}`,
            `   - payoff: ${scene.payoff}`,
            `   - cost: ${scene.cost}`,
          ].join("\n")),
          "",
          "### Contract Satisfaction",
          intent.blueprint.contractSatisfaction.length > 0
            ? intent.blueprint.contractSatisfaction.map((item) => `- ${item}`).join("\n")
            : "- none",
        ].join("\n")
      : "- none";
    const directives = [
      intent.arcDirective ? `- arc: ${intent.arcDirective}` : undefined,
      intent.sceneDirective ? `- scene: ${intent.sceneDirective}` : undefined,
      intent.moodDirective ? `- mood: ${intent.moodDirective}` : undefined,
      intent.titleDirective ? `- title: ${intent.titleDirective}` : undefined,
    ].filter(Boolean).join("\n") || "- none";
    const hookAgenda = [
      "### Must Advance",
      intent.hookAgenda.mustAdvance.length > 0
        ? intent.hookAgenda.mustAdvance.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      "### Eligible Resolve",
      intent.hookAgenda.eligibleResolve.length > 0
        ? intent.hookAgenda.eligibleResolve.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      "### Stale Debt",
      intent.hookAgenda.staleDebt.length > 0
        ? intent.hookAgenda.staleDebt.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      "### Avoid New Hook Families",
      intent.hookAgenda.avoidNewHookFamilies.length > 0
        ? intent.hookAgenda.avoidNewHookFamilies.map((item) => `- ${item}`).join("\n")
        : "- none",
      "",
      this.renderHookBudget(activeHookCount, language),
    ].join("\n");

    return [
      "# Chapter Intent",
      "",
      "## Goal",
      intent.goal,
      "",
      "## Outline Node",
      intent.outlineNode ?? "(not found)",
      "",
      "## Must Keep",
      mustKeep,
      "",
      "## Must Avoid",
      mustAvoid,
      "",
      "## Style Emphasis",
      styleEmphasis,
      "",
      "## User Contract Priority",
      intent.userContractPriority,
      "",
      "## Steering Contract",
      steeringContract,
      "",
      "## Chapter Blueprint",
      blueprint,
      "",
      "## Structured Directives",
      directives,
      "",
      "## Hook Agenda",
      hookAgenda,
      "",
      "## Conflicts",
      conflictLines,
      "",
      "## Pending Hooks Snapshot",
      pendingHooks,
      "",
      "## Chapter Summaries Snapshot",
      chapterSummaries,
      "",
    ].join("\n");
  }

  private unique(values: ReadonlyArray<string>): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private isChineseLanguage(language: string | undefined): boolean {
    return (language ?? "zh").toLowerCase().startsWith("zh");
  }

  private async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }
}
