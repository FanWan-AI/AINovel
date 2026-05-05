import type { LLMClient, LLMMessage, LLMResponse, OnStreamProgress } from "../llm/provider.js";
import { chatCompletion } from "../llm/provider.js";
import { searchWeb, fetchUrl } from "../utils/web-search.js";
import type { Logger } from "../utils/logger.js";

export interface AgentContext {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
}

export abstract class BaseAgent {
  protected readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  protected get log() {
    return this.ctx.logger;
  }

  protected async chat(
    messages: ReadonlyArray<LLMMessage>,
    options?: { readonly temperature?: number; readonly maxTokens?: number },
  ): Promise<LLMResponse> {
    const callId = `${this.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const purpose = this.describeCallPurpose();
    const startedAt = Date.now();
    this.ctx.onStreamProgress?.({
      callId,
      agentName: this.name,
      purpose,
      elapsedMs: 0,
      totalChars: 0,
      chineseChars: 0,
      preview: "",
      status: "start",
    });
    return chatCompletion(this.ctx.client, this.ctx.model, messages, {
      ...options,
      onStreamProgress: (progress) => {
        this.ctx.onStreamProgress?.({
          ...progress,
          callId,
          agentName: this.name,
          purpose,
          elapsedMs: Math.max(progress.elapsedMs, Date.now() - startedAt),
        });
      },
    });
  }

  private describeCallPurpose(): string {
    switch (this.name) {
      case "writer":
        return "撰写章节正文或章节观察结果";
      case "planner":
        return "规划下一章意图与剧情结构";
      case "composer":
        return "组装章节运行时上下文";
      case "continuity-auditor":
      case "auditor":
        return "审计连续性、人设、伏笔、爽点兑现与成人内容质量导向";
      case "reviser":
        return "局部修补章节问题";
      case "length-normalizer":
        return "生成字数归一化候选";
      case "state-validator":
        return "校验真相文件与章节状态";
      case "chapter-analyzer":
        return "分析章节结构与状态提取";
      default:
        return `${this.name} LLM 调用`;
    }
  }

  /**
   * Chat with web search enabled.
   * OpenAI: uses native web_search_options / web_search_preview.
   * Other providers: searches via Tavily API (TAVILY_API_KEY), injects results into prompt.
   */
  protected async chatWithSearch(
    messages: ReadonlyArray<LLMMessage>,
    options?: { readonly temperature?: number; readonly maxTokens?: number },
  ): Promise<LLMResponse> {
    // OpenAI has native search — use it directly
    if (this.ctx.client.provider === "openai") {
      return chatCompletion(this.ctx.client, this.ctx.model, messages, {
        ...options,
        webSearch: true,
        onStreamProgress: this.ctx.onStreamProgress,
      });
    }

    // Other providers: self-hosted search → inject results into prompt
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) {
      return this.chat(messages, options);
    }

    try {
      // Extract search query from user message (first 200 chars)
      const query = lastUserMsg.content.slice(0, 200);
      this.log?.info(`[search] Searching: ${query.slice(0, 60)}...`);

      const results = await searchWeb(query, 3);
      if (results.length === 0) {
        this.log?.warn("[search] No results found, falling back to regular chat");
        return this.chat(messages, options);
      }

      // Fetch top result for full content
      let fullContent = "";
      try {
        fullContent = await fetchUrl(results[0]!.url, 4000);
      } catch {
        // Fetch failed, use snippets only
      }

      const searchContext = [
        "## Web Search Results\n",
        ...results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`),
        ...(fullContent ? [`\n## Full Content (Top Result)\n${fullContent}`] : []),
      ].join("\n");

      // Inject search results before the last user message
      const augmentedMessages: LLMMessage[] = messages.map((m) =>
        m === lastUserMsg
          ? { ...m, content: `${searchContext}\n\n---\n\n${m.content}` }
          : m,
      );

      return this.chat(augmentedMessages, options);
    } catch (e) {
      this.log?.warn(`[search] Search failed: ${e}, falling back to regular chat`);
      return this.chat(messages, options);
    }
  }

  abstract get name(): string;
}
