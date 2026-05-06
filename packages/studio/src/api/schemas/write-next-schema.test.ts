import { describe, expect, it } from "vitest";
import { validateWriteNextInput } from "./write-next-schema";

describe("validateWriteNextInput chapterCount", () => {
  it("accepts quick chapter counts from 1 to 6", () => {
    for (const chapterCount of [1, 2, 3, 4, 5, 6]) {
      const result = validateWriteNextInput({ mode: "quick", chapterCount });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.chapterCount).toBe(chapterCount);
    }
  });

  it("rejects chapter counts outside 1 to 6", () => {
    for (const chapterCount of [0, 7, 1.5, "3"]) {
      const result = validateWriteNextInput({ mode: "quick", chapterCount });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: "chapterCount" }),
          ]),
        );
      }
    }
  });
});
