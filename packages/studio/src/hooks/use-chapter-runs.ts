import { useCallback, useEffect, useMemo, useState } from "react";
import type { StringKey } from "./use-i18n";

export type ChapterRunActionType = "spot-fix" | "polish" | "rework" | "rewrite" | "anti-detect" | "resync";
export type ChapterRunStatus = "running" | "success" | "failed" | "unchanged";
export type ChapterLifecycleAction = "revise" | "rewrite" | "anti-detect" | "resync";
export type ChapterLifecycleStage = "success" | "fail" | "unchanged";

export interface ChapterRunRecord {
  readonly id: string;
  readonly chapterNumber: number;
  readonly actionType: ChapterRunActionType;
  readonly status: ChapterRunStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
  readonly briefSummary?: string;
  readonly reason?: string;
}

interface StartChapterRunInput {
  readonly chapterNumber: number;
  readonly actionType: ChapterRunActionType;
  readonly briefSummary?: string;
}

interface FinishChapterRunInput {
  readonly runId: string;
  readonly status: ChapterRunStatus;
  readonly reason?: string;
  readonly briefSummary?: string;
  readonly finishedAt?: number;
}

interface LifecycleUpdateInput {
  readonly chapterNumber: number;
  readonly action: ChapterLifecycleAction;
  readonly stage: ChapterLifecycleStage;
  readonly reason?: string;
  readonly briefSummary?: string;
  readonly timestamp?: number;
}

const STORAGE_PREFIX = "inkos-chapter-runs-v1";
const MAX_STORED_RUNS = 200;
const DEDUP_WINDOW_MS = 60_000;

function keyForBook(bookId: string): string {
  return `${STORAGE_PREFIX}:${bookId}`;
}

function toDuration(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function trimSummary(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function normalizeRuns(data: unknown): ReadonlyArray<ChapterRunRecord> {
  if (!Array.isArray(data)) return [];
  const runs: ChapterRunRecord[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<ChapterRunRecord>;
    if (
      typeof entry.id !== "string"
      || typeof entry.chapterNumber !== "number"
      || typeof entry.actionType !== "string"
      || typeof entry.status !== "string"
      || typeof entry.startedAt !== "number"
    ) {
      continue;
    }
    runs.push({
      id: entry.id,
      chapterNumber: entry.chapterNumber,
      actionType: entry.actionType as ChapterRunActionType,
      status: entry.status as ChapterRunStatus,
      startedAt: entry.startedAt,
      finishedAt: typeof entry.finishedAt === "number" ? entry.finishedAt : undefined,
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
      briefSummary: trimSummary(entry.briefSummary),
      reason: trimSummary(entry.reason),
    });
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_STORED_RUNS);
}

export function loadChapterRuns(
  bookId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): { runs: ReadonlyArray<ChapterRunRecord>; error: StringKey | null } {
  try {
    const raw = storage.getItem(keyForBook(bookId));
    if (!raw) return { runs: [], error: null };
    return { runs: normalizeRuns(JSON.parse(raw)), error: null };
  } catch {
    return { runs: [], error: "chapterTaskCenter.storageReadFailed" };
  }
}

export function saveChapterRuns(
  bookId: string,
  runs: ReadonlyArray<ChapterRunRecord>,
  storage: Pick<Storage, "setItem"> = localStorage,
): StringKey | null {
  try {
    storage.setItem(keyForBook(bookId), JSON.stringify(runs.slice(0, MAX_STORED_RUNS)));
    return null;
  } catch {
    return "chapterTaskCenter.storageWriteFailed";
  }
}

export function mapLifecycleActionTypes(action: ChapterLifecycleAction): ReadonlyArray<ChapterRunActionType> {
  if (action === "rewrite") return ["rewrite"];
  if (action === "anti-detect") return ["anti-detect"];
  if (action === "resync") return ["resync"];
  return ["spot-fix", "polish", "rework", "rewrite", "anti-detect"];
}

function asRunStatus(stage: ChapterLifecycleStage): Exclude<ChapterRunStatus, "running"> {
  if (stage === "fail") return "failed";
  return stage;
}

export function createChapterRunId(): string {
  return `chapter-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertLifecycleRun(
  prev: ReadonlyArray<ChapterRunRecord>,
  input: LifecycleUpdateInput,
): ReadonlyArray<ChapterRunRecord> {
  const actionTypes = mapLifecycleActionTypes(input.action);
  const status = asRunStatus(input.stage);
  const finishedAt = input.timestamp ?? Date.now();
  const reason = trimSummary(input.reason);
  const briefSummary = trimSummary(input.briefSummary);

  const runningIndex = prev.findIndex((run) => (
    run.chapterNumber === input.chapterNumber
    && actionTypes.includes(run.actionType)
    && run.status === "running"
  ));

  const recentIndex = runningIndex >= 0
    ? runningIndex
    : prev.findIndex((run) => (
      run.chapterNumber === input.chapterNumber
      && actionTypes.includes(run.actionType)
      && Math.abs(finishedAt - run.startedAt) <= DEDUP_WINDOW_MS
    ));

  if (recentIndex >= 0) {
    const target = prev[recentIndex];
    const next: ChapterRunRecord = {
      ...target,
      status,
      finishedAt,
      durationMs: toDuration(target.startedAt, finishedAt),
      reason,
      briefSummary: briefSummary ?? target.briefSummary,
    };
    const merged = [...prev];
    merged[recentIndex] = next;
    return merged.sort((a, b) => b.startedAt - a.startedAt);
  }

  const actionType = actionTypes[0] ?? "spot-fix";
  const newRun: ChapterRunRecord = {
    id: createChapterRunId(),
    chapterNumber: input.chapterNumber,
    actionType,
    status,
    startedAt: finishedAt,
    finishedAt,
    durationMs: 0,
    reason,
    briefSummary,
  };
  return [newRun, ...prev].slice(0, MAX_STORED_RUNS);
}

export function useChapterRuns(bookId: string) {
  const [runs, setRuns] = useState<ReadonlyArray<ChapterRunRecord>>([]);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<StringKey | null>(null);

  useEffect(() => {
    setLoading(true);
    const loaded = loadChapterRuns(bookId);
    setRuns(loaded.runs);
    setErrorKey(loaded.error);
    setLoading(false);
  }, [bookId]);

  useEffect(() => {
    if (loading) return;
    const nextError = saveChapterRuns(bookId, runs);
    if (nextError) setErrorKey(nextError);
  }, [bookId, loading, runs]);

  const startRun = useCallback(({ chapterNumber, actionType, briefSummary }: StartChapterRunInput): string => {
    const startedAt = Date.now();
    const id = createChapterRunId();
    const newRun: ChapterRunRecord = {
      id,
      chapterNumber,
      actionType,
      status: "running",
      startedAt,
      briefSummary: trimSummary(briefSummary),
    };
    setRuns((prev) => [newRun, ...prev].slice(0, MAX_STORED_RUNS));
    return id;
  }, []);

  const finishRun = useCallback(({ runId, status, reason, briefSummary, finishedAt }: FinishChapterRunInput) => {
    const endedAt = finishedAt ?? Date.now();
    setRuns((prev) => prev.map((run) => {
      if (run.id !== runId) return run;
      return {
        ...run,
        status,
        finishedAt: endedAt,
        durationMs: toDuration(run.startedAt, endedAt),
        reason: trimSummary(reason),
        briefSummary: trimSummary(briefSummary) ?? run.briefSummary,
      };
    }));
  }, []);

  const applyLifecycleUpdate = useCallback((input: LifecycleUpdateInput) => {
    setRuns((prev) => upsertLifecycleRun(prev, input));
  }, []);

  const chapterOptions = useMemo(() => {
    const unique = new Set<number>();
    for (const run of runs) unique.add(run.chapterNumber);
    return [...unique].sort((a, b) => a - b);
  }, [runs]);

  const retryLoad = useCallback(() => {
    const loaded = loadChapterRuns(bookId);
    setRuns(loaded.runs);
    setErrorKey(loaded.error);
  }, [bookId]);

  return {
    runs,
    loading,
    errorKey,
    chapterOptions,
    startRun,
    finishRun,
    applyLifecycleUpdate,
    retryLoad,
  };
}
