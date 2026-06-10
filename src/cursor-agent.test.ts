import { describe, it, expect } from "vitest";
import { normalizeModel, parseModelVariant, resolveVariantParams, mapReasoningEffort } from "./cursor-agent.js";

describe("parseModelVariant", () => {
  it("returns null variant for plain model", () => {
    expect(parseModelVariant("gpt-5.5")).toEqual({ base: "gpt-5.5", variant: null });
  });

  it("splits model:variant", () => {
    expect(parseModelVariant("claude-sonnet-4-6:reasoning")).toEqual({
      base: "claude-sonnet-4-6",
      variant: "reasoning",
    });
  });

  it("splits model:reasoning-high", () => {
    expect(parseModelVariant("gpt-5.5:reasoning-high")).toEqual({
      base: "gpt-5.5",
      variant: "reasoning-high",
    });
  });

  it("trims whitespace", () => {
    expect(parseModelVariant("  gpt-5.5:reasoning  ")).toEqual({
      base: "gpt-5.5",
      variant: "reasoning",
    });
  });

  it("handles no colon", () => {
    expect(parseModelVariant("composer-2.5")).toEqual({ base: "composer-2.5", variant: null });
  });
});

describe("resolveVariantParams", () => {
  it("returns empty for unknown model", () => {
    expect(resolveVariantParams("unknown-model", "reasoning")).toEqual([]);
  });

  it("returns empty for unknown variant", () => {
    expect(resolveVariantParams("gpt-5.5", "nonexistent")).toEqual([]);
  });

  it("returns params for gpt-5.5 reasoning variant", () => {
    const params = resolveVariantParams("gpt-5.5", "reasoning");
    expect(params).toEqual([{ id: "reasoning", value: "low" }]);
  });

  it("returns params for gpt-5.5 reasoning-high variant", () => {
    const params = resolveVariantParams("gpt-5.5", "reasoning-high");
    expect(params).toEqual([{ id: "reasoning", value: "high" }]);
  });

  it("returns params for gpt-5.5 reasoning-max variant", () => {
    const params = resolveVariantParams("gpt-5.5", "reasoning-max");
    expect(params).toEqual([{ id: "reasoning", value: "extra-high" }]);
  });

  it("returns params for claude-opus-4-8 reasoning variant", () => {
    const params = resolveVariantParams("claude-opus-4-8", "reasoning");
    expect(params).toEqual([{ id: "effort", value: "low" }]);
  });

  it("returns params for claude-opus-4-8 reasoning-max variant", () => {
    const params = resolveVariantParams("claude-opus-4-8", "reasoning-max");
    expect(params).toEqual([{ id: "effort", value: "max" }]);
  });

  it("returns params for claude-sonnet-4-6 reasoning variant", () => {
    const params = resolveVariantParams("claude-sonnet-4-6", "reasoning");
    expect(params).toEqual([{ id: "effort", value: "low" }]);
  });

  it("returns empty for model without variants (composer-2.5)", () => {
    expect(resolveVariantParams("composer-2.5", "reasoning")).toEqual([]);
  });
});

// normalizeToolCall and stripFinalMarker are not exported,
// so we test them indirectly through the module's behavior.
// We test normalizeModel directly since it IS exported.

describe("normalizeModel", () => {
  describe("default/auto", () => {
    it("empty string returns default", () => {
      expect(normalizeModel("")).toBe("default");
    });

    it("whitespace-only returns default", () => {
      expect(normalizeModel("   ")).toBe("default");
    });

    it("default returns default", () => {
      expect(normalizeModel("default")).toBe("default");
    });

    it("auto returns default", () => {
      expect(normalizeModel("auto")).toBe("default");
    });

    it("DEFAULT (uppercase) returns default", () => {
      expect(normalizeModel("DEFAULT")).toBe("default");
    });

    it("Auto (mixed case) returns default", () => {
      expect(normalizeModel("Auto")).toBe("default");
    });
  });

  describe("composer aliases", () => {
    it("composer returns composer-2.5", () => {
      expect(normalizeModel("composer")).toBe("composer-2.5");
    });

    it("composer-latest returns composer-2.5", () => {
      expect(normalizeModel("composer-latest")).toBe("composer-2.5");
    });

    it("composer-2.5 returns composer-2.5", () => {
      expect(normalizeModel("composer-2.5")).toBe("composer-2.5");
    });

    it("composer-2-5 returns composer-2.5", () => {
      expect(normalizeModel("composer-2-5")).toBe("composer-2.5");
    });

    it("composer-2.5-sdk returns composer-2.5", () => {
      expect(normalizeModel("composer-2.5-sdk")).toBe("composer-2.5");
    });

    it("composer-2-5-sdk returns composer-2.5", () => {
      expect(normalizeModel("composer-2-5-sdk")).toBe("composer-2.5");
    });

    it("COMPOSER (uppercase) returns composer-2.5", () => {
      expect(normalizeModel("COMPOSER")).toBe("composer-2.5");
    });
  });

  describe("composer-2.5-fast", () => {
    it("composer-2.5-fast returns composer-2.5-fast", () => {
      expect(normalizeModel("composer-2.5-fast")).toBe("composer-2.5-fast");
    });

    it("composer-2-5-fast returns composer-2.5-fast", () => {
      expect(normalizeModel("composer-2-5-fast")).toBe("composer-2.5-fast");
    });
  });

  describe("passthrough", () => {
    it("unknown model passes through as-is", () => {
      expect(normalizeModel("gpt-5.5")).toBe("gpt-5.5");
    });

    it("unknown model with spaces trimmed", () => {
      expect(normalizeModel("  gpt-5.5  ")).toBe("gpt-5.5");
    });

    it("claude-opus-4-8 passes through", () => {
      expect(normalizeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    });

    it("vendor/model passes through as-is (unknown)", () => {
      expect(normalizeModel("vendor/model-name")).toBe("vendor/model-name");
    });

    it("leading slash passes through as-is (unknown)", () => {
      expect(normalizeModel("/model")).toBe("/model");
    });
  });

  describe("whitespace handling", () => {
    it("trims leading and trailing whitespace", () => {
      expect(normalizeModel("  composer-2.5  ")).toBe("composer-2.5");
    });

    it("trims tabs and spaces", () => {
      expect(normalizeModel("\tcomposer-2.5\t")).toBe("composer-2.5");
    });
  });
});
