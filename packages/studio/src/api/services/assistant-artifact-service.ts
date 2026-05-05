/**
 * Assistant Artifact Memory — persists every important LLM analysis as a
 * structured artifact so subsequent turns can reference it by id.
 *
 * Storage: one JSONL file per session + one per book.
 *   .inkos/assistant-artifacts/{sessionId}.jsonl
 *   books/{bookId}/runtime/assistant-artifacts.jsonl
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export type AssistantArtifactType =
  | "plot_critique"
  | "chapter_plan"
  | "chapter_steering_contract"
  | "chapter_blueprint"
  | "story_graph_patch"
  | "impact_analysis"
  | "quality_report"
  | "contract_verification"
  | "blueprint_fulfillment_report"
  | "editor_report";

export interface AssistantArtifact {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly bookId?: string;
  readonly type: AssistantArtifactType;
  readonly title: string;
  readonly createdAt: string;
  readonly sourceMessageIds: ReadonlyArray<string>;
  readonly payload: Record<string, unknown>;
  readonly summary: string;
  readonly searchableText: string;
}

export interface AssistantArtifactSummary {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly bookId?: string;
  readonly type: AssistantArtifactType;
  readonly title: string;
  readonly createdAt: string;
  readonly summary: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function generateArtifactId(): string {
  const hex = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `art_${hex}`;
}

function toSummary(a: AssistantArtifact): AssistantArtifactSummary {
  return {
    artifactId: a.artifactId,
    sessionId: a.sessionId,
    bookId: a.bookId,
    type: a.type,
    title: a.title,
    createdAt: a.createdAt,
    summary: a.summary,
  };
}

// ── Store ──────────────────────────────────────────────────────────────

async function appendArtifactJsonl(filePath: string, artifact: AssistantArtifact): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await appendFile(filePath, JSON.stringify(artifact) + "\n", "utf-8");
}

async function readRecentArtifactsJsonl(
  filePath: string,
  limit: number,
): Promise<AssistantArtifact[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n").filter((l) => l.length > 0);
    const artifacts: AssistantArtifact[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        artifacts.push(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
    return artifacts.reverse();
  } catch {
    return [];
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export interface AssistantArtifactServiceOptions {
  readonly artifactsRoot: string;
  readonly booksRoot: string;
  readonly now?: () => string;
}

export class AssistantArtifactService {
  private readonly root: string;
  private readonly booksRoot: string;
  private readonly now: () => string;

  constructor(opts: AssistantArtifactServiceOptions) {
    this.root = opts.artifactsRoot;
    this.booksRoot = opts.booksRoot;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async create(input: {
    readonly sessionId: string;
    readonly bookId?: string;
    readonly type: AssistantArtifactType;
    readonly title: string;
    readonly sourceMessageIds?: ReadonlyArray<string>;
    readonly payload: Record<string, unknown>;
    readonly summary: string;
    readonly searchableText: string;
  }): Promise<AssistantArtifact> {
    const artifact: AssistantArtifact = {
      artifactId: generateArtifactId(),
      sessionId: input.sessionId,
      ...(input.bookId ? { bookId: input.bookId } : {}),
      type: input.type,
      title: input.title,
      createdAt: this.now(),
      sourceMessageIds: input.sourceMessageIds ?? [],
      payload: input.payload,
      summary: input.summary,
      searchableText: input.searchableText,
    };

    const sessionPath = join(this.root, `${input.sessionId}.jsonl`);
    await appendArtifactJsonl(sessionPath, artifact);

    if (input.bookId) {
      const bookPath = join(this.booksRoot, input.bookId, "runtime", "assistant-artifacts.jsonl");
      await appendArtifactJsonl(bookPath, artifact);
    }

    return artifact;
  }

  async listRecentSessionArtifacts(sessionId: string, limit = 20): Promise<AssistantArtifactSummary[]> {
    const sessionPath = join(this.root, `${sessionId}.jsonl`);
    const artifacts = await readRecentArtifactsJsonl(sessionPath, limit);
    return artifacts.map(toSummary);
  }

  async listRecentBookArtifacts(bookId: string, limit = 20): Promise<AssistantArtifactSummary[]> {
    const bookPath = join(this.booksRoot, bookId, "runtime", "assistant-artifacts.jsonl");
    const artifacts = await readRecentArtifactsJsonl(bookPath, limit);
    return artifacts.map(toSummary);
  }

  async getById(artifactId: string, sessionId: string, bookId?: string): Promise<AssistantArtifact | null> {
    const sessionPath = join(this.root, `${sessionId}.jsonl`);
    const sessionArtifacts = await readRecentArtifactsJsonl(sessionPath, 500);
    const inSession = sessionArtifacts.find((a) => a.artifactId === artifactId);
    if (inSession) return inSession;

    if (bookId) {
      const bookPath = join(this.booksRoot, bookId, "runtime", "assistant-artifacts.jsonl");
      const bookArtifacts = await readRecentArtifactsJsonl(bookPath, 500);
      const inBook = bookArtifacts.find((a) => a.artifactId === artifactId);
      if (inBook) return inBook;
    }

    return null;
  }

  async listByType(
    sessionId: string,
    type: AssistantArtifactType,
    limit = 10,
  ): Promise<AssistantArtifactSummary[]> {
    const sessionPath = join(this.root, `${sessionId}.jsonl`);
    const artifacts = await readRecentArtifactsJsonl(sessionPath, 100);
    return artifacts
      .filter((a) => a.type === type)
      .slice(0, limit)
      .map(toSummary);
  }

  /**
   * Append an updated version of an existing artifact with the same artifactId.
   * Because storage is append-only, `getById` (which reads in reverse order) will
   * return this newer entry on the next lookup.
   * Returns null if the artifact does not exist in the session.
   */
  async update(
    artifactId: string,
    sessionId: string,
    input: {
      readonly bookId?: string;
      readonly payload: Record<string, unknown>;
      readonly summary: string;
      readonly searchableText: string;
    },
  ): Promise<AssistantArtifact | null> {
    const existing = await this.getById(artifactId, sessionId, input.bookId);
    if (!existing) return null;

    const updated: AssistantArtifact = {
      ...existing,
      payload: input.payload,
      summary: input.summary,
      searchableText: input.searchableText,
      createdAt: this.now(),
    };

    const sessionPath = join(this.root, `${sessionId}.jsonl`);
    await appendArtifactJsonl(sessionPath, updated);

    const effectiveBookId = input.bookId ?? existing.bookId;
    if (effectiveBookId) {
      const bookPath = join(this.booksRoot, effectiveBookId, "runtime", "assistant-artifacts.jsonl");
      await appendArtifactJsonl(bookPath, updated);
    }

    return updated;
  }
}
