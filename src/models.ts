import type { ModelInfo, ModelVariant } from "./types.js";

const NOW = Math.floor(Date.now() / 1000);

// Per-model variant definitions — different models use different param IDs and values
const GPT_REASONING: ModelVariant[] = [
  { id: "reasoning", name: "Low", params: [{ id: "reasoning", value: "low" }] },
  { id: "reasoning-medium", name: "Medium", params: [{ id: "reasoning", value: "medium" }] },
  { id: "reasoning-high", name: "High", params: [{ id: "reasoning", value: "high" }] },
  { id: "reasoning-max", name: "Max", params: [{ id: "reasoning", value: "extra-high" }] },
];

const CLAUDE_EFFORT: ModelVariant[] = [
  { id: "reasoning", name: "Low", params: [{ id: "effort", value: "low" }] },
  { id: "reasoning-medium", name: "Medium", params: [{ id: "effort", value: "medium" }] },
  { id: "reasoning-high", name: "High", params: [{ id: "effort", value: "high" }] },
  { id: "reasoning-max", name: "Max", params: [{ id: "effort", value: "max" }] },
];

const MODELS: ModelInfo[] = [
  {
    id: "default",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Auto (default)",
  },
  {
    id: "composer-2.5",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Composer 2.5",
    cost: { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    limit: { context: 200000, output: 65536 },
  },
  {
    id: "composer-2.5-fast",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Composer 2.5 Fast",
    cost: { input: 3.0, output: 15.0, cacheRead: 0.5, cacheWrite: 0 },
    limit: { context: 200000, output: 65536 },
  },
  {
    id: "gpt-5.5",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "GPT-5.5",
    cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 },
    limit: { context: 1050000, output: 131072 },
    variants: GPT_REASONING,
  },
  {
    id: "gpt-5.2",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "GPT-5.2",
    cost: { input: 1.75, output: 14.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 400000, output: 65536 },
    variants: GPT_REASONING,
  },
  {
    id: "gpt-5.1",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "GPT-5.1",
    cost: { input: 1.25, output: 10.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 400000, output: 65536 },
    variants: GPT_REASONING,
  },
  {
    id: "gpt-5-mini",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "GPT-5 Mini",
    cost: { input: 0.25, output: 2.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 400000, output: 65536 },
  },
  {
    id: "claude-opus-4-8",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Claude Opus 4.8",
    cost: { input: 5.0, output: 25.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 1000000, output: 131072 },
    variants: CLAUDE_EFFORT,
  },
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Claude Sonnet 4.6",
    cost: { input: 3.0, output: 15.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 1000000, output: 131072 },
    variants: CLAUDE_EFFORT,
  },
  {
    id: "claude-fable-5",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Claude Fable 5",
    cost: { input: 10.0, output: 50.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 1000000, output: 131072 },
    variants: CLAUDE_EFFORT,
  },
  {
    id: "gemini-3.1-pro",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Gemini 3.1 Pro",
    cost: { input: 2.0, output: 12.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 1000000, output: 131072 },
  },
  {
    id: "gemini-3.5-flash",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Gemini 3.5 Flash",
    cost: { input: 1.5, output: 9.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 1000000, output: 131072 },
  },
  {
    id: "gemini-2.5-flash",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Gemini 2.5 Flash",
    cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 1000000, output: 131072 },
  },
  {
    id: "grok-4.3",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Grok 4.3",
    cost: { input: 1.25, output: 2.5, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 1000000, output: 131072 },
  },
  {
    id: "kimi-k2.5",
    object: "model",
    created: NOW,
    owned_by: "cursor",
    name: "Kimi K2.5",
    cost: { input: 0.6, output: 3.0, cacheRead: 0, cacheWrite: 0 },
    limit: { context: 262000, output: 65536 },
  },
];

// Runtime-discovered models (used in requests but not in hardcoded list)
const discoveredModels = new Map<string, ModelInfo>();

export function recordModel(id: string): void {
  if (MODELS.some((m) => m.id === id) || discoveredModels.has(id)) return;
  discoveredModels.set(id, {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "cursor",
    name: id,
    // cost and limit intentionally omitted — unknown
  });
}

export function resetDiscoveredModels(): void {
  discoveredModels.clear();
}

export function modelList() {
  const all = [...MODELS, ...discoveredModels.values()];
  return { object: "list" as const, data: all };
}

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id) ?? discoveredModels.get(id);
}

export function modelGuide() {
  return {
    description: "Available models for the Cursor proxy. Models marked with cost: null were used in requests but not in the hardcoded list — they work but lack pricing/limit metadata.",
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      cost: m.cost ?? null,
      limit: m.limit ?? null,
      variants: m.variants ?? [],
    })),
    config_example: {
      $schema: "https://opencode.ai/config.json",
      provider: {
        cursor: {
          npm: "@ai-sdk/openai-compatible",
          name: "Cursor",
          options: {
            baseURL: "http://127.0.0.1:8787/v1",
            apiKey: "sk-your-cursor-api-key",
          },
          models: {
            "composer-2.5": { name: "Composer 2.5", cost: { input: 0.5, output: 2.5, cacheRead: 0.2 }, limit: { context: 200000, output: 65536 } },
            "composer-2.5-fast": { name: "Composer 2.5 Fast", cost: { input: 3, output: 15, cacheRead: 0.5 }, limit: { context: 200000, output: 65536 } },
            "gpt-5.5": {
              name: "GPT-5.5", cost: { input: 5, output: 30, cacheRead: 0.5 }, limit: { context: 1050000, output: 131072 },
              variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
            },
            "gpt-5.2": {
              name: "GPT-5.2", cost: { input: 1.75, output: 14 }, limit: { context: 400000, output: 65536 },
              variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
            },
            "gpt-5.1": {
              name: "GPT-5.1", cost: { input: 1.25, output: 10 }, limit: { context: 400000, output: 65536 },
              variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
            },
            "gpt-5-mini": { name: "GPT-5 Mini", cost: { input: 0.25, output: 2 }, limit: { context: 400000, output: 65536 } },
            "claude-opus-4-8": {
              name: "Claude Opus 4.8", cost: { input: 5, output: 25 }, limit: { context: 1000000, output: 131072 },
              variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
            },
            "claude-sonnet-4-6": {
              name: "Claude Sonnet 4.6", cost: { input: 3, output: 15 }, limit: { context: 1000000, output: 131072 },
              variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
            },
            "claude-fable-5": {
              name: "Claude Fable 5", cost: { input: 10, output: 50 }, limit: { context: 1000000, output: 131072 },
              variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
            },
            "gemini-3.1-pro": { name: "Gemini 3.1 Pro", cost: { input: 2, output: 12 }, limit: { context: 1000000, output: 131072 } },
            "gemini-3.5-flash": { name: "Gemini 3.5 Flash", cost: { input: 1.5, output: 9 }, limit: { context: 1000000, output: 131072 } },
            "gemini-2.5-flash": { name: "Gemini 2.5 Flash", cost: { input: 0.3, output: 2.5 }, limit: { context: 1000000, output: 131072 } },
            "grok-4.3": { name: "Grok 4.3", cost: { input: 1.25, output: 2.5 }, limit: { context: 1000000, output: 131072 } },
            "kimi-k2.5": { name: "Kimi K2.5", cost: { input: 0.6, output: 3 }, limit: { context: 262000, output: 65536 } },
          },
        },
      },
    },
  };
}
