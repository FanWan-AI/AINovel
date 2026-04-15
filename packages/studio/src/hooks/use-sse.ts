import { useEffect, useRef, useCallback, useState } from "react";

export interface SSEMessage {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: number;
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
  "resync:complete",
  "resync:error",
  "daemon:chapter",
  "daemon:started",
  "daemon:paused",
  "daemon:resumed",
  "daemon:stopped",
  "daemon:error",
  "agent:start",
  "agent:complete",
  "agent:error",
  "audit:start",
  "audit:complete",
  "audit:error",
  "revise:complete",
  "revise:error",
  "rewrite:complete",
  "rewrite:error",
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
        setMessages((prev) => [...prev.slice(-99), { event: e.type, data, timestamp: Date.now() }]);
      } catch {
        // ignore parse errors
      }
    };

    for (const event of STUDIO_SSE_EVENTS) {
      es.addEventListener(event, handleEvent);
    }

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, connected, clear };
}
