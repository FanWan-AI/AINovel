/**
 * CreateFlow service — handles confirm-create logic for POST /api/v2/books/create/confirm.
 * Reuses buildStudioBookConfig from book-create.ts to avoid duplication.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildStudioBookConfig } from "../book-create.js";
import type { ConfirmCreateRequest, CreateMode, CreativeBrief } from "../schemas/create-flow-schema.js";
import type { StudioBookConfigDraft } from "../book-create.js";

export interface CreateFlowServiceDeps {
  readonly bookDir: (bookId: string) => string;
  readonly broadcast: (event: string, data: unknown) => void;
  readonly bookCreateStatus: Map<string, { status: "creating" | "error"; error?: string }>;
  /** Caller is responsible for passing externalContext into the pipeline config. */
  readonly initBook: (bookConfig: StudioBookConfigDraft) => Promise<void>;
}

/**
 * Checks whether a book with the given ID has already been fully initialized.
 * Returns true if both book.json and story_bible.md are present.
 */
async function isBookAlreadyCreated(bookDir: string): Promise<boolean> {
  try {
    await access(join(bookDir, "book.json"));
    await access(join(bookDir, "story", "story_bible.md"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Persists the brief as an external context file in the book directory so that
 * PipelineRunner can use it as `externalContext` during initBook.
 */
async function persistBrief(bookDir: string, brief: CreativeBrief, mode: CreateMode): Promise<void> {
  const briefDir = join(bookDir, "story", "brief");
  await mkdir(briefDir, { recursive: true });

  const now = new Date().toISOString();

  const normalizedJson = JSON.stringify(brief, null, 2);
  await writeFile(join(briefDir, "normalized_brief.json"), normalizedJson, "utf-8");

  const versionEntry = JSON.stringify({ version: 1, at: now, source: "confirm", mode, brief }) + "\n";
  await writeFile(join(briefDir, "brief_versions.jsonl"), versionEntry, "utf-8");
}

/**
 * Serializes a brief to a markdown-friendly string for use as externalContext.
 */
export function briefToExternalContext(brief: CreativeBrief | string): string {
  return typeof brief === "string" ? brief : JSON.stringify(brief, null, 2);
}

/**
 * Executes the confirm-create flow:
 * 1. Derives the bookConfig from the request.
 * 2. Checks for conflicts (409 if already exists).
 * 3. Checks for in-progress creation (returns existing "creating" status).
 * 4. Persists the brief (if provided).
 * 5. Fires off initBook asynchronously.
 *
 * Returns `{ bookId }` on success; throws on conflict.
 */
export async function confirmCreateBook(
  request: ConfirmCreateRequest,
  deps: CreateFlowServiceDeps,
): Promise<{ bookId: string }> {
  const now = new Date().toISOString();
  const bookConfig = buildStudioBookConfig(request.bookConfig, now);
  const bookId = bookConfig.id;
  const bookDir = deps.bookDir(bookId);

  // Conflict check — return 409 if a complete book already exists
  if (await isBookAlreadyCreated(bookDir)) {
    const err = new Error(`Book "${bookId}" already exists`);
    (err as NodeJS.ErrnoException).code = "BOOK_CREATE_CONFLICT";
    throw err;
  }

  // Idempotency — if the same book is already being created, return current status
  if (deps.bookCreateStatus.get(bookId)?.status === "creating") {
    return { bookId };
  }

  // Persist brief for traceability before kicking off the pipeline
  if (request.brief) {
    await persistBrief(bookDir, request.brief, request.mode ?? "simple");
  }

  deps.broadcast("book:creating", { bookId, title: request.bookConfig.title });
  deps.bookCreateStatus.set(bookId, { status: "creating" });

  deps.initBook(bookConfig).then(
    () => {
      deps.bookCreateStatus.delete(bookId);
      deps.broadcast("book:created", { bookId });
    },
    (e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      deps.bookCreateStatus.set(bookId, { status: "error", error });
      deps.broadcast("book:error", { bookId, error });
    },
  );

  return { bookId };
}
