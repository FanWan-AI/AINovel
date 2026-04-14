import { describe, expect, it } from "vitest";
import {
  deriveEventLevel,
  deriveEventSource,
  filterEvents,
  deriveEmptyHint,
} from "./RuntimeCenter";
import type { SSEMessage } from "../hooks/use-sse";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(event: string, data: Record<string, unknown> = {}, timestamp = 0): SSEMessage {
  return { event, data, timestamp };
}

// ---------------------------------------------------------------------------
// deriveEventLevel
// ---------------------------------------------------------------------------

describe("deriveEventLevel", () => {
  it("reads level field from log events", () => {
    expect(deriveEventLevel(makeMsg("log", { level: "error" }))).toBe("error");
    expect(deriveEventLevel(makeMsg("log", { level: "WARN" }))).toBe("warn");
    expect(deriveEventLevel(makeMsg("log", { level: "Info" }))).toBe("info");
  });

  it("infers error from events ending in :error", () => {
    expect(deriveEventLevel(makeMsg("write:error"))).toBe("error");
    expect(deriveEventLevel(makeMsg("daemon:error"))).toBe("error");
  });

  it("infers error from semantic fail events", () => {
    expect(deriveEventLevel(makeMsg("rewrite:fail"))).toBe("error");
    expect(deriveEventLevel(makeMsg("revise:fail"))).toBe("error");
  });

  it("infers info from events ending in :complete or :start", () => {
    expect(deriveEventLevel(makeMsg("write:complete"))).toBe("info");
    expect(deriveEventLevel(makeMsg("draft:start"))).toBe("info");
    expect(deriveEventLevel(makeMsg("write-next:success"))).toBe("info");
  });

  it("falls back to debug for unrecognised events", () => {
    expect(deriveEventLevel(makeMsg("ping"))).toBe("debug");
    expect(deriveEventLevel(makeMsg("unknown"))).toBe("debug");
  });
});

// ---------------------------------------------------------------------------
// deriveEventSource
// ---------------------------------------------------------------------------

describe("deriveEventSource", () => {
  it("returns the prefix before the first colon", () => {
    expect(deriveEventSource(makeMsg("write:start"))).toBe("write");
    expect(deriveEventSource(makeMsg("daemon:chapter"))).toBe("daemon");
  });

  it("returns the full event name when there is no colon", () => {
    expect(deriveEventSource(makeMsg("ping"))).toBe("ping");
    expect(deriveEventSource(makeMsg("log"))).toBe("log");
  });
});

// ---------------------------------------------------------------------------
// filterEvents
// ---------------------------------------------------------------------------

const messages: ReadonlyArray<SSEMessage> = [
  makeMsg("write:start",    { bookId: "book1" }),
  makeMsg("write:complete", { bookId: "book1" }),
  makeMsg("daemon:error",   {}),
  makeMsg("log",            { level: "warn", message: "low disk" }),
  makeMsg("log",            { level: "info", message: "ok" }),
];

describe("filterEvents", () => {
  it("returns all messages when filter is empty", () => {
    const result = filterEvents(messages, { level: "", source: "", bookId: "" });
    expect(result).toHaveLength(messages.length);
  });

  it("filters by level", () => {
    const result = filterEvents(messages, { level: "error", source: "", bookId: "" });
    expect(result).toHaveLength(1);
    expect(result[0].event).toBe("daemon:error");
  });

  it("filters by source prefix", () => {
    const result = filterEvents(messages, { level: "", source: "write", bookId: "" });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.event.startsWith("write:"))).toBe(true);
  });

  it("filters by bookId", () => {
    const result = filterEvents(messages, { level: "", source: "", bookId: "book1" });
    expect(result).toHaveLength(2);
    expect(result.every((m) => (m.data as Record<string, unknown>).bookId === "book1")).toBe(true);
  });

  it("combines multiple filter criteria", () => {
    const result = filterEvents(messages, { level: "error", source: "daemon", bookId: "" });
    expect(result).toHaveLength(1);
    expect(result[0].event).toBe("daemon:error");
  });

  it("returns empty when nothing matches", () => {
    const result = filterEvents(messages, { level: "", source: "noop", bookId: "" });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveEmptyHint
// ---------------------------------------------------------------------------

describe("deriveEmptyHint", () => {
  it("shows the idle hint when daemon is stopped and no active filter", () => {
    expect(deriveEmptyHint(false, false)).toBe("rc.emptyIdle");
  });

  it("shows the running hint when daemon is running and no active filter", () => {
    expect(deriveEmptyHint(true, false)).toBe("rc.emptyRunning");
  });

  it("shows the filtered hint when a filter is active regardless of daemon state", () => {
    expect(deriveEmptyHint(false, true)).toBe("rc.emptyFiltered");
    expect(deriveEmptyHint(true, true)).toBe("rc.emptyFiltered");
  });
});
