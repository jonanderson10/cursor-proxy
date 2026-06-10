import { Agent, Cursor } from "@cursor/sdk";
import type { SDKJsonValue, SDKCustomTool } from "@cursor/sdk";
import type { CursorToolCall, ModelVariant } from "./types.js";
import { findModel } from "./models.js";
import { sdkToOpencodeToolName } from "./translate.js";

// Known MCP providers — suppress SDK mcp calls with unknown providers
const KNOWN_MCP_PROVIDERS = new Set(["client"]);

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

// --- Session persistence ---
const SESSION_TTL = 6 * 60 * 60 * 1000; // 6 hours
const sessionCache = new Map<string, { agentId: string; updatedAt: number }>();

function getSessionAgentId(sessionKey: string): string | undefined {
  const session = sessionCache.get(sessionKey);
  if (!session) return undefined;
  if (Date.now() - session.updatedAt > SESSION_TTL) {
    sessionCache.delete(sessionKey);
    return undefined;
  }
  return session.agentId;
}

function setSessionAgentId(sessionKey: string, agentId: string): void {
  sessionCache.set(sessionKey, { agentId, updatedAt: Date.now() });
}

/** Clear session cache (for tests). */
export function resetSessionCache(): void {
  sessionCache.clear();
}

// --- Error retry ---

const SDK_TOOL_RETRY_ATTEMPTS = 3;

function retryPromptAfterMissingTool(prompt: string, attempt: number, maxAttempts: number): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
    "Your previous response did not emit a local tool call, but the latest user request requires local execution.",
    "The next response is invalid unless it contains a tool_call.",
    "Do not answer in prose. Emit exactly one tool call now using the available tool inventory above.",
  ].join("\n");
}

function retryPromptAfterUnsupportedTool(prompt: string, toolName: string, reason: string, attempt: number, maxAttempts: number): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
    `Your previous tool call "${toolName}" was rejected: ${reason}`,
    "Emit a corrected tool call with the required arguments. Do not answer in prose.",
  ].join("\n");
}

export interface RunAgentOptions {
  apiKey: string;
  model: string;
  prompt: string;
  workingDirectory?: string;
  sessionKey?: string;
  reasoningEffort?: string;
  customTools?: Record<string, SDKCustomTool>;
  requiresLocalTool?: boolean;
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
 * Includes retry logic when customTools are provided but no tool call is emitted.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { base, variant } = parseModelVariant(opts.model);
  const variantParams = opts.reasoningEffort
    ? await mapReasoningEffort(base, opts.reasoningEffort, opts.apiKey)
    : variant ? resolveVariantParams(base, variant) : [];
  const model = sdkModelSelection(base, variantParams);
  const cwd = opts.workingDirectory || process.cwd();
  const hasCustomTools = opts.customTools && Object.keys(opts.customTools).length > 0;
  const shouldRetry = hasCustomTools || opts.requiresLocalTool;

  for (let attempt = 1; attempt <= (shouldRetry ? SDK_TOOL_RETRY_ATTEMPTS : 1); attempt++) {
    const attemptPrompt = attempt > 1
      ? retryPromptAfterMissingTool(opts.prompt, attempt, SDK_TOOL_RETRY_ATTEMPTS)
      : opts.prompt;

    const result = await runOnce({ ...opts, prompt: attemptPrompt }, model, cwd, shouldRetry);

    // G1: Validate tool calls before forwarding
    if (result.toolCalls.length > 0) {
      const invalid = result.toolCalls.find((tc) => !isEmittableToolCall(tc));
      if (invalid && shouldRetry && attempt < SDK_TOOL_RETRY_ATTEMPTS) {
        const reason = missingArgReason(invalid);
        opts.prompt = retryPromptAfterUnsupportedTool(opts.prompt, invalid.name, reason, attempt + 1, SDK_TOOL_RETRY_ATTEMPTS);
        continue; // retry with correction hint
      }
    }

    if (result.toolCalls.length > 0 || !shouldRetry || attempt >= SDK_TOOL_RETRY_ATTEMPTS) {
      // Cache session agentId for reuse
      if (opts.sessionKey && result.agentID) {
        setSessionAgentId(opts.sessionKey, result.agentID);
      }
      return result;
    }
    // Retry — SDK returned text instead of tool call
  }

  // Unreachable, but TypeScript needs it
  return runOnce(opts, model, cwd);
}

async function runOnce(
  opts: RunAgentOptions,
  modelSelection: { id: string; params?: { id: string; value: string }[] },
  cwd: string,
  _shouldRetry: boolean = false
): Promise<RunAgentResult> {
  const cachedAgentId = opts.sessionKey ? getSessionAgentId(opts.sessionKey) : undefined;
  const hasCustomTools = opts.customTools && Object.keys(opts.customTools).length > 0;

  const agent = await Agent.create({
    apiKey: opts.apiKey,
    model: modelSelection,
    name: "cursor-proxy",
    ...(cachedAgentId ? { agentId: cachedAgentId } : {}),
    local: {
      cwd,
      ...(hasCustomTools ? { customTools: opts.customTools } : {}),
    },
  });

  try {
    let capturedToolCall: CursorToolCall | null = null;
    let cancelRequested = false;

    const run = await agent.send(opts.prompt, {
      model: modelSelection,
      idempotencyKey: opts.sessionKey || crypto.randomUUID(),
      onDelta: async ({ update }) => {
        if (capturedToolCall || cancelRequested) return;
        if (update.type === "tool-call-started") {
          const toolCall = (update as { toolCall?: unknown }).toolCall;
          if (toolCall && typeof toolCall === "object") {
            const tc = normalizeToolCall(toolCall as { type?: string; name?: string; args?: unknown });
            if (tc) {
              // Translate SDK built-in names to opencode names
              tc.name = sdkToOpencodeToolName(tc.name);
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
          tc.name = sdkToOpencodeToolName(tc.name);
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
  type: "text" | "tool_call" | "thinking";
  text?: string;
  toolCall?: CursorToolCall;
}> {
  const { base, variant } = parseModelVariant(opts.model);
  const variantParams = opts.reasoningEffort
    ? await mapReasoningEffort(base, opts.reasoningEffort, opts.apiKey)
    : variant ? resolveVariantParams(base, variant) : [];
  const model = sdkModelSelection(base, variantParams);
  const cwd = opts.workingDirectory || process.cwd();
  const cachedAgentId = opts.sessionKey ? getSessionAgentId(opts.sessionKey) : undefined;
  const hasCustomTools = opts.customTools && Object.keys(opts.customTools).length > 0;

  const agent = await Agent.create({
    apiKey: opts.apiKey,
    model,
    name: "cursor-proxy",
    ...(cachedAgentId ? { agentId: cachedAgentId } : {}),
    local: {
      cwd,
      ...(hasCustomTools ? { customTools: opts.customTools } : {}),
    },
  });

  try {
    let capturedToolCall: CursorToolCall | null = null;
    let cancelRequested = false;
    let thinkingText = "";

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
              tc.name = sdkToOpencodeToolName(tc.name);
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

    // Fallback: iterate stream for text, thinking, and tool_call events
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (!block) continue;
          const b = block as { type: string; text?: string; thinking?: string };
          // Thinking blocks (reasoning content from reasoning models)
          if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
            thinkingText += b.thinking;
            yield { type: "thinking", text: b.thinking };
            continue;
          }
          // Regular text blocks
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            yield { type: "text", text: b.text };
          }
        }
        continue;
      }
      if (event.type === "tool_call") {
        if (event.status && event.status !== "running") continue;
        const tc = normalizeToolCall({ type: event.name, args: event.args });
        if (tc) {
          tc.name = sdkToOpencodeToolName(tc.name);
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
    // Cache session agentId for reuse
    if (opts.sessionKey && agent.agentId) {
      setSessionAgentId(opts.sessionKey, agent.agentId);
    }
    try {
      agent.close();
    } catch {}
  }
}

/** @internal Exported for testing. */
export function normalizeToolCall(raw: { type?: string; name?: string; args?: unknown; arguments?: unknown }): CursorToolCall | null {
  const name = typeof raw.type === "string" ? raw.type : typeof raw.name === "string" ? raw.name : "";
  if (!name) return null;
  let args = raw.args ?? raw.arguments ?? {};
  if (typeof args !== "object" || args === null) args = {};
  let tc: CursorToolCall = { name, arguments: args as Record<string, unknown> };

  // MCP reconstruction — SDK built-in mcp meta-tool → opencode mcp__provider__toolName
  const lowerName = tc.name.toLowerCase();
  if (lowerName === "mcp" || lowerName === "callmcptool") {
    const provider = firstStringArg(tc.arguments, "providerIdentifier", "provider_identifier", "provider", "server", "serverName", "server_name");
    const toolName = firstStringArg(tc.arguments, "toolName", "tool_name", "name", "tool");
    if (provider && toolName) {
      // Suppress unknown MCP providers — let SDK fall back to native tools
      if (!KNOWN_MCP_PROVIDERS.has(provider)) return null;
      tc = { name: `mcp__${provider}__${toolName}`, arguments: (tc.arguments.args as Record<string, unknown>) ?? tc.arguments };
    }
  }

  // G3: streamContent normalization — edit with streamContent → write
  if (tc.name.toLowerCase() === "edit") {
    const sc = firstStringArgAllowEmpty(tc.arguments, "streamContent", "stream_content");
    const path = firstStringArg(tc.arguments, "path", "filePath", "file_path", "targetFile", "target_file");
    if (sc !== undefined && path) {
      tc.name = "write";
      tc.arguments = { ...tc.arguments, path, fileText: sc };
      delete tc.arguments.streamContent;
      delete tc.arguments.stream_content;
    }
  }
  return tc;
}

// G1: Tool call validation gate
/** @internal Exported for testing. */
export function isEmittableToolCall(toolCall: CursorToolCall): boolean {
  const name = toolCall.name.toLowerCase();
  const args = toolCall.arguments ?? {};
  if (name === "glob") return hasGlobRequest(args);
  if (name === "ls") return true;
  if (name === "shell") return hasAnyStringArg(args, "command", "cmd", "script");
  if (name === "write") {
    return hasAnyStringArg(args, "path", "filePath", "file_path", "targetFile", "target_file") &&
      hasAnyStringArgAllowEmpty(args, "fileText", "file_text", "content", "contents", "text", "fileContent", "file_content", "streamContent", "stream_content");
  }
  if (name === "edit") {
    const hasCompleteReplacement =
      hasAnyStringArgAllowEmpty(args, "oldText", "old_text", "oldString", "old_string", "old_str", "old", "search", "searchString", "search_string") &&
      hasAnyStringArgAllowEmpty(args, "newText", "new_text", "newString", "new_string", "new_str", "replacement", "replace", "content");
    return (
      hasAnyStringArg(args, "path", "filePath", "file_path", "targetFile", "target_file") &&
      (hasAnyStringArgAllowEmpty(args, "patchContent", "patch_content", "patch", "diff", "unifiedDiff", "unified_diff") ||
        hasAnyStringArgAllowEmpty(args, "streamContent", "stream_content") ||
        hasCompleteReplacement)
    );
  }
  if (name === "read" || name === "delete") return hasAnyStringArg(args, "path", "filePath", "file_path", "targetFile", "target_file");
  if (name === "grep") return hasAnyStringArg(args, "pattern", "query", "regex", "search");
  if (name === "semsearch" || name === "semanticsearch") return hasAnyStringArg(args, "query", "pattern", "search");
  if (name === "readlints") return Array.isArray(args.paths) && args.paths.some((item: unknown) => typeof item === "string" && item.trim());
  if (name === "mcp" || name === "callmcptool") return hasAnyStringArg(args, "toolName", "tool_name", "name");
  return Object.keys(args).length > 0;
}

function hasStringArg(args: Record<string, unknown>, key: string): boolean {
  return typeof args[key] === "string" && (args[key] as string).trim().length > 0;
}

function hasAnyStringArg(args: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => hasStringArg(args, key));
}

function hasAnyStringArgAllowEmpty(args: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => typeof args[key] === "string");
}

function hasGlobRequest(args: Record<string, unknown>): boolean {
  if (hasAnyStringArg(args, "globPattern", "glob_pattern", "filePattern", "file_pattern", "pattern", "glob", "query", "include", "includeGlob", "include_glob")) {
    return true;
  }
  const target = typeof args.targetDirectory === "string" ? args.targetDirectory :
    typeof args.target_directory === "string" ? args.target_directory :
    typeof args.path === "string" ? args.path : "";
  return typeof target === "string" && /[*?[\]{}]/.test(target);
}

function firstStringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof args[key] === "string" && (args[key] as string).trim()) return args[key] as string;
  }
  return undefined;
}

function firstStringArgAllowEmpty(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return undefined;
}

function missingArgReason(toolCall: CursorToolCall): string {
  const name = toolCall.name.toLowerCase();
  const args = toolCall.arguments ?? {};
  switch (name) {
    case "shell": return "missing required 'command' argument";
    case "write": return "missing 'path' or 'fileText'/'content' argument";
    case "edit": return "missing 'path' and either 'oldString'+'newString' or 'patchContent'";
    case "read":
    case "delete": return "missing required 'path' argument";
    case "grep": return "missing required 'pattern' argument";
    case "glob": return "missing glob pattern (globPattern, pattern, or targetDirectory with wildcard)";
    case "mcp":
    case "callmcptool": return "missing required 'toolName' or 'name' argument";
    default: {
      const keys = Object.keys(args);
      return keys.length === 0 ? "empty arguments object" : `arguments may be incomplete (got: ${keys.join(", ")})`;
    }
  }
}

function stripFinalMarker(text: string): string {
  return text.replace(/\s*<\/?(?:final_answer|answer)>\s*$/gi, "").trim();
}
