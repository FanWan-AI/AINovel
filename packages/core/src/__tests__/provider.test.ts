import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import {
  chatCompletion,
  chatWithTools,
  sanitizeLLMContentForProvider,
  type AgentMessage,
  type LLMClient,
} from "../llm/provider.js";

const ZERO_USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
} as const;

async function captureError(task: Promise<unknown>): Promise<Error> {
  try {
    await task;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected promise to reject");
}

describe("chatCompletion stream fallback", () => {
  it("sanitizes unsafe backslash escapes before sending chat messages", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: ZERO_USAGE,
    });

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0,
        maxTokensCap: null,
        extra: {},
      },
    };

    await chatCompletion(client, "test-model", [
      { role: "user", content: String.raw`执行路径 C:\Users\demo\x 以及残缺 \u12；保留 \n` },
    ]);

    expect(create.mock.calls[0]?.[0].messages[0].content)
      .toBe(String.raw`执行路径 C:\\Users\\demo\\x 以及残缺 \\u12；保留 \\n`);
  });

  it("falls back to sync chat completion when streamed chat returns no chunks", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
          return;
        },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "fallback content" } }],
        usage: ZERO_USAGE,
      });

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: true,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const result = await chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]);

    expect(result.content).toBe("fallback content");
    expect(result.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: true });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ stream: false });
  });

  it("does not blindly suggest stream false for generic 400 errors", async () => {
    const create = vi.fn().mockRejectedValue(new Error("400 Bad Request"));

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const error = await captureError(chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]));

    expect(error.message).toContain("API 返回 400");
    expect(error.message).not.toContain("\"stream\": false");
    expect(error.message).toContain("检查提供方文档");
  });

  it("retries transient transport failures before surfacing an error", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("Connection error"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "retry ok" } }],
        usage: ZERO_USAGE,
      });

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const result = await chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]);

    expect(result.content).toBe("retry ok");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries premature response closes from hosted OpenAI-compatible providers", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("Invalid response body while trying to fetch https://api.deepseek.com/v1/chat/completions: Premature close"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "retry ok" } }],
        usage: ZERO_USAGE,
      });

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const result = await chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]);

    expect(result.content).toBe("retry ok");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reports when sync fallback is rejected because provider requires streaming", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
          return;
        },
      })
      .mockRejectedValueOnce(new Error("400 {\"detail\":\"Stream must be set to true\"}"));

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: true,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const error = await captureError(chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]));

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: true });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ stream: false });
    expect(error.message).toContain("stream:true");
    expect(error.message).not.toContain("\"stream\": false");
  });
});

describe("chatWithTools DeepSeek thinking compatibility", () => {
  it("sanitizes unsafe backslash escapes before sending tool-calling messages", async () => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
        yield { choices: [{ delta: { content: "ok" } }] };
      },
    });
    const client = makeOpenAIClient(create);

    await chatWithTools(client, "deepseek-v4-flash", [
      { role: "system", content: String.raw`系统路径 \x` },
      { role: "user", content: String.raw`按路径A执行，原文 C:\tmp\bad` },
      {
        role: "assistant",
        content: String.raw`上一轮方案含 \u1`,
        reasoningContent: String.raw`reason \q`,
      },
      { role: "tool", toolCallId: "call_1", content: String.raw`tool \x` },
    ], [{
      name: "get_book_status",
      description: "读取书籍状态",
      parameters: { type: "object", properties: {} },
    }]);

    const sent = create.mock.calls[0]?.[0].messages;
    expect(sent[0].content).toBe(String.raw`系统路径 \\x`);
    expect(sent[1].content).toBe(String.raw`按路径A执行，原文 C:\\tmp\\bad`);
    expect(sent[2].content).toBe(String.raw`上一轮方案含 \\u1`);
    expect(sent[2].reasoning_content).toBe(String.raw`reason \\q`);
    expect(sent[3].content).toBe(String.raw`tool \\x`);
  });

  it("preserves streamed reasoning content so tool results can be sent back to DeepSeek V4", async () => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
        yield {
          choices: [{
            delta: {
              reasoning_content: "需要先读状态。",
            },
          }],
        };
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_status",
                type: "function",
                function: { name: "get_book_status", arguments: "" },
              }],
            },
          }],
        };
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "{\"bookId\":\"book-a\"}" },
              }],
            },
          }],
        };
      },
    });

    const client = makeOpenAIClient(create);
    const result = await chatWithTools(client, "deepseek-v4-flash", [
      { role: "user", content: "分析剧情" },
    ], [{
      name: "get_book_status",
      description: "读取书籍状态",
      parameters: { type: "object", properties: {} },
    }]);

    expect(result.reasoningContent).toBe("需要先读状态。");
    expect(result.toolCalls[0]).toEqual({
      id: "call_status",
      name: "get_book_status",
      arguments: "{\"bookId\":\"book-a\"}",
    });
  });

  it("sends assistant reasoning_content back with prior tool calls", async () => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
        yield { choices: [{ delta: { content: "分析完成" } }] };
      },
    });
    const client = makeOpenAIClient(create);
    const messages: AgentMessage[] = [
      { role: "user", content: "分析剧情" },
      {
        role: "assistant",
        content: null,
        reasoningContent: "需要先读状态。",
        toolCalls: [{ id: "call_status", name: "get_book_status", arguments: "{\"bookId\":\"book-a\"}" }],
      },
      { role: "tool", toolCallId: "call_status", content: "{\"ok\":true}" },
    ];

    await chatWithTools(client, "deepseek-v4-flash", messages, [{
      name: "get_book_status",
      description: "读取书籍状态",
      parameters: { type: "object", properties: {} },
    }]);

    expect(create.mock.calls[0]?.[0].messages[1]).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: "需要先读状态。",
    });
  });
});

describe("sanitizeLLMContentForProvider", () => {
  it("escapes provider-hostile sequences without changing normal text", () => {
    expect(sanitizeLLMContentForProvider(String.raw`abc \x \u12 \q \\ \" \/ \n`))
      .toBe(String.raw`abc \\x \\u12 \\q \\ \\" \\/ \\n`);
  });
});

function makeOpenAIClient(create: ReturnType<typeof vi.fn>): LLMClient {
  return {
    provider: "openai",
    apiFormat: "chat",
    stream: true,
    _openai: {
      chat: {
        completions: {
          create,
        },
      },
    } as unknown as OpenAI,
    defaults: {
      temperature: 0.7,
      maxTokens: 512,
      thinkingBudget: 0,
      maxTokensCap: null,
      extra: {},
    },
  };
}
