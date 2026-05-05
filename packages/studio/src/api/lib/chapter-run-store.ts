import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHAPTER_RUN_SCHEMA_VERSION,
  type ChapterRunActionType,
  type ChapterRunDecision,
  type ChapterRunEvent,
  type ChapterRunRecord,
  type ChapterRunStatus,
} from "../schemas/chapter-run-schema.js";

interface StoredChapterRunLedger {
  readonly schemaVersion: number;
  readonly runs: ChapterRunRecord[];
}

const VALID_ACTION_TYPES: readonly ChapterRunActionType[] = ["revise", "rewrite", "anti-detect", "resync", "blueprint-targeted-revise", "length-normalize", "pipeline-snapshot"];
const VALID_STATUSES: readonly ChapterRunStatus[] = ["running", "succeeded", "failed"];
const VALID_DECISIONS: readonly ChapterRunDecision[] = ["applied", "unchanged", "failed"];
const ASSISTANT_SOFT_DELETE_REASON = "assistant-soft-delete";

export class ChapterRunStore {
  private readonly bookMutations = new Map<string, Promise<void>>();

  constructor(private readonly resolveBookDir: (bookId: string) => string) {}

  async createRun(input: {
    readonly bookId: string;
    readonly chapter: number;
    readonly actionType: ChapterRunActionType;
    readonly appliedBrief?: string;
  }): Promise<ChapterRunRecord> {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const record: ChapterRunRecord = {
      schemaVersion: CHAPTER_RUN_SCHEMA_VERSION,
      runId,
      bookId: input.bookId,
      chapter: input.chapter,
      actionType: input.actionType,
      status: "running",
      decision: null,
      appliedBrief: input.appliedBrief ?? null,
      unchangedReason: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      events: [{
        index: 0,
        runId,
        timestamp: now,
        type: "start",
        status: "running",
      }],
    };

    await this.mutateRuns(input.bookId, (runs) => [...runs, record]);
    return record;
  }

  async completeRun(input: {
    readonly bookId: string;
    readonly runId: string;
    readonly status: "succeeded" | "failed";
    readonly decision?: ChapterRunDecision | null;
    readonly unchangedReason?: string | null;
    readonly error?: string | null;
    readonly message?: string;
    readonly data?: Record<string, unknown>;
  }): Promise<ChapterRunRecord | null> {
    let updated: ChapterRunRecord | null = null;
    await this.mutateRuns(input.bookId, (runs) => runs.map((run) => {
      if (run.runId !== input.runId) return run;
      const timestamp = new Date().toISOString();
      const event: ChapterRunEvent = {
        index: run.events.length,
        runId: run.runId,
        timestamp,
        type: input.status === "succeeded" ? "success" : "fail",
        status: input.status,
        ...(input.message ? { message: input.message } : {}),
        ...(input.data ? { data: input.data } : {}),
      };
      updated = {
        ...run,
        status: input.status,
        decision: this.resolveDecision(run, input),
        unchangedReason: input.unchangedReason !== undefined ? input.unchangedReason : run.unchangedReason,
        error: input.error !== undefined ? input.error : run.error,
        finishedAt: timestamp,
        events: [...run.events, event],
      };
      return updated;
    }));
    return updated;
  }

  async listRuns(bookId: string, options?: { readonly chapter?: number; readonly limit?: number }): Promise<ChapterRunRecord[]> {
    await this.waitForPendingMutations(bookId);
    const ledger = await this.readLedger(bookId);
    const filtered = ledger.runs
      .filter((run) => this.isRunActive(run))
      .filter((run) => options?.chapter === undefined || run.chapter === options.chapter)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return filtered.slice(0, options?.limit ?? filtered.length);
  }

  async getRun(bookId: string, runId: string, options?: { readonly includeDeleted?: boolean }): Promise<ChapterRunRecord | null> {
    await this.waitForPendingMutations(bookId);
    const ledger = await this.readLedger(bookId);
    return ledger.runs.find((run) =>
      run.runId === runId && (options?.includeDeleted === true || this.isRunActive(run)))
      ?? null;
  }

  async getRunEvents(bookId: string, runId: string): Promise<ChapterRunEvent[] | null> {
    const run = await this.getRun(bookId, runId);
    if (!run) return null;
    return [...run.events].sort((a, b) => a.index - b.index);
  }

  async deleteRun(bookId: string, runId: string): Promise<boolean> {
    let removed = false;
    await this.mutateRuns(bookId, (runs) => runs.map((run) => {
      if (run.runId !== runId) return run;
      if (this.isRunDeleted(run)) return run;
      removed = true;
      return {
        ...run,
        deletedAt: new Date().toISOString(),
        deletedReason: ASSISTANT_SOFT_DELETE_REASON,
      };
    }));
    return removed;
  }

  async restoreRun(bookId: string, runId: string): Promise<boolean> {
    let restored = false;
    await this.mutateRuns(bookId, (runs) => runs.map((run) => {
      if (run.runId !== runId) return run;
      if (!this.isRunDeleted(run)) return run;
      restored = true;
      return {
        ...run,
        deletedAt: null,
        deletedReason: null,
      };
    }));
    return restored;
  }

  private async mutateRuns(bookId: string, updater: (runs: ChapterRunRecord[]) => ChapterRunRecord[]): Promise<void> {
    await this.enqueueMutation(bookId, async () => {
      const ledger = await this.readLedger(bookId);
      const nextRuns = updater(ledger.runs);
      await this.writeLedger(bookId, {
        schemaVersion: CHAPTER_RUN_SCHEMA_VERSION,
        runs: nextRuns,
      });
    });
  }

  private async readLedger(bookId: string): Promise<StoredChapterRunLedger> {
    const filePath = this.getLedgerPath(bookId);
    try {
      await access(filePath);
    } catch {
      return { schemaVersion: CHAPTER_RUN_SCHEMA_VERSION, runs: [] };
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<StoredChapterRunLedger>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) {
        return { schemaVersion: CHAPTER_RUN_SCHEMA_VERSION, runs: [] };
      }
      const runs = parsed.runs.filter((run): run is ChapterRunRecord =>
        run !== null
        && typeof run === "object"
        && typeof run.runId === "string"
        && typeof run.bookId === "string"
        && typeof run.chapter === "number"
        && VALID_ACTION_TYPES.includes(run.actionType as ChapterRunActionType)
        && VALID_STATUSES.includes(run.status as ChapterRunStatus)
        && (run.decision === null || VALID_DECISIONS.includes(run.decision as ChapterRunDecision))
        && Array.isArray(run.events),
      );
      return { schemaVersion: CHAPTER_RUN_SCHEMA_VERSION, runs };
    } catch {
      return { schemaVersion: CHAPTER_RUN_SCHEMA_VERSION, runs: [] };
    }
  }

  private async writeLedger(bookId: string, ledger: StoredChapterRunLedger): Promise<void> {
    const filePath = this.getLedgerPath(bookId);
    await mkdir(join(this.resolveBookDir(bookId), ".studio"), { recursive: true });
    await writeFile(filePath, JSON.stringify(ledger, null, 2), "utf-8");
  }

  private getLedgerPath(bookId: string): string {
    return join(this.resolveBookDir(bookId), ".studio", "chapter-runs.v1.json");
  }

  private resolveDecision(
    run: ChapterRunRecord,
    input: {
      readonly status: "succeeded" | "failed";
      readonly decision?: ChapterRunDecision | null;
    },
  ): ChapterRunDecision | null {
    if (input.decision !== undefined) return input.decision;
    if (input.status === "failed") return "failed";
    return run.decision;
  }

  private async waitForPendingMutations(bookId: string): Promise<void> {
    const pending = this.bookMutations.get(bookId);
    if (pending) {
      await pending.catch(() => undefined);
    }
  }

  private isRunDeleted(run: ChapterRunRecord): boolean {
    return run.deletedAt !== undefined && run.deletedAt !== null;
  }

  private isRunActive(run: ChapterRunRecord): boolean {
    return !this.isRunDeleted(run);
  }

  private async enqueueMutation(bookId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.bookMutations.get(bookId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation);
    this.bookMutations.set(bookId, next);
    try {
      await next;
    } finally {
      if (this.bookMutations.get(bookId) === next) {
        this.bookMutations.delete(bookId);
      }
    }
  }
}

export function inferRunDecision(status: ChapterRunStatus, applied: unknown): ChapterRunDecision {
  if (status === "failed") return "failed";
  if (applied === true) return "applied";
  if (applied === false) return "unchanged";
  return "applied";
}
