import { describe, it, expect, afterEach } from "vitest";
import { modelList, findModel, modelGuide, recordModel, resetDiscoveredModels } from "./models.js";

afterEach(() => {
  resetDiscoveredModels();
});

describe("modelList", () => {
  it("returns object type list", () => {
    expect(modelList().object).toBe("list");
  });

  it("contains 15 hardcoded models", () => {
    expect(modelList().data).toHaveLength(15);
  });

  it("includes discovered models after recordModel", () => {
    recordModel("some-new-model");
    const list = modelList();
    expect(list.data).toHaveLength(16);
    const found = list.data.find((m) => m.id === "some-new-model");
    expect(found).toBeDefined();
    expect(found!.owned_by).toBe("cursor");
    expect(found!.cost).toBeUndefined();
    expect(found!.limit).toBeUndefined();
  });

  it("does not duplicate known models", () => {
    recordModel("gpt-5.5");
    expect(modelList().data).toHaveLength(15);
  });

  it("does not duplicate discovered models", () => {
    recordModel("new-model");
    recordModel("new-model");
    expect(modelList().data).toHaveLength(16);
  });

  it("every model has required fields", () => {
    for (const m of modelList().data) {
      expect(m.id).toBeTruthy();
      expect(m.object).toBe("model");
      expect(m.owned_by).toBe("cursor");
      expect(typeof m.created).toBe("number");
    }
  });

  it("includes expected model IDs", () => {
    const ids = modelList().data.map((m) => m.id);
    expect(ids).toContain("default");
    expect(ids).toContain("composer-2.5");
    expect(ids).toContain("composer-2.5-fast");
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-fable-5");
  });

  it("models with cost have all cost fields", () => {
    const withCost = modelList().data.filter((m) => m.cost);
    expect(withCost.length).toBeGreaterThan(0);
    for (const m of withCost) {
      expect(m.cost).toHaveProperty("input");
      expect(m.cost).toHaveProperty("output");
      expect(m.cost).toHaveProperty("cacheRead");
      expect(m.cost).toHaveProperty("cacheWrite");
    }
  });
});

describe("findModel", () => {
  it("finds default model", () => {
    const m = findModel("default");
    expect(m).toBeDefined();
    expect(m!.name).toBe("Auto (default)");
  });

  it("finds composer-2.5", () => {
    const m = findModel("composer-2.5");
    expect(m).toBeDefined();
    expect(m!.name).toBe("Composer 2.5");
  });

  it("returns undefined for empty string", () => {
    expect(findModel("")).toBeUndefined();
  });

  it("returns undefined for unknown model", () => {
    expect(findModel("nonexistent")).toBeUndefined();
  });

  it("finds discovered models", () => {
    recordModel("brand-new-model");
    const m = findModel("brand-new-model");
    expect(m).toBeDefined();
    expect(m!.id).toBe("brand-new-model");
    expect(m!.cost).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(findModel("Default")).toBeUndefined();
    expect(findModel("COMPOSER-2.5")).toBeUndefined();
  });

  it("finds all 15 models by ID", () => {
    for (const m of modelList().data) {
      expect(findModel(m.id)).toEqual(m);
    }
  });
});

describe("modelGuide", () => {
  it("has description", () => {
    expect(modelGuide().description).toContain("Cursor proxy");
  });

  it("lists all hardcoded models", () => {
    expect(modelGuide().models).toHaveLength(15);
  });

  it("description mentions dynamic discovery", () => {
    expect(modelGuide().description).toContain("cost: null");
  });

  it("maps cost to null when undefined", () => {
    const guide = modelGuide();
    const defaultModel = guide.models.find((m) => m.id === "default");
    expect(defaultModel!.cost).toBeNull();
  });

  it("preserves cost when defined", () => {
    const guide = modelGuide();
    const gpt55 = guide.models.find((m) => m.id === "gpt-5.5");
    expect(gpt55!.cost).toEqual({ input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 });
  });

  it("includes config_example", () => {
    const guide = modelGuide();
    expect(guide.config_example).toHaveProperty("provider");
    expect(guide.config_example.provider.cursor).toHaveProperty("npm");
  });
});
