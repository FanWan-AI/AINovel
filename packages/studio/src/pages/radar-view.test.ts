import { describe, expect, it, vi } from "vitest";
import {
  classifyRadarError,
  buildDiagnosticCommand,
  copyDiagnosticCommand,
} from "./RadarView";

// ---------------------------------------------------------------------------
// classifyRadarError
// ---------------------------------------------------------------------------

describe("classifyRadarError", () => {
  it("maps HTTP 403 to the forbidden error type", () => {
    expect(classifyRadarError(403)).toBe("forbidden");
  });

  it("maps HTTP 429 to the rateLimit error type", () => {
    expect(classifyRadarError(429)).toBe("rateLimit");
  });

  it("maps HTTP 500 to the serverError error type", () => {
    expect(classifyRadarError(500)).toBe("serverError");
  });

  it("maps any other status to the unknown error type", () => {
    expect(classifyRadarError(502)).toBe("unknown");
    expect(classifyRadarError(400)).toBe("unknown");
    expect(classifyRadarError(null)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// buildDiagnosticCommand
// ---------------------------------------------------------------------------

describe("buildDiagnosticCommand", () => {
  it("returns the inkos doctor command string", () => {
    expect(buildDiagnosticCommand()).toBe("pnpm inkos doctor");
  });
});

// ---------------------------------------------------------------------------
// copyDiagnosticCommand
// ---------------------------------------------------------------------------

describe("copyDiagnosticCommand", () => {
  it("writes the diagnostic command to the clipboard", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    await copyDiagnosticCommand({ clipboardImpl: { writeText } });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(buildDiagnosticCommand());
  });

  it("copies the exact same value that buildDiagnosticCommand returns", async () => {
    let captured = "";
    const writeText = vi.fn(async (text: string) => {
      captured = text;
    });

    await copyDiagnosticCommand({ clipboardImpl: { writeText } });

    expect(captured).toBe(buildDiagnosticCommand());
  });
});
