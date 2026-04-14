/**
 * Unified runtime event store for Studio.
 * Replaces the split design of "daemon page reads SSE, log page reads inkos.log".
 *
 * All broadcast() calls flow through here so the store acts as the single
 * source of truth for recent run events. A fixed-capacity ring buffer avoids
 * unbounded memory growth; the default cap is 500 entries.
 */

export type RuntimeEventLevel = "info" | "warn" | "error";

export interface RuntimeEvent {
  /** The SSE event name that was broadcast (e.g. "write:start", "log"). */
  readonly eventType: string;
  /** Severity level — defaults to "info" unless the source event carries a level. */
  readonly level: RuntimeEventLevel;
  /** Book ID, if the event is scoped to a specific book. */
  readonly bookId?: string;
  /** Chapter number, if the event is scoped to a specific chapter. */
  readonly chapter?: number;
  /** Human-readable description of the event. */
  readonly message: string;
  /** ISO-8601 timestamp when the event was appended to the store. */
  readonly timestamp: string;
  /** The originating subsystem (e.g. "sse", "daemon", "write"). */
  readonly source: string;
}

export interface RuntimeEventQuery {
  /** Filter to a specific book ID. */
  readonly bookId?: string;
  /** Filter to a specific event type. */
  readonly eventType?: string;
  /** Filter to events at or after this ISO-8601 timestamp. */
  readonly since?: string;
  /** Maximum number of results to return (applied after other filters). */
  readonly limit?: number;
}

const DEFAULT_CAPACITY = 500;

/**
 * In-process ring-buffer store for runtime events.
 *
 * Events are always stored in insertion order (oldest → newest). When the
 * buffer is full the oldest entry is evicted to make room for the new one.
 * All methods are synchronous — safe for single-threaded Node.js execution.
 */
export class RuntimeEventStore {
  private readonly capacity: number;
  private readonly buffer: RuntimeEvent[];
  private head = 0; // index of the next write slot (ring buffer pointer)
  private count = 0; // total entries currently in the buffer

  constructor(capacity = DEFAULT_CAPACITY) {
    if (capacity < 1) throw new RangeError("RuntimeEventStore capacity must be ≥ 1");
    this.capacity = capacity;
    this.buffer = new Array<RuntimeEvent>(capacity);
  }

  /**
   * Append an event to the store.
   * If the buffer is at capacity the oldest event is silently evicted.
   */
  append(event: RuntimeEvent): void {
    this.buffer[this.head] = event;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Return stored events in ascending timestamp order (oldest first).
   * Accepts an optional query to filter and limit the results.
   */
  query(filter?: RuntimeEventQuery): ReadonlyArray<RuntimeEvent> {
    const events = this.toArray();

    let result = events;

    if (filter?.bookId !== undefined) {
      result = result.filter((e) => e.bookId === filter.bookId);
    }
    if (filter?.eventType !== undefined) {
      result = result.filter((e) => e.eventType === filter.eventType);
    }
    if (filter?.since !== undefined) {
      const since = filter.since;
      result = result.filter((e) => e.timestamp >= since);
    }
    if (filter?.limit !== undefined && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }

    return result;
  }

  /** Remove all events from the store. */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Total number of events currently in the store. */
  get size(): number {
    return this.count;
  }

  /**
   * Return a snapshot of all events in chronological order (oldest first).
   * The ring buffer may be wrapped, so we reconstruct the logical order.
   */
  private toArray(): RuntimeEvent[] {
    if (this.count === 0) return [];

    if (this.count < this.capacity) {
      // Buffer has not wrapped — entries are at indices 0 … count-1
      return this.buffer.slice(0, this.count) as RuntimeEvent[];
    }

    // Buffer is full and has wrapped.
    // The oldest entry is at `this.head`; newest is at `this.head - 1`.
    const tail = this.buffer.slice(this.head) as RuntimeEvent[];
    const head = this.buffer.slice(0, this.head) as RuntimeEvent[];
    return [...tail, ...head];
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton used by server.ts
// ---------------------------------------------------------------------------

export const runtimeEventStore = new RuntimeEventStore();

// ---------------------------------------------------------------------------
// Helper: derive a RuntimeEvent from a raw SSE broadcast payload
// ---------------------------------------------------------------------------

/**
 * Derive a {@link RuntimeEvent} from a raw SSE event name + data payload.
 *
 * Heuristics applied:
 * - `level`: taken from `data.level` when present; otherwise inferred from
 *   the event name suffix (":error" → "error", ":warn" → "warn", else "info").
 * - `bookId`: taken from `data.bookId` when present.
 * - `chapter`: taken from `data.chapterNumber ?? data.chapter` when present.
 * - `message`: taken from `data.message` when present; otherwise the event name.
 * - `source`: derived from the first segment of the event name (e.g. "write"
 *   for "write:start", "daemon" for "daemon:started", "log" for plain "log").
 */
export function deriveRuntimeEvent(
  eventType: string,
  data: unknown,
  now = new Date().toISOString(),
): RuntimeEvent {
  const obj = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};

  // Level
  let level: RuntimeEventLevel = "info";
  if (typeof obj["level"] === "string" && ["info", "warn", "error"].includes(obj["level"])) {
    level = obj["level"] as RuntimeEventLevel;
  } else if (eventType.endsWith(":error") || eventType === "error") {
    level = "error";
  } else if (eventType.endsWith(":warn") || eventType === "warn") {
    level = "warn";
  }

  // bookId
  const bookId =
    typeof obj["bookId"] === "string" ? obj["bookId"] : undefined;

  // chapter
  const rawChapter = obj["chapterNumber"] ?? obj["chapter"];
  const chapter =
    typeof rawChapter === "number" && Number.isFinite(rawChapter)
      ? rawChapter
      : undefined;

  // message
  const message =
    typeof obj["message"] === "string" && obj["message"].length > 0
      ? obj["message"]
      : eventType;

  // source
  const source = eventType.split(":")[0] ?? eventType;

  return { eventType, level, bookId, chapter, message, timestamp: now, source };
}
