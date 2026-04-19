export interface AssistantConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
}

export interface AssistantConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messageCount: number;
}

export interface AssistantConversationSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messages: ReadonlyArray<AssistantConversationMessage>;
  readonly currentBookId: string | null;
  readonly currentBookTitle: string | null;
}

const ASSISTANT_CONVERSATIONS_STORAGE_KEY = "inkos.assistant.conversations";
const ASSISTANT_ACTIVE_CONVERSATION_STORAGE_KEY = "inkos.assistant.active-conversation-id";

export const ASSISTANT_CONVERSATIONS_UPDATED_EVENT = "inkos:assistant-conversations-updated";
export const ASSISTANT_ACTIVE_CONVERSATION_CHANGED_EVENT = "inkos:assistant-active-conversation-changed";
export const ASSISTANT_CREATE_NEW_CONVERSATION_EVENT = "inkos:assistant-create-new-conversation";
export const ASSISTANT_SELECT_CONVERSATION_EVENT = "inkos:assistant-select-conversation";

let assistantConversationFallbackCounter = 0;

function createConversationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  assistantConversationFallbackCounter += 1;
  return `assistant-conversation-${Date.now().toString(36)}-${assistantConversationFallbackCounter.toString(36)}`;
}

export function createAssistantConversationSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  assistantConversationFallbackCounter += 1;
  return `assistant-session-${Date.now().toString(36)}-${assistantConversationFallbackCounter.toString(36)}`;
}

function deriveConversationTitle(messages: ReadonlyArray<AssistantConversationMessage>): string {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim().length > 0);
  if (!firstUserMessage) {
    return "新聊天";
  }
  const normalized = firstUserMessage.content
    .replace(/【[^】]*】/gu, " ")
    .replace(/[《》「」]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const stripped = normalized
    .replace(/^(你好|嗨|hi|hello)[，,\s]*/iu, "")
    .replace(/^(请|帮我|我想|我需要|麻烦你)[，,\s]*/u, "")
    .replace(/^(你觉得|你帮我|你来|给我|把)\s*/u, "")
    .replace(/^(基于|根据|围绕|关于|针对)\s*/u, "")
    .trim();
  const sentence = stripped.split(/[。！？!?]/u).find((part) => part.trim().length > 0)?.trim() ?? stripped;
  const compact = sentence
    .replace(/^(这本书|这个章节|这一章|第\d+章)/u, "")
    .replace(/^(能不能|是否|怎么|如何|为什么)\s*/u, "")
    .replace(/^(帮我分析|分析一下|总结一下|看一下|说说)\s*/u, "")
    .replace(/^(我想知道|我想问|想问一下)\s*/u, "")
    .replace(/(比较合适|怎么安排|该怎么办|怎么样)$/u, "")
    .replace(/[，,。！？!?：:]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const segments = compact
    .split(/[，,；;、]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const preferred = segments.find((part) => part.length >= 4) ?? segments[0] ?? compact;
  const finalTitle = preferred || "新聊天";
  return finalTitle.length > 16 ? `${finalTitle.slice(0, 16)}…` : finalTitle;
}

function normalizeBookTitle(title: string | null): string | null {
  if (!title) {
    return null;
  }
  const normalized = title.replace(/[《》「」]/gu, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function isConversationSnapshot(value: unknown): value is AssistantConversationSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.title === "string"
    && typeof candidate.updatedAt === "number"
    && Array.isArray(candidate.messages);
}

function readConversationMap(): Record<string, AssistantConversationSnapshot> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(ASSISTANT_CONVERSATIONS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => isConversationSnapshot(value)),
    );
  } catch {
    return {};
  }
}

function writeConversationMap(conversations: Record<string, AssistantConversationSnapshot>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(ASSISTANT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // ignore storage failures
  }
}

export function listAssistantConversationSummaries(): ReadonlyArray<AssistantConversationSummary> {
  return Object.values(readConversationMap())
    .filter((conversation) => conversation.messages.length > 0)
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readAssistantConversationSnapshot(id: string): AssistantConversationSnapshot | null {
  if (!id.trim()) {
    return null;
  }
  const conversations = readConversationMap();
  return conversations[id] ?? null;
}

export function writeAssistantConversationSnapshot(snapshot: AssistantConversationSnapshot): void {
  const conversations = readConversationMap();
  conversations[snapshot.id] = {
    ...snapshot,
    title: snapshot.title.trim().length > 0 ? snapshot.title : deriveConversationTitle(snapshot.messages),
    updatedAt: snapshot.updatedAt,
  };
  writeConversationMap(conversations);
  notifyAssistantConversationsUpdated();
}

export function createEmptyAssistantConversationSnapshot(id = createConversationId()): AssistantConversationSnapshot {
  return {
    id,
    sessionId: createAssistantConversationSessionId(),
    title: "新聊天",
    updatedAt: Date.now(),
    messages: [],
    currentBookId: null,
    currentBookTitle: null,
  };
}

export function upsertAssistantConversationSnapshot(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly messages: ReadonlyArray<AssistantConversationMessage>;
  readonly currentBookId: string | null;
  readonly currentBookTitle: string | null;
}): AssistantConversationSnapshot {
  const snapshot: AssistantConversationSnapshot = {
    id: input.id,
    sessionId: input.sessionId,
    title: deriveConversationTitle(input.messages),
    updatedAt: Date.now(),
    messages: input.messages,
    currentBookId: input.currentBookId,
    currentBookTitle: normalizeBookTitle(input.currentBookTitle),
  };
  writeAssistantConversationSnapshot(snapshot);
  return snapshot;
}

export function renameAssistantConversation(id: string, title: string): AssistantConversationSnapshot | null {
  const conversations = readConversationMap();
  const current = conversations[id];
  if (!current) {
    return null;
  }
  const normalized = title.replace(/\s+/gu, " ").trim();
  conversations[id] = {
    ...current,
    title: normalized || current.title,
    updatedAt: Date.now(),
  };
  writeConversationMap(conversations);
  notifyAssistantConversationsUpdated();
  return conversations[id];
}

export function deleteAssistantConversation(id: string): string | null {
  const conversations = readConversationMap();
  if (!conversations[id]) {
    return null;
  }
  delete conversations[id];
  writeConversationMap(conversations);
  const summaries = Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt);
  const nextId = summaries[0]?.id ?? null;
  if (getActiveAssistantConversationId() === id) {
    if (nextId) {
      setActiveAssistantConversationId(nextId);
    } else {
      const created = createEmptyAssistantConversationSnapshot();
      conversations[created.id] = created;
      writeConversationMap(conversations);
      setActiveAssistantConversationId(created.id);
      notifyAssistantConversationsUpdated();
      return created.id;
    }
  }
  notifyAssistantConversationsUpdated();
  return nextId;
}

export function ensureActiveAssistantConversationId(): string {
  // On fresh page load (new tab / refresh), always start with a blank conversation.
  // Use a sessionStorage flag so that within the same tab session, switching conversations works normally.
  const SESSION_BOOT_KEY = "inkos.assistant.session-booted";
  const alreadyBooted = typeof window !== "undefined" && window.sessionStorage.getItem(SESSION_BOOT_KEY);
  if (!alreadyBooted && typeof window !== "undefined") {
    window.sessionStorage.setItem(SESSION_BOOT_KEY, "1");
    const created = createEmptyAssistantConversationSnapshot();
    writeAssistantConversationSnapshot(created);
    setActiveAssistantConversationId(created.id);
    return created.id;
  }

  const existing = getActiveAssistantConversationId();
  if (existing) {
    const snapshot = readAssistantConversationSnapshot(existing);
    if (snapshot) {
      return existing;
    }
  }
  const created = createEmptyAssistantConversationSnapshot();
  writeAssistantConversationSnapshot(created);
  setActiveAssistantConversationId(created.id);
  return created.id;
}

export function getActiveAssistantConversationId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(ASSISTANT_ACTIVE_CONVERSATION_STORAGE_KEY);
    return raw && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function setActiveAssistantConversationId(id: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(ASSISTANT_ACTIVE_CONVERSATION_STORAGE_KEY, id);
  } catch {
    // ignore storage failures
  }
  notifyAssistantActiveConversationChanged(id);
}

export function createAndActivateAssistantConversation(): AssistantConversationSnapshot {
  const snapshot = createEmptyAssistantConversationSnapshot();
  writeAssistantConversationSnapshot(snapshot);
  setActiveAssistantConversationId(snapshot.id);
  return snapshot;
}

export function notifyAssistantConversationsUpdated(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(ASSISTANT_CONVERSATIONS_UPDATED_EVENT));
}

export function notifyAssistantActiveConversationChanged(id: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(ASSISTANT_ACTIVE_CONVERSATION_CHANGED_EVENT, {
    detail: { id },
  }));
}

export function dispatchAssistantCreateConversation(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(ASSISTANT_CREATE_NEW_CONVERSATION_EVENT));
}

export function dispatchAssistantSelectConversation(id: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(ASSISTANT_SELECT_CONVERSATION_EVENT, {
    detail: { id },
  }));
}
