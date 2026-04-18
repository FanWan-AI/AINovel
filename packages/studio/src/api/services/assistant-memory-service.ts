import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type AssistantMemoryLayer = "session" | "book" | "user" | "market";

export interface AssistantMemoryRecord<T = unknown> {
  readonly layer: AssistantMemoryLayer;
  readonly updatedAt: string;
  readonly summary: string;
  readonly data: T;
  readonly expiresAt?: string;
}

export interface AssistantMemoryContext {
  readonly bookId?: string;
  readonly sessionId?: string;
}

export interface AssistantMemoryReadResult<T = unknown> {
  readonly memory: AssistantMemoryRecord<T> | null;
  readonly warning?: string;
}

export interface AssistantMemoryEnsureMarketResult {
  readonly memory: AssistantMemoryRecord | null;
  readonly warning?: string;
  readonly refreshed: boolean;
  readonly stale: boolean;
}

export interface AssistantMemoryAgentContext {
  readonly promptBlock: string;
  readonly warnings: ReadonlyArray<string>;
}

export interface AssistantBookMemoryUpdateInput {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly action: "write-next" | "revise";
  readonly details: Record<string, unknown>;
  readonly chapterSnippet?: string;
}

const ASSISTANT_SESSION_MEMORY_DIR = ".inkos/assistant-sessions";
export const ASSISTANT_MARKET_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

const SENSITIVE_MEMORY_FIELD_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/iu;
const MEMORY_SUMMARY_MAX_LENGTH = 360;
const BOOK_MEMORY_ACTIVITY_LIMIT = 8;

function normalizeMemoryText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function createFallbackSummary(layer: AssistantMemoryLayer, data: unknown): string {
  if (Array.isArray(data)) {
    return `${layer} memory updated with ${data.length} items.`;
  }
  if (data && typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>).slice(0, 6);
    return keys.length > 0
      ? `${layer} memory updated (${keys.join(", ")}).`
      : `${layer} memory updated.`;
  }
  return `${layer} memory updated.`;
}

function truncateSummary(summary: string, layer: AssistantMemoryLayer, data: unknown): string {
  const normalized = summary.trim();
  if (normalized.length === 0) {
    return createFallbackSummary(layer, data);
  }
  return normalized.slice(0, MEMORY_SUMMARY_MAX_LENGTH);
}

function sanitizeMemoryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeMemoryValue(item))
      .filter((item) => item !== undefined);
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      return value.trim();
    }
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_MEMORY_FIELD_PATTERN.test(key))
    .map(([key, item]) => [key, sanitizeMemoryValue(item)] as const)
    .filter(([, item]) => item !== undefined);

  return Object.fromEntries(entries);
}

function inferSummary(layer: AssistantMemoryLayer, data: unknown, explicitSummary?: string): string {
  const providedSummary = normalizeMemoryText(explicitSummary);
  if (providedSummary) {
    return truncateSummary(providedSummary, layer, data);
  }

  if (data && typeof data === "object") {
    const summary = normalizeMemoryText((data as { summary?: unknown }).summary);
    if (summary) {
      return truncateSummary(summary, layer, data);
    }
  }

  if (layer === "market" && data && typeof data === "object") {
    const marketSummary = normalizeMemoryText((data as { marketSummary?: unknown }).marketSummary);
    if (marketSummary) {
      return truncateSummary(marketSummary, layer, data);
    }
  }

  if (layer === "user" && data && typeof data === "object") {
    const style = normalizeMemoryText((data as { style?: unknown }).style);
    const risk = normalizeMemoryText((data as { riskPreference?: unknown }).riskPreference);
    const autopilot = normalizeMemoryText((data as { autopilotLevel?: unknown }).autopilotLevel);
    const fragments = [
      style ? `偏好风格：${style}` : "",
      risk ? `风险偏好：${risk}` : "",
      autopilot ? `Autopilot：${autopilot}` : "",
    ].filter((item) => item.length > 0);
    if (fragments.length > 0) {
      return truncateSummary(fragments.join("；"), layer, data);
    }
  }

  if (layer === "session" && data && typeof data === "object") {
    const goal = normalizeMemoryText((data as { goal?: unknown }).goal);
    const bookTitle = normalizeMemoryText((data as { currentBookTitle?: unknown }).currentBookTitle);
    const fragments = [
      goal ? `当前目标：${goal}` : "",
      bookTitle ? `当前书籍：${bookTitle}` : "",
    ].filter((item) => item.length > 0);
    if (fragments.length > 0) {
      return truncateSummary(fragments.join("；"), layer, data);
    }
  }

  return truncateSummary("", layer, data);
}

function parseStoredRecord(
  layer: AssistantMemoryLayer,
  raw: unknown,
): AssistantMemoryRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const sanitizedData = sanitizeMemoryValue(source.data ?? source);
  const summary = inferSummary(layer, sanitizedData, typeof source.summary === "string" ? source.summary : undefined);

  return {
    layer,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
    summary,
    data: sanitizedData,
    ...(typeof source.expiresAt === "string" ? { expiresAt: source.expiresAt } : {}),
  };
}

export function resolveAssistantMemoryPath(
  root: string,
  layer: AssistantMemoryLayer,
  context: AssistantMemoryContext = {},
): string {
  if (layer === "session") {
    if (!context.sessionId) {
      throw new Error("sessionId is required for session memory");
    }
    return join(root, ASSISTANT_SESSION_MEMORY_DIR, `${context.sessionId}.json`);
  }

  if (layer === "book") {
    if (!context.bookId) {
      throw new Error("bookId is required for book memory");
    }
    return join(root, ".inkos", "books", context.bookId, "memory.json");
  }

  if (layer === "user") {
    return join(root, ".inkos", "user-prefs.json");
  }

  return join(root, ".inkos", "market-cache.json");
}

function isExpired(memory: AssistantMemoryRecord | null, now: number): boolean {
  if (!memory?.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(memory.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function normalizeChapterSnippet(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function buildBookMemoryData(
  previousData: unknown,
  input: AssistantBookMemoryUpdateInput,
  updatedAt: string,
): Record<string, unknown> {
  const previous = previousData && typeof previousData === "object" && !Array.isArray(previousData)
    ? previousData as Record<string, unknown>
    : {};
  const previousActivity = Array.isArray(previous.recentActivity)
    ? previous.recentActivity.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];

  const activityEntry = {
    action: input.action,
    chapterNumber: input.chapterNumber,
    updatedAt,
    ...input.details,
    ...(input.chapterSnippet ? { chapterSnippet: normalizeChapterSnippet(input.chapterSnippet) } : {}),
  };

  const recentActivity = [activityEntry, ...previousActivity].slice(0, BOOK_MEMORY_ACTIVITY_LIMIT);
  const latestChapter = {
    chapterNumber: input.chapterNumber,
    action: input.action,
    updatedAt,
    ...(input.chapterSnippet ? { snippet: normalizeChapterSnippet(input.chapterSnippet) } : {}),
  };
  const latestSummary = input.action === "write-next"
    ? `最近完成第${input.chapterNumber}章写作`
    : `最近完成第${input.chapterNumber}章修订`;

  return sanitizeMemoryValue({
    ...previous,
    bookId: input.bookId,
    lastUpdatedAt: updatedAt,
    lastAction: input.action,
    latestChapter,
    latestSummary,
    recentActivity,
    summary: `${latestSummary}${input.chapterSnippet ? `：${normalizeChapterSnippet(input.chapterSnippet)}` : ""}`,
  }) as Record<string, unknown>;
}

export function createAssistantMemoryService(
  root: string,
  options?: { readonly now?: () => number },
) {
  const now = () => options?.now?.() ?? Date.now();

  async function readMemory(
    layer: AssistantMemoryLayer,
    context: AssistantMemoryContext = {},
  ): Promise<AssistantMemoryReadResult> {
    let filePath: string;
    try {
      filePath = resolveAssistantMemoryPath(root, layer, context);
    } catch (error) {
      return { memory: null, warning: error instanceof Error ? error.message : String(error) };
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseStoredRecord(layer, JSON.parse(raw));
      return { memory: parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return { memory: null };
      }
      return { memory: null, warning: `failed to read ${layer} memory: ${message}` };
    }
  }

  async function writeMemory(
    layer: AssistantMemoryLayer,
    data: unknown,
    context: AssistantMemoryContext = {},
    overrides?: { readonly summary?: string; readonly expiresAt?: string },
  ): Promise<AssistantMemoryReadResult> {
    let filePath: string;
    try {
      filePath = resolveAssistantMemoryPath(root, layer, context);
    } catch (error) {
      return { memory: null, warning: error instanceof Error ? error.message : String(error) };
    }

    const updatedAt = new Date(now()).toISOString();
    const sanitizedData = sanitizeMemoryValue(data);
    const memory: AssistantMemoryRecord = {
      layer,
      updatedAt,
      summary: inferSummary(layer, sanitizedData, overrides?.summary),
      data: sanitizedData,
      ...(overrides?.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
    };

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(memory, null, 2), "utf-8");
      return { memory };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { memory: null, warning: `failed to write ${layer} memory: ${message}` };
    }
  }

  async function updateBookMemory(input: AssistantBookMemoryUpdateInput): Promise<AssistantMemoryReadResult> {
    const current = await readMemory("book", { bookId: input.bookId });
    const updatedAt = new Date(now()).toISOString();
    const nextData = buildBookMemoryData(current.memory?.data, input, updatedAt);
    return await writeMemory(
      "book",
      nextData,
      { bookId: input.bookId },
      { summary: typeof nextData.summary === "string" ? nextData.summary : undefined },
    );
  }

  async function ensureMarketMemory(refresh: () => Promise<unknown>): Promise<AssistantMemoryEnsureMarketResult> {
    const current = await readMemory("market");
    if (current.memory && !isExpired(current.memory, now())) {
      return { memory: current.memory, warning: current.warning, refreshed: false, stale: false };
    }

    try {
      const freshData = await refresh();
      const refreshed = await writeMemory(
        "market",
        freshData,
        {},
        { expiresAt: new Date(now() + ASSISTANT_MARKET_MEMORY_TTL_MS).toISOString() },
      );
      return {
        memory: refreshed.memory,
        warning: refreshed.warning,
        refreshed: true,
        stale: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        memory: current.memory,
        warning: current.warning ?? `failed to refresh market memory: ${message}`,
        refreshed: false,
        stale: current.memory !== null,
      };
    }
  }

  async function buildAgentContext(bookIds: ReadonlyArray<string>): Promise<AssistantMemoryAgentContext> {
    const warnings: string[] = [];
    const blocks: string[] = [];
    const seenBookIds = new Set<string>();

    for (const bookId of bookIds) {
      if (!bookId || seenBookIds.has(bookId)) {
        continue;
      }
      seenBookIds.add(bookId);
      const result = await readMemory("book", { bookId });
      if (result.warning) {
        warnings.push(result.warning);
      }
      if (result.memory?.summary) {
        blocks.push(`【Book Memory】${result.memory.summary}`);
      }
    }

    const userMemory = await readMemory("user");
    if (userMemory.warning) {
      warnings.push(userMemory.warning);
    }
    if (userMemory.memory?.summary) {
      blocks.push(`【User Preference Memory】${userMemory.memory.summary}`);
    }

    return {
      promptBlock: blocks.join("\n"),
      warnings,
    };
  }

  return {
    buildAgentContext,
    ensureMarketMemory,
    readMemory,
    resolvePath: (layer: AssistantMemoryLayer, context?: AssistantMemoryContext) =>
      resolveAssistantMemoryPath(root, layer, context),
    updateBookMemory,
    writeMemory,
  };
}
