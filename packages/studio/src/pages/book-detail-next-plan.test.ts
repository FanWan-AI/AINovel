import { describe, expect, it, vi } from "vitest";
import {
  classifyNextPlanError,
  buildApplyBrief,
} from "../components/write-next/NextPlanPanel";
import { fetchNextPlan } from "../hooks/use-api";
import type { NextPlanResult } from "../hooks/use-api";

// ---------------------------------------------------------------------------
// classifyNextPlanError
// ---------------------------------------------------------------------------

describe("classifyNextPlanError", () => {
  it("maps HTTP 403 to the forbidden error kind", () => {
    expect(classifyNextPlanError(403)).toBe("forbidden");
  });

  it("maps HTTP 429 to the rateLimit error kind", () => {
    expect(classifyNextPlanError(429)).toBe("rateLimit");
  });

  it("maps HTTP 500 to the serverError error kind", () => {
    expect(classifyNextPlanError(500)).toBe("serverError");
  });

  it("maps HTTP 409 to the lowConfidence error kind", () => {
    expect(classifyNextPlanError(409)).toBe("lowConfidence");
  });

  it("maps any other status to the unknown error kind", () => {
    expect(classifyNextPlanError(400)).toBe("unknown");
    expect(classifyNextPlanError(502)).toBe("unknown");
    expect(classifyNextPlanError(null)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// buildApplyBrief — result rendering
// ---------------------------------------------------------------------------

describe("buildApplyBrief", () => {
  const plan: NextPlanResult = {
    chapterNumber: 5,
    goal: "主角发现真相",
    conflicts: ["知道真相的代价是失去最亲近的人"],
  };

  it("joins goal and conflicts with a newline", () => {
    expect(buildApplyBrief(plan)).toBe("主角发现真相\n知道真相的代价是失去最亲近的人");
  });

  it("omits goal when empty", () => {
    expect(buildApplyBrief({ ...plan, goal: "" })).toBe(
      "知道真相的代价是失去最亲近的人",
    );
  });

  it("omits conflicts when empty", () => {
    expect(buildApplyBrief({ ...plan, conflicts: [] })).toBe("主角发现真相");
  });

  it("returns empty string when both fields are empty", () => {
    expect(buildApplyBrief({ ...plan, goal: "", conflicts: [] })).toBe("");
  });

  it("renders chapterNumber in the plan without throwing", () => {
    const result = buildApplyBrief({ chapterNumber: 12, goal: "G", conflicts: ["C"] });
    expect(result).toBe("G\nC");
  });
});

// ---------------------------------------------------------------------------
// fetchNextPlan — loading / error / result states
// ---------------------------------------------------------------------------

describe("fetchNextPlan", () => {
  it("resolves with the plan data on a successful response", async () => {
    const payload: NextPlanResult = {
      chapterNumber: 3,
      goal: "Introduce the antagonist",
      conflicts: ["The protagonist's loyalties are tested"],
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ plan: payload }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchNextPlan("book-1", { fetchImpl });
    expect(result).toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/books/book-1/next-plan",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws when the API returns a non-ok status (error state)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Plan generation failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchNextPlan("book-2", { fetchImpl })).rejects.toThrow(
      "Plan generation failed",
    );
  });

  it("throws an ApiError with the correct status on HTTP errors", async () => {
    const { ApiError } = await import("../hooks/use-api");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const error = await fetchNextPlan("book-3", { fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(404);
  });

  it("throws ApiError with status 409 when the server returns PLAN_LOW_CONFIDENCE", async () => {
    const { ApiError } = await import("../hooks/use-api");
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "PLAN_LOW_CONFIDENCE", message: "建议质量不足，请补充关键冲突后再试。" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    const error = await fetchNextPlan("book-4", { fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(409);
    // classifyNextPlanError should map 409 → lowConfidence
    expect(classifyNextPlanError((error as InstanceType<typeof ApiError>).status)).toBe("lowConfidence");
  });
});

// ---------------------------------------------------------------------------
// apply action — verifies the brief is correctly assembled for write-next
// ---------------------------------------------------------------------------

describe("apply next plan action", () => {
  it("builds a non-empty brief when plan has goal and conflicts", () => {
    const plan: NextPlanResult = {
      chapterNumber: 7,
      goal: "Climax showdown",
      conflicts: ["Hero vs villain — no going back"],
    };
    const brief = buildApplyBrief(plan);
    expect(brief.length).toBeGreaterThan(0);
    expect(brief).toContain(plan.goal);
    expect(brief).toContain(plan.conflicts[0]);
  });

  it("does not crash when plan has minimal data", () => {
    const plan: NextPlanResult = { chapterNumber: 1, goal: "", conflicts: [] };
    expect(() => buildApplyBrief(plan)).not.toThrow();
  });
});
