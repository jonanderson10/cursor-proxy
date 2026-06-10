import { Agent, Cursor } from "@cursor/sdk";
import type { CursorToolCall, ModelVariant } from "./types.js";
import { findModel } from "./models.js";

// Cache discovered model parameters from the SDK
let discoveredParams: Map<string, { id: string; values: string[] }[]> | null = null;

async function getDiscoveredParams(apiKey: string): Promise<Map<string, { id: string; values: string[] }[]>> {
  if (discoveredParams) return discoveredParams;
  try {
    const models = await Cursor.models.list({ apiKey });
    discoveredParams = new Map();
    for (const m of models) {
      if (m.parameters?.length) {
        discoveredParams.set(m.id, m.parameters.map((p) => ({
          id: p.id,
          values: p.values.map((v) => v.value),
        })));
      }
    }
  } catch {
    discoveredParams = new Map();
  }
  return discoveredParams;
}

export interface RunAgentOptions {
  apiKey: string;
  model: string;
  prompt: string;
  workingDirectory?: string;
  sessionKey?: string;
  reasoningEffort?: string;
}

export interface RunAgentResult {
  text: string;
  toolCalls: CursorToolCall[];
  agentID: string;
  runID: string;
  status: string;
}

/**
 * Parse a model string with optional variant suffix.
 * "claude-sonnet-4-6:reasoning" → { base: "claude-sonnet-4-6", variant: "reasoning" }
 * "gpt-5.5" → { base: "gpt-5.5", variant: null }
 */
export function parseModelVariant(model: string): { base: string; variant: string | null } {
  const trimmed = model.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return { base: trimmed, variant: null };
  return { base: trimmed.slice(0, colonIdx), variant: trimmed.slice(colonIdx + 1) };
}

/**
 * Look up variant params from the model's variant list.
 * Returns the params array for the matching variant, or empty array if not found.
 */
export function resolveVariantParams(baseId: string, variantId: string): { id: string; value: string }[] {
  const model = findModel(baseId);
  if (!model?.variants) return [];
  const variant = model.variants.find((v: ModelVariant) => v.id === variantId);
  return variant?.params ?? [];
}

/**
 * Map a reasoningEffort value to the correct SDK param for the given model.
 * Tries runtime discovery first, falls back to static model definitions.
 */
export async function mapReasoningEffort(baseId: string, effort: string, apiKey?: string): Promise<{ id: string; value: string }[]> {
  // Try runtime discovery first
  if (apiKey) {
    try {
      const params = await getDiscoveredParams(apiKey);
      const modelParams = params.get(baseId);
      if (modelParams) {
        // Find a parameter that accepts this effort value
        for (const param of modelParams) {
          if (param.values.includes(effort)) {
            return [{ id: param.id, value: effort }];
          }
        }
        // If exact value not found, try common mappings
        const effortMap: Record<string, string> = { max: "xhigh" };
        const mappedValue = effortMap[effort] ?? effort;
        for (const param of modelParams) {
          if (param.values.includes(mappedValue)) {
            return [{ id: param.id, value: mappedValue }];
          }
        }
      }
    } catch {
      // Fall through to static mapping
    }
  }

  // Fallback: static model definitions
  const model = findModel(baseId);
  if (!model?.variants?.length) return [];

  const effortToVariant: Record<string, string> = {
    low: "reasoning",
    medium: "reasoning-medium",
    high: "reasoning-high",
    max: "reasoning-max",
  };

  const variantId = effortToVariant[effort];
  if (!variantId) return [];

  const variant = model.variants.find((v: ModelVariant) => v.id === variantId);
  return variant?.params ?? [];
}

/**
 * Normalize model name to Cursor SDK model identifier.
 * Ported from bridge script normalizeModel().
 */
export function normalizeModel(model: string): string {
  const raw = model.trim();
  const normalized = raw.toLowerCase().split("/").filter(Boolean).at(-1) || "";
  if (!normalized || normalized === "default" || normalized === "auto") return "default";
  if (
    normalized === "composer-latest" ||
    normalized === "composer" ||
    normalized === "composer-2.5" ||
    normalized === "composer-2-5"
  )
    return "composer-2.5";
  if (normalized === "composer-2.5-sdk" || normalized === "composer-2-5-sdk")
    return "composer-2.5";
  if (normalized === "composer-2.5-fast" || normalized === "composer-2-5-fast")
    return "composer-2.5-fast";
  return raw;
}

/**
 * Convert normalized model to SDK model selection.
 * Merges variant params (e.g., reasoning) with base model params.
 */
function sdkModelSelection(model: string, variantParams: { id: string; value: string }[] = []) {
  const normalized = normalizeModel(model);
  let base: { id: string; params?: { id: string; value: string }[] };

  if (normalized === "composer-2.5")
    base = { id: "composer-2.5", params: [{ id: "fast", value: "false" }] };
  else if (normalized === "composer-2.5-fast")
    base = { id: "composer-2.5", params: [{ id: "fast", value: "true" }] };
  else
    base = { id: normalized };

  // Merge variant params (variant overrides base if same id)
  if (variantParams.length > 0) {
    const merged = [...(base.params ?? [])];
    for (const vp of variantParams) {
      const idx = merged.findIndex((p) => p.id === vp.id);
      if (idx >= 0) merged[idx] = vp;
      else merged.push(vp);
    }
    base.params = merged;
  }

  return base;
}

/**
 * Run a Cursor SDK agent and return the result.
 * Uses the same pattern as the bridge script's runLocalAgentBody().
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { base, variant } = parseModelVariant(opts.model);
  // reasoningEffort from request body takes precedence over variant suffix
  const variantParams = opts.reasoningEffort
    ? await mapReasoningEffort(base, opts.reasoningEffort, opts.apiKey)
    : variant ? resolveVariantParams(base, variant) : [];
  const model = sdkModelSelection(base, variantParams);
  const cwd = opts.workingDirectory || process.cwd();

  const agent = await Agent.create({
    apiKey: opts.apiKey,
    model,
    name: "cursor-proxy",
    local: { cwd },
  });

  try {
    let capturedToolCall: CursorToolCall | null = null;
    let cancelRequested = false;

    const run = await agent.send(opts.prompt, {
      model,
      idempotencyKey: opts.sessionKey || crypto.randomUUID(),
      onDelta: async ({ update }) => {
        if (capturedToolCall || cancelRequested) return;
        if (update.type === "tool-call-started") {
          const toolCall = (update as { toolCall?: unknown }).toolCall;
          if (toolCall && typeof toolCall === "object") {
            const tc = normalizeToolCall(toolCall as { type?: string; name?: string; args?: unknown });
            if (tc) {
              capturedToolCall = tc;
              cancelRequested = true;
              run.cancel().catch(() => {});
            }
          }
        }
      },
    });

    // If onDelta captured a tool call early, return it
    if (capturedToolCall) {
      return {
        text: "",
        toolCalls: [capturedToolCall],
        agentID: agent.agentId || "",
        runID: run.id || opts.sessionKey || "",
        status: "tool_call",
      };
    }

    let text = "";

    // Fallback: iterate stream for text and tool_call events
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block?.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
        continue;
      }
      if (event.type === "tool_call") {
        if (event.status && event.status !== "running") continue;
        const tc = normalizeToolCall({ type: event.name, args: event.args });
        if (tc) {
          capturedToolCall = tc;
          break;
        }
      }
    }

    if (capturedToolCall) {
      run.cancel().catch(() => {});
      return {
        text: "",
        toolCalls: [capturedToolCall],
        agentID: agent.agentId || "",
        runID: run.id || opts.sessionKey || "",
        status: "tool_call",
      };
    }

    const result = await run.wait();
    if (result.status === "error") {
      throw new Error(
        `Cursor SDK run failed: ${result.result || "unknown error"}`
      );
    }
    if (!text && typeof result.result === "string") text = result.result;
    return {
      text: stripFinalMarker(text),
      toolCalls: [],
      agentID: agent.agentId || "",
      runID: run.id,
      status: result.status,
    };
  } finally {
    try {
      agent.close();
    } catch {}
  }
}

/**
 * Run a Cursor SDK agent with streaming — yields text chunks.
 */
export async function* runAgentStream(opts: RunAgentOptions): AsyncGenerator<{
  type: "text" | "tool_call";
  text?: string;
  toolCall?: CursorToolCall;
}> {
  const { base, variant } = parseModelVariant(opts.model);
  const variantParams = opts.reasoningEffort
    ? await mapReasoningEffort(base, opts.reasoningEffort, opts.apiKey)
    : variant ? resolveVariantParams(base, variant) : [];
  const model = sdkModelSelection(base, variantParams);
  const cwd = opts.workingDirectory || process.cwd();

  const agent = await Agent.create({
    apiKey: opts.apiKey,
    model,
    name: "cursor-proxy",
    local: { cwd },
  });

  try {
    let capturedToolCall: CursorToolCall | null = null;
    let cancelRequested = false;

    const run = await agent.send(opts.prompt, {
      model,
      idempotencyKey: opts.sessionKey || crypto.randomUUID(),
      onDelta: async ({ update }) => {
        if (capturedToolCall || cancelRequested) return;
        if (update.type === "tool-call-started") {
          const toolCall = (update as { toolCall?: unknown }).toolCall;
          if (toolCall && typeof toolCall === "object") {
            const tc = normalizeToolCall(toolCall as { type?: string; name?: string; args?: unknown });
            if (tc) {
              capturedToolCall = tc;
              cancelRequested = true;
              run.cancel().catch(() => {});
            }
          }
        }
      },
    });

    // If onDelta captured a tool call early, yield it
    if (capturedToolCall) {
      yield { type: "tool_call", toolCall: capturedToolCall };
      return;
    }

    // Fallback: iterate stream for text and tool_call events
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block?.type === "text" && typeof block.text === "string" && block.text) {
            yield { type: "text", text: block.text };
          }
        }
        continue;
      }
      if (event.type === "tool_call") {
        if (event.status && event.status !== "running") continue;
        const tc = normalizeToolCall({ type: event.name, args: event.args });
        if (tc) {
          capturedToolCall = tc;
          run.cancel().catch(() => {});
          yield { type: "tool_call", toolCall: tc };
          return;
        }
      }
    }

    // If no tool call captured, wait for completion
    if (!capturedToolCall) {
      const result = await run.wait();
      if (result.status === "error") {
        throw new Error(
          `Cursor SDK run failed: ${result.result || "unknown error"}`
        );
      }
    }
  } finally {
    try {
      agent.close();
    } catch {}
  }
}

function normalizeToolCall(raw: { type?: string; name?: string; args?: unknown; arguments?: unknown }): CursorToolCall | null {
  const name = typeof raw.type === "string" ? raw.type : typeof raw.name === "string" ? raw.name : "";
  if (!name) return null;
  const args = raw.args ?? raw.arguments ?? {};
  return {
    name,
    arguments: typeof args === "object" && args !== null ? args as Record<string, unknown> : {},
  };
}

function stripFinalMarker(text: string): string {
  return text.replace(/\s*<\/?(?:final_answer|answer)>\s*$/gi, "").trim();
}
