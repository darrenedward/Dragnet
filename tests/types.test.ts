import { describe, it, expect } from "vitest";
import { getPullRequestStatusPresentation, getStatusBadgeStyle } from "../src/lib/types";

describe("getStatusBadgeStyle", () => {
  it("returns blue styling for In Progress", () => {
    expect(getStatusBadgeStyle("In Progress")).toContain("blue");
  });

  it("returns emerald styling for Completed", () => {
    expect(getStatusBadgeStyle("Completed")).toContain("emerald");
  });

  it("returns emerald styling for scanned", () => {
    expect(getStatusBadgeStyle("scanned")).toContain("emerald");
  });

  it("returns rose styling for Failed", () => {
    expect(getStatusBadgeStyle("Failed")).toContain("rose");
  });

  it("falls back to amber for unknown / Pending / open", () => {
    expect(getStatusBadgeStyle("Pending")).toContain("amber");
    expect(getStatusBadgeStyle("open")).toContain("amber");
    expect(getStatusBadgeStyle("anything-else")).toContain("amber");
  });

  it("uses compact Pending text with yellow styling for never-reviewed PRs", () => {
    expect(getPullRequestStatusPresentation("Pending", null)).toEqual({
      label: "Pending",
      className: expect.stringContaining("amber"),
    });
  });

  it("uses compact Pending text with orange styling when a review exists", () => {
    expect(getPullRequestStatusPresentation("Pending", 8)).toEqual({
      label: "Pending",
      className: expect.stringContaining("orange"),
    });
  });

  it("keeps Completed labels compact and green", () => {
    expect(getPullRequestStatusPresentation("Completed", 10)).toEqual({
      label: "Completed",
      className: expect.stringContaining("emerald"),
    });
  });
});
