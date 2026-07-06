import { describe, it, expect } from "vitest";
import { checkDelivery } from "../src/lib/webhookReplay";

describe("checkDelivery", () => {
  it("returns false for a new delivery GUID", () => {
    expect(checkDelivery("abc-111")).toBe(false);
  });

  it("returns true for a duplicate delivery GUID", () => {
    expect(checkDelivery("abc-222")).toBe(false);
    expect(checkDelivery("abc-222")).toBe(true);
  });

  it("allows a different GUID after one was seen", () => {
    expect(checkDelivery("abc-333")).toBe(false);
    expect(checkDelivery("abc-444")).toBe(false);
  });
});
