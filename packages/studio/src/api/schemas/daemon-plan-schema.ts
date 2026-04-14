import { isSafeBookId } from "../safety.js";

export type DaemonPlanMode = "managed-default" | "custom-plan";

export type DaemonPlanBookScope =
  | { readonly type: "all-active" }
  | { readonly type: "book-list"; readonly bookIds: ReadonlyArray<string> };

export interface DaemonPlanInput {
  readonly mode: DaemonPlanMode;
  readonly bookScope: DaemonPlanBookScope;
  readonly perBookChapterCap?: number;
  readonly globalChapterCap?: number;
}

export interface DaemonPlanRequest {
  readonly planId?: string;
  readonly plan: DaemonPlanInput;
}

export interface DaemonStartRequest {
  readonly planId?: string;
  readonly default?: true;
}

export interface DaemonValidationError {
  readonly field: string;
  readonly message: string;
}

interface DaemonValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

interface DaemonValidationFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<DaemonValidationError>;
}

export type DaemonValidation<T> = DaemonValidationSuccess<T> | DaemonValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  return Number.isInteger(raw) && typeof raw === "number" && raw > 0 ? raw : undefined;
}

function parseBookScope(
  raw: unknown,
  errors: DaemonValidationError[],
): DaemonPlanBookScope | undefined {
  if (!isRecord(raw)) {
    errors.push({ field: "plan.bookScope", message: "plan.bookScope must be an object" });
    return undefined;
  }

  const scopeType = raw["type"];
  if (scopeType === "all-active") {
    return { type: "all-active" };
  }

  if (scopeType === "book-list") {
    const rawBookIds = raw["bookIds"];
    if (!Array.isArray(rawBookIds) || rawBookIds.length === 0) {
      errors.push({ field: "plan.bookScope.bookIds", message: "bookIds must be a non-empty array" });
      return undefined;
    }
    const invalid = rawBookIds.find((bookId) => typeof bookId !== "string" || !isSafeBookId(bookId));
    if (invalid !== undefined) {
      errors.push({ field: "plan.bookScope.bookIds", message: "bookIds contains invalid book id" });
      return undefined;
    }
    const normalizedBookIds = Array.from(new Set(rawBookIds as string[]));
    return { type: "book-list", bookIds: normalizedBookIds };
  }

  errors.push({
    field: "plan.bookScope.type",
    message: "plan.bookScope.type must be one of: all-active, book-list",
  });
  return undefined;
}

export function validateDaemonPlanRequest(body: unknown): DaemonValidation<DaemonPlanRequest> {
  if (!isRecord(body)) {
    return {
      ok: false,
      errors: [{ field: "body", message: "Request body must be a JSON object" }],
    };
  }

  const errors: DaemonValidationError[] = [];
  const rawPlanId = body["planId"];
  let planId: string | undefined;
  if (rawPlanId !== undefined) {
    if (typeof rawPlanId !== "string" || rawPlanId.trim().length === 0) {
      errors.push({ field: "planId", message: "planId must be a non-empty string" });
    } else {
      planId = rawPlanId.trim();
    }
  }

  const rawPlan = body["plan"];
  if (!isRecord(rawPlan)) {
    errors.push({ field: "plan", message: "plan must be an object" });
  }

  const modeRaw = isRecord(rawPlan) ? rawPlan["mode"] : undefined;
  let mode: DaemonPlanMode | undefined;
  if (modeRaw === "managed-default" || modeRaw === "custom-plan") {
    mode = modeRaw;
  } else {
    errors.push({ field: "plan.mode", message: "plan.mode must be one of: managed-default, custom-plan" });
  }

  const scopeRaw = isRecord(rawPlan) ? rawPlan["bookScope"] : undefined;
  const bookScope = parseBookScope(scopeRaw ?? { type: "all-active" }, errors);

  const perBookChapterCap = parsePositiveInt(isRecord(rawPlan) ? rawPlan["perBookChapterCap"] : undefined);
  if (isRecord(rawPlan) && rawPlan["perBookChapterCap"] !== undefined && perBookChapterCap === undefined) {
    errors.push({ field: "plan.perBookChapterCap", message: "plan.perBookChapterCap must be a positive integer" });
  }

  const globalChapterCap = parsePositiveInt(isRecord(rawPlan) ? rawPlan["globalChapterCap"] : undefined);
  if (isRecord(rawPlan) && rawPlan["globalChapterCap"] !== undefined && globalChapterCap === undefined) {
    errors.push({ field: "plan.globalChapterCap", message: "plan.globalChapterCap must be a positive integer" });
  }

  if (errors.length > 0 || mode === undefined || bookScope === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      ...(planId !== undefined ? { planId } : {}),
      plan: {
        mode,
        bookScope,
        ...(perBookChapterCap !== undefined ? { perBookChapterCap } : {}),
        ...(globalChapterCap !== undefined ? { globalChapterCap } : {}),
      },
    },
  };
}

export function validateDaemonStartRequest(body: unknown): DaemonValidation<DaemonStartRequest> {
  if (body === null || body === undefined) {
    return { ok: true, value: { default: true } };
  }

  if (!isRecord(body)) {
    return {
      ok: false,
      errors: [{ field: "body", message: "Request body must be a JSON object" }],
    };
  }

  const errors: DaemonValidationError[] = [];
  const rawPlanId = body["planId"];
  let planId: string | undefined;
  if (rawPlanId !== undefined) {
    if (typeof rawPlanId !== "string" || rawPlanId.trim().length === 0) {
      errors.push({ field: "planId", message: "planId must be a non-empty string" });
    } else {
      planId = rawPlanId.trim();
    }
  }

  const rawDefault = body["default"];
  const wantsDefault = rawDefault === true || (rawDefault === undefined && planId === undefined);
  if (rawDefault !== undefined && rawDefault !== true) {
    errors.push({ field: "default", message: "default must be true when provided" });
  }

  if (planId !== undefined && wantsDefault) {
    errors.push({ field: "planId", message: "planId and default cannot be used together" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: planId !== undefined ? { planId } : { default: true } };
}
