import { describe, expect, it } from "vitest";
import { formatCost, outcomeLabel, outcomeColor } from "../src/components/views/prs/CostBanner";

describe("formatCost", () => {
  it("formats $0 as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats tiny cost below $0.0001 as < $0.0001", () => {
    expect(formatCost(0.00005)).toBe("< $0.0001");
    expect(formatCost(0.00001)).toBe("< $0.0001");
  });

  it("formats sub-cent values with 4 decimal places", () => {
    expect(formatCost(0.0005)).toBe("$0.0005");
    expect(formatCost(0.0012)).toBe("$0.0012");
    expect(formatCost(0.0099)).toBe("$0.0099");
  });

  it("formats cent values with 2 decimal places", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.10)).toBe("$0.10");
    expect(formatCost(0.42)).toBe("$0.42");
  });

  it("formats dollar values with 2 decimal places", () => {
    expect(formatCost(1.0)).toBe("$1.00");
    expect(formatCost(12.34)).toBe("$12.34");
    expect(formatCost(123.45)).toBe("$123.45");
  });
});

describe("outcomeLabel", () => {
  it("returns a human-friendly label for known outcomes", () => {
    expect(outcomeLabel("success")).toBe("Success");
    expect(outcomeLabel("quality_failure")).toBe("Quality fail");
    expect(outcomeLabel("transport_failure")).toBe("Transport fail");
    expect(outcomeLabel("interrupted")).toBe("Interrupted");
    expect(outcomeLabel("unknown_failure")).toBe("Unknown fail");
  });

  it("passes through unknown outcomes verbatim", () => {
    expect(outcomeLabel("something_else")).toBe("something_else");
  });
});

describe("outcomeColor", () => {
  it("returns emerald for success", () => {
    expect(outcomeColor("success")).toBe("text-emerald-400");
  });

  it("returns amber for quality_failure", () => {
    expect(outcomeColor("quality_failure")).toBe("text-amber-400");
  });

  it("returns rose for transport_failure", () => {
    expect(outcomeColor("transport_failure")).toBe("text-rose-400");
  });

  it("returns slate for interrupted", () => {
    expect(outcomeColor("interrupted")).toBe("text-slate-400");
  });

  it("returns rose for unknown_failure", () => {
    expect(outcomeColor("unknown_failure")).toBe("text-rose-400");
  });

  it("defaults to slate-400 for unknown outcomes", () => {
    expect(outcomeColor("bogus")).toBe("text-slate-400");
  });
});
