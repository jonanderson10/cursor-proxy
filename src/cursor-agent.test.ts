import { describe, it, expect } from "vitest";
import { normalizeModel, parseModelVariant, resolveVariantParams, mapReasoningEffort } from "./cursor-agent.js";

// We need to test the internal validation functions. Since they're not exported,
// we test them indirectly through the module's behavior. But we can test
// the exported normalizeToolCall behavior via the module's public API.

// For G1/G3, we test the normalizeModel function (already tested) and add
// tests for the new exported functions.

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

// --- G1: Tool call validation gate ---

import { isEmittableToolCall, normalizeToolCall } from "./cursor-agent.js";
import type { CursorToolCall } from "./types.js";

describe("isEmittableToolCall", () => {
  it("rejects shell without command", () => {
    expect(isEmittableToolCall({ name: "shell", arguments: {} })).toBe(false);
  });

  it("accepts shell with command", () => {
    expect(isEmittableToolCall({ name: "shell", arguments: { command: "ls" } })).toBe(true);
  });

  it("rejects write without path", () => {
    expect(isEmittableToolCall({ name: "write", arguments: { content: "hello" } })).toBe(false);
  });

  it("rejects write without content", () => {
    expect(isEmittableToolCall({ name: "write", arguments: { path: "f.txt" } })).toBe(false);
  });

  it("accepts write with path and content", () => {
    expect(isEmittableToolCall({ name: "write", arguments: { path: "f.txt", content: "hi" } })).toBe(true);
  });

  it("accepts write with streamContent", () => {
    expect(isEmittableToolCall({ name: "write", arguments: { path: "f.txt", streamContent: "hi" } })).toBe(true);
  });

  it("rejects edit without path", () => {
    expect(isEmittableToolCall({ name: "edit", arguments: { oldString: "a", newString: "b" } })).toBe(false);
  });

  it("rejects edit without replacement fields", () => {
    expect(isEmittableToolCall({ name: "edit", arguments: { path: "f.txt" } })).toBe(false);
  });

  it("accepts edit with old/new strings", () => {
    expect(isEmittableToolCall({ name: "edit", arguments: { path: "f.txt", oldString: "a", newString: "b" } })).toBe(true);
  });

  it("accepts edit with patchContent", () => {
    expect(isEmittableToolCall({ name: "edit", arguments: { path: "f.txt", patchContent: "@@ -1 +1 @@" } })).toBe(true);
  });

  it("accepts edit with streamContent", () => {
    expect(isEmittableToolCall({ name: "edit", arguments: { path: "f.txt", streamContent: "new content" } })).toBe(true);
  });

  it("rejects read without path", () => {
    expect(isEmittableToolCall({ name: "read", arguments: {} })).toBe(false);
  });

  it("accepts read with path", () => {
    expect(isEmittableToolCall({ name: "read", arguments: { path: "f.txt" } })).toBe(true);
  });

  it("rejects grep without pattern", () => {
    expect(isEmittableToolCall({ name: "grep", arguments: { path: "." } })).toBe(false);
  });

  it("accepts grep with pattern", () => {
    expect(isEmittableToolCall({ name: "grep", arguments: { pattern: "TODO" } })).toBe(true);
  });

  it("accepts glob with pattern", () => {
    expect(isEmittableToolCall({ name: "glob", arguments: { globPattern: "**/*.ts" } })).toBe(true);
  });

  it("accepts glob with wildcard in path", () => {
    expect(isEmittableToolCall({ name: "glob", arguments: { path: "src/*.ts" } })).toBe(true);
  });

  it("rejects glob without any pattern", () => {
    expect(isEmittableToolCall({ name: "glob", arguments: { path: "src" } })).toBe(false);
  });

  it("accepts ls unconditionally", () => {
    expect(isEmittableToolCall({ name: "ls", arguments: {} })).toBe(true);
  });

  it("accepts mcp with toolName", () => {
    expect(isEmittableToolCall({ name: "mcp", arguments: { toolName: "filesystem__read" } })).toBe(true);
  });

  it("rejects mcp without toolName", () => {
    expect(isEmittableToolCall({ name: "mcp", arguments: {} })).toBe(false);
  });

  it("rejects unknown tool with empty args", () => {
    expect(isEmittableToolCall({ name: "customtool", arguments: {} })).toBe(false);
  });

  it("accepts unknown tool with args", () => {
    expect(isEmittableToolCall({ name: "customtool", arguments: { foo: "bar" } })).toBe(true);
  });

  it("accepts reconstructed mcp__provider__toolName with args", () => {
    expect(isEmittableToolCall({ name: "mcp__filesystem__read", arguments: { path: "f.txt" } })).toBe(true);
  });
});

// --- G3: streamContent normalization in normalizeToolCall ---

describe("normalizeToolCall", () => {
  it("returns null for empty name", () => {
    expect(normalizeToolCall({ args: {} })).toBeNull();
  });

  it("normalizes edit with streamContent to write", () => {
    const tc = normalizeToolCall({
      name: "edit",
      args: { path: "src/index.ts", streamContent: "new content" },
    });
    expect(tc).toEqual({
      name: "write",
      arguments: { path: "src/index.ts", fileText: "new content" },
    });
  });

  it("does not convert edit without streamContent", () => {
    const tc = normalizeToolCall({
      name: "edit",
      args: { path: "f.txt", oldString: "a", newString: "b" },
    });
    expect(tc?.name).toBe("edit");
  });

  it("does not convert non-edit tools", () => {
    const tc = normalizeToolCall({ name: "read", args: { path: "f.txt" } });
    expect(tc?.name).toBe("read");
  });

  it("uses type as name fallback", () => {
    const tc = normalizeToolCall({ type: "shell", args: { command: "ls" } });
    expect(tc?.name).toBe("shell");
  });

  it("uses name when type absent", () => {
    const tc = normalizeToolCall({ name: "read", args: { path: "f.txt" } });
    expect(tc?.name).toBe("read");
  });

  it("handles null args", () => {
    const tc = normalizeToolCall({ name: "shell", args: null });
    expect(tc?.arguments).toEqual({});
  });

  it("handles non-object args", () => {
    const tc = normalizeToolCall({ name: "shell", args: "invalid" });
    expect(tc?.arguments).toEqual({});
  });

  // MCP reconstruction tests
  it("reconstructs mcp tool call from providerIdentifier and toolName", () => {
    const tc = normalizeToolCall({
      name: "mcp",
      args: { providerIdentifier: "client", toolName: "read", args: { path: "src/index.ts" } },
    });
    expect(tc?.name).toBe("mcp__client__read");
    expect(tc?.arguments).toEqual({ path: "src/index.ts" });
  });

  it("reconstructs callmcptool to mcp__provider__toolName", () => {
    const tc = normalizeToolCall({
      name: "callmcptool",
      args: { providerIdentifier: "client", toolName: "create_issue", args: { title: "Bug" } },
    });
    expect(tc?.name).toBe("mcp__client__create_issue");
    expect(tc?.arguments).toEqual({ title: "Bug" });
  });

  it("uses alternative arg keys for provider and toolName", () => {
    const tc = normalizeToolCall({
      name: "mcp",
      args: { provider: "client", name: "write", args: { path: "f.txt", content: "hi" } },
    });
    expect(tc?.name).toBe("mcp__client__write");
    expect(tc?.arguments).toEqual({ path: "f.txt", content: "hi" });
  });

  it("falls back to full args when nested args missing", () => {
    const tc = normalizeToolCall({
      name: "mcp",
      args: { providerIdentifier: "client", toolName: "read", path: "f.txt" },
    });
    expect(tc?.name).toBe("mcp__client__read");
    expect(tc?.arguments).toEqual({ providerIdentifier: "client", toolName: "read", path: "f.txt" });
  });

  it("does not reconstruct mcp when providerIdentifier missing", () => {
    const tc = normalizeToolCall({
      name: "mcp",
      args: { toolName: "read", args: { path: "f.txt" } },
    });
    expect(tc?.name).toBe("mcp");
  });

  it("does not reconstruct mcp when toolName missing", () => {
    const tc = normalizeToolCall({
      name: "mcp",
      args: { providerIdentifier: "client", args: { path: "f.txt" } },
    });
    expect(tc?.name).toBe("mcp");
  });

  it("suppresses mcp call with unknown provider", () => {
    const tc = normalizeToolCall({
      name: "mcp",
      args: { providerIdentifier: "custom-user-tools", toolName: "read", args: { path: "f.txt" } },
    });
    expect(tc).toBeNull();
  });

  it("suppresses callmcptool with unknown provider", () => {
    const tc = normalizeToolCall({
      name: "callmcptool",
      args: { providerIdentifier: "filesystem", toolName: "read", args: { path: "f.txt" } },
    });
    expect(tc).toBeNull();
  });
});
