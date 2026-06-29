import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ITERATIONS,
  MAX_ITERATIONS_BOUNDS,
  resolveMaxIterations,
  validatePresetsInput,
  type Preset,
  type PresetsFile,
} from "../src/lib/llmPresets";

function basePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "p1",
    name: "Test",
    endpoint: "https://example.com/v1",
    apiKey: "key",
    chatModel: "model-x",
    embeddingModel: "",
    ...overrides,
  };
}

function baseState(overrides: Partial<PresetsFile> = {}): PresetsFile {
  return {
    presets: [basePreset()],
    primaryChatPresetId: "p1",
    fallbackChatPresetId: "",
    primaryEmbeddingPresetId: "",
    fallbackEmbeddingPresetId: "",
    ...overrides,
  };
}

describe("resolveMaxIterations", () => {
  it("returns DEFAULT_MAX_ITERATIONS when field is absent", () => {
    expect(resolveMaxIterations({})).toBe(DEFAULT_MAX_ITERATIONS);
    expect(DEFAULT_MAX_ITERATIONS).toBe(16);
  });

  it("returns the explicit value when in bounds", () => {
    expect(resolveMaxIterations({ maxIterations: 8 })).toBe(8);
    expect(resolveMaxIterations({ maxIterations: 10 })).toBe(10);
  });

  it("floors fractional values", () => {
    expect(resolveMaxIterations({ maxIterations: 8.9 })).toBe(8);
  });

  it("falls back to default when out of bounds", () => {
    expect(resolveMaxIterations({ maxIterations: 3 })).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveMaxIterations({ maxIterations: 33 })).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it("falls back to default when non-numeric", () => {
    expect(resolveMaxIterations({ maxIterations: "many" as unknown as number })).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveMaxIterations({ maxIterations: NaN })).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it("respects the documented bounds (4–32)", () => {
    expect(MAX_ITERATIONS_BOUNDS).toEqual({ min: 4, max: 32 });
    expect(resolveMaxIterations({ maxIterations: 4 })).toBe(4);
    expect(resolveMaxIterations({ maxIterations: 32 })).toBe(32);
  });
});

describe("validatePresetsInput + maxIterations", () => {
  it("accepts a preset with maxIterations in bounds", () => {
    const input = baseState({ presets: [basePreset({ maxIterations: 10 })] });
    expect(() => validatePresetsInput(input)).not.toThrow();
  });

  it("accepts a preset without maxIterations (back-compat with legacy files)", () => {
    const input = baseState({ presets: [basePreset()] });
    expect(() => validatePresetsInput(input)).not.toThrow();
  });

  it("rejects maxIterations below the min", () => {
    const input = baseState({ presets: [basePreset({ maxIterations: 2 })] });
    expect(() => validatePresetsInput(input)).toThrow(/maxIterations must be between 4 and 32/);
  });

  it("rejects maxIterations above the max", () => {
    const input = baseState({ presets: [basePreset({ maxIterations: 64 })] });
    expect(() => validatePresetsInput(input)).toThrow(/maxIterations must be between 4 and 32/);
  });

  it("rejects non-numeric maxIterations", () => {
    const input = baseState({
      presets: [basePreset({ maxIterations: "lots" as unknown as number })],
    });
    expect(() => validatePresetsInput(input)).toThrow(/maxIterations must be between 4 and 32/);
  });
});
