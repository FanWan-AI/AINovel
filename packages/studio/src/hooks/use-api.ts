import { useState, useEffect, useCallback } from "react";

const BASE = "/api";
const API_INVALIDATE_EVENT = "inkos:api-invalidate";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiInvalidateDetail {
  readonly paths: ReadonlyArray<string>;
}

interface FieldErrorShape {
  readonly field?: unknown;
  readonly message?: unknown;
}

export function buildApiUrl(path: string): string | null {
  const normalized = String(path ?? "").trim();
  if (!normalized) return null;
  if (normalized.startsWith(`${BASE}/`) || normalized === BASE) {
    return normalized;
  }
  return normalized.startsWith("/") ? `${BASE}${normalized}` : `${BASE}/${normalized}`;
}

export function deriveInvalidationPaths(path: string): ReadonlyArray<string> {
  const normalized = buildApiUrl(path);
  if (!normalized) return [];

  if (normalized === "/api/books/create") {
    return ["/api/books"];
  }

  if (normalized === "/api/v2/books/create/confirm") {
    return ["/api/books"];
  }

  if (normalized === "/api/project") {
    return ["/api/project"];
  }

  if (normalized.startsWith("/api/project/")) {
    return ["/api/project", normalized];
  }

  const bookAction = normalized.match(/^\/api\/books\/([^/]+)\/(write-next|draft)$/);
  if (bookAction) {
    return ["/api/books", `/api/books/${bookAction[1]}`];
  }

  const chapterAction = normalized.match(/^\/api\/books\/([^/]+)\/chapters\/\d+\/(approve|reject)$/);
  if (chapterAction) {
    return ["/api/books", `/api/books/${chapterAction[1]}`];
  }

  const bookUpdate = normalized.match(/^\/api\/books\/([^/]+)$/);
  if (bookUpdate) {
    return ["/api/books", `/api/books/${bookUpdate[1]}`];
  }

  if (/^\/api\/daemon\/(start|stop)$/.test(normalized)) {
    return ["/api/daemon"];
  }

  return [];
}

export function invalidateApiPaths(paths: ReadonlyArray<string>): void {
  if (!paths.length || typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<ApiInvalidateDetail>(API_INVALIDATE_EVENT, {
    detail: { paths: [...new Set(paths)] },
  }));
}

async function readErrorMessage(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = await res.json() as { error?: unknown };
      if (typeof json.error === "string" && json.error.trim()) {
        return json.error;
      }
      if (
        json.error &&
        typeof json.error === "object" &&
        "message" in json.error &&
        typeof (json.error as { message?: unknown }).message === "string" &&
        (json.error as { message: string }).message.trim()
      ) {
        return (json.error as { message: string }).message;
      }
      if (
        "errors" in json &&
        Array.isArray((json as { errors?: unknown }).errors)
      ) {
        const parsed = ((json as { errors: FieldErrorShape[] }).errors)
          .map((err) => {
            const field = typeof err.field === "string" ? err.field : "";
            const message = typeof err.message === "string" ? err.message : "";
            if (!message) return "";
            return field ? `${field}: ${message}` : message;
          })
          .filter((line) => line.length > 0);
        if (parsed.length > 0) {
          return parsed.join("; ");
        }
      }
    } catch {
      // fall through
    }
  }
  return `${res.status} ${res.statusText}`.trim();
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<T> {
  const url = buildApiUrl(path);
  if (!url) {
    throw new Error("API path is required");
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(url, init);

  if (!res.ok) {
    throw new ApiError(await readErrorMessage(res), res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  return await res.json() as T;
}

export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const url = buildApiUrl(path);
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const json = await fetchJson<T>(url);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const url = buildApiUrl(path);
    if (!url || typeof window === "undefined") {
      return;
    }

    const handleInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<ApiInvalidateDetail>).detail;
      if (!detail?.paths.includes(url)) return;
      void refetch();
    };

    window.addEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    return () => {
      window.removeEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    };
  }, [path, refetch]);

  return { data, loading, error, refetch };
}

export async function postApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export async function putApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export interface NextPlanResult {
  readonly chapterNumber: number;
  readonly goal: string;
  readonly conflicts: string[];
}

export async function fetchNextPlan(
  bookId: string,
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<NextPlanResult> {
  const response = await fetchJson<{ readonly plan: NextPlanResult }>(`/books/${bookId}/next-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, deps);
  return response.plan;
}

export async function normalizeBrief(payload: {
  readonly mode: "simple" | "pro";
  readonly title: string;
  readonly rawInput: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
}): Promise<{
  readonly briefId: string;
  readonly normalizedBrief: {
    readonly title: string;
    readonly coreGenres: string[];
    readonly positioning: string;
    readonly worldSetting: string;
    readonly protagonist: string;
    readonly mainConflict: string;
    readonly endingDirection?: string;
    readonly styleRules: string[];
    readonly forbiddenPatterns: string[];
    readonly targetAudience?: string;
    readonly platformIntent?: string;
  };
}> {
  return postApi("/v2/books/create/brief/normalize", payload);
}
