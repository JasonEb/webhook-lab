import { describe, expect, it } from "vitest";
import { decideFault, parseFaultMode } from "./faultInjector.js";

describe("parseFaultMode", () => {
  it("parses none / undefined", () => {
    expect(parseFaultMode(undefined)).toEqual({ type: "none" });
    expect(parseFaultMode("none")).toEqual({ type: "none" });
  });

  it("parses fail_first:N", () => {
    expect(parseFaultMode("fail_first:3")).toEqual({ type: "fail_first", n: 3 });
  });

  it("parses slow:MS", () => {
    expect(parseFaultMode("slow:2000")).toEqual({ type: "slow", ms: 2000 });
  });

  it("parses status:CODE:N", () => {
    expect(parseFaultMode("status:429:2")).toEqual({ type: "status", code: 429, n: 2 });
  });

  it("parses status:CODE with default n=1", () => {
    expect(parseFaultMode("status:503")).toEqual({ type: "status", code: 503, n: 1 });
  });

  it("throws on an invalid string", () => {
    expect(() => parseFaultMode("bogus")).toThrow();
    expect(() => parseFaultMode("fail_first:not-a-number")).toThrow();
  });
});

describe("decideFault", () => {
  it("fail_first:3 faults attempts 0, 1, 2 and passes attempt 3+", () => {
    const mode = { type: "fail_first" as const, n: 3 };
    expect(decideFault(mode, 0)).toEqual({ statusCode: 500, delayMs: 0 });
    expect(decideFault(mode, 1)).toEqual({ statusCode: 500, delayMs: 0 });
    expect(decideFault(mode, 2)).toEqual({ statusCode: 500, delayMs: 0 });
    expect(decideFault(mode, 3)).toEqual({ statusCode: null, delayMs: 0 });
  });

  it("status:429:2 faults attempts 0, 1 with the given code and passes attempt 2+", () => {
    const mode = { type: "status" as const, code: 429, n: 2 };
    expect(decideFault(mode, 0)).toEqual({ statusCode: 429, delayMs: 0 });
    expect(decideFault(mode, 1)).toEqual({ statusCode: 429, delayMs: 0 });
    expect(decideFault(mode, 2)).toEqual({ statusCode: null, delayMs: 0 });
  });

  it("slow:MS never faults, always delays", () => {
    const mode = { type: "slow" as const, ms: 100 };
    expect(decideFault(mode, 0)).toEqual({ statusCode: null, delayMs: 100 });
    expect(decideFault(mode, 50)).toEqual({ statusCode: null, delayMs: 100 });
  });

  it("none never faults, never delays", () => {
    expect(decideFault({ type: "none" }, 0)).toEqual({ statusCode: null, delayMs: 0 });
  });
});
