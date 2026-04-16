import { useEffect, useRef, useCallback, useState } from "react";

export interface SSEMessage {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: number;
}

const SSE_MESSAGE_BUFFER_SIZE = 100;

interface EventSourceLike {
  addEventListener: (type: string, listener: (e: MessageEvent) => void) => void;
  removeEventListener: (type: string, listener: (e: MessageEvent) => void) => void;
}

const LEGACY_EVENT_ALIASES: Record<string, string> = {
  "revise:complete": "revise:success",
  "revise:error": "revise:fail",
  "rewrite:complete": "rewrite:success",
  "rewrite:error": "rewrite:fail",
  "resync:complete": "resync:success",
  "resync:error": "resync:fail",
  "anti-detect:complete": "anti-detect:success",
  "anti-detect:error": "anti-detect:fail",
};

export function normalizeStudioEventName(event: string): string {
  return LEGACY_EVENT_ALIASES[event] ?? event;
}

export const STUDIO_SSE_EVENTS = [
  "book:creating",
  "book:created",
  "book:deleted",
  "book:error",
  "write:start",
  "write:complete",
  "write:error",
  "draft:start",
  "draft:complete",
  "draft:error",
  "plan:start",
  "plan:success",
  "plan:fail",
  "compose:start",
  "compose:success",
  "compose:fail",
  "write-next:start",
  "write-next:success",
  "write-next:fail",
  "revise:start",
  "revise:progress",
  "revise:success",
  "revise:fail",
  "revise:unchanged",
  "rewrite:start",
  "rewrite:progress",
  "rewrite:success",
  "rewrite:fail",
  "rewrite:unchanged",
  "anti-detect:start",
  "anti-detect:progress",
  "anti-detect:success",
  "anti-detect:fail",
  "anti-detect:unchanged",
  "resync:start",
  "resync:progress",
  "resync:success",
  "resync:fail",
  "resync:unchanged",
  "daemon:chapter",
  "daemon:started",
  "daemon:paused",
  "daemon:resumed",
  "daemon:stopped",
  "daemon:error",
  "agent:start",
  "agent:complete",
  "agent:error",
  "assistant:step:start",
  "assistant:step:success",
  "assistant:step:fail",
  "assistant:done",
  "audit:start",
  "audit:complete",
  "audit:error",
  // Legacy lifecycle aliases kept for migration (old server payloads / stale clients).
  "resync:complete",
  "resync:error",
  "revise:complete",
  "revise:error",
  "rewrite:complete",
  "rewrite:error",
  "anti-detect:complete",
  "anti-detect:error",
  "style:start",
  "style:complete",
  "style:error",
  "import:start",
  "import:complete",
  "import:error",
  "fanfic:start",
  "fanfic:complete",
  "fanfic:error",
  "fanfic:refresh:start",
  "fanfic:refresh:complete",
  "fanfic:refresh:error",
  "radar:start",
  "radar:complete",
  "radar:error",
  "log",
  "llm:progress",
  "ping",
] as const;

export function subscribeStudioSSEEvents(es: EventSourceLike, listener: (e: MessageEvent) => void): () => void {
  for (const event of STUDIO_SSE_EVENTS) {
    es.addEventListener(event, listener);
  }
  return () => {
    for (const event of STUDIO_SSE_EVENTS) {
      es.removeEventListener(event, listener);
    }
  };
}

export function useSSE(url = "/api/events") {
  const [messages, setMessages] = useState<ReadonlyArray<SSEMessage>>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const handleEvent = (e: MessageEvent) => {
      if (e.type === "ping") {
        return;
      }
      try {
        const data = e.data ? JSON.parse(e.data) : null;
        const normalizedEvent = normalizeStudioEventName(e.type);
        const payloadTimestamp = typeof data === "object" && data !== null
          ? (data as { timestamp?: unknown }).timestamp
          : undefined;
        const parsedPayloadTimestamp = typeof payloadTimestamp === "string" ? Date.parse(payloadTimestamp) : NaN;
        const timestamp = Number.isNaN(parsedPayloadTimestamp) ? Date.now() : parsedPayloadTimestamp;
        setMessages((prev) => [...prev.slice(-(SSE_MESSAGE_BUFFER_SIZE - 1)), { event: normalizedEvent, data, timestamp }]);
      } catch {
        // ignore parse errors
      }
    };

    const unsubscribe = subscribeStudioSSEEvents(es, handleEvent);

    return () => {
      unsubscribe();
      es.close();
      esRef.current = null;
    };
  }, [url]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, connected, clear };
}
