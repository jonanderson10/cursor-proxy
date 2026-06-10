import type {
  CursorToolCall,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./types.js";
import type { SDKCustomTool } from "@cursor/sdk";
import { get_encoding } from "tiktoken";
import { findModel } from "./models.js";

// --- Tool name translation ---

/** Map SDK built-in tool names back to opencode tool names. */
const SDK_TO_OPENCODE: Record<string, string> = {
  shell: "bash",
  callmcptool: "mcp",
  readfile: "read",
  writefile: "write",
  editfile: "edit",
  deletefile: "delete",
  listdirectory: "glob",
  searchfiles: "grep",
  readlints: "bash",
  semanticsearch: "grep",
  updatetodos: "todowrite",
};

/**
 * Translate an SDK tool name back to the opencode equivalent.
 * Returns the original name if no translation exists.
 */
export function sdkToOpencodeToolName(sdkName: string): string {
  return SDK_TO_OPENCODE[sdkName.toLowerCase()] ?? sdkName;
}

/**
 * Convert OpenAI ToolDefinition[] to SDK customTools format.
 * Each tool gets a no-op execute — we intercept via onDelta before execution.
 */
export function toSdkCustomTools(
  tools: ToolDefinition[]
): Record<string, SDKCustomTool> {
  const result: Record<string, SDKCustomTool> = {};
  for (const tool of tools) {
    result[tool.function.name] = {
      description: tool.function.description,
      inputSchema: tool.function.parameters as Record<string, import("@cursor/sdk").SDKJsonValue> | undefined,
      execute: async () => "__pending__",
    };
  }
  return result;
}

// --- Tool argument normalization ---

const KNOWN_CANONICAL = new Set(["shell", "write", "read", "edit", "delete", "grep", "glob", "ls", "todowrite"]);

/**
 * Normalize tool arguments from SDK format to client tool format.
 * Ported from composer-api openai.ts normalizeToolArguments().
 */
export function normalizeToolArguments(
  args: Record<string, unknown>,
  toolName: string,
  tools: ToolDefinition[]
): Record<string, unknown> {
  const tool = resolveToolSpec(toolName, tools);
  if (!tool?.function?.parameters || typeof tool.function.parameters !== "object") return args;

  const params = tool.function.parameters as Record<string, unknown>;
  const properties = params.properties;
  if (!properties || typeof properties !== "object") return args;

  const propKeys = Object.keys(properties as Record<string, unknown>);
  const normalizedProps = new Map(propKeys.map((k) => [k.toLowerCase().replace(/[^a-z0-9]/g, ""), k]));

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const mapped = normalizedProps.get(normalizedKey);
    if (mapped) {
      output[mapped] = value;
    } else {
      // Try common alias mappings (single target or multiple candidates)
      const alias = ARGUMENT_ALIASES[normalizedKey];
      if (alias) {
        if (Array.isArray(alias)) {
          // Multiple candidates — try each until one matches schema
          const candidate = alias.find((c) => normalizedProps.has(c));
          if (candidate) {
            output[normalizedProps.get(candidate)!] = value;
          } else {
            output[key] = value;
          }
        } else if (normalizedProps.has(alias)) {
          output[normalizedProps.get(alias)!] = value;
        } else {
          output[key] = value;
        }
      } else {
        output[key] = value;
      }
    }
  }
  return output;
}

const ARGUMENT_ALIASES: Record<string, string | string[]> = {
  filetext: "content",
  filecontent: "content",
  file_path: "path",
  filepath: "path",
  file: "path",
  path: ["filepath", "path", "directory", "cwd", "pattern"],
  oldstring: "old_string",
  oldtext: "old_string",
  old: "old_string",
  newstring: "new_string",
  newtext: "new_string",
  new: "new_string",
  globpattern: "pattern",
  cmd: "command",
  cmdstring: "command",
  workingdirectory: "cwd",
  workdir: "cwd",
  targetdirectory: "path",
  target_directory: "path",
};

// --- G2: Deep arg normalization ---

const PATH_KEYS = ["path", "filePath", "file_path", "filename", "file", "target", "targetPath", "target_path", "targetFile", "target_file"];
const OLD_TEXT_KEYS = ["oldString", "old_string", "old_str", "oldText", "old_text", "oldContents", "old_contents", "old", "search", "searchString", "search_string"];
const NEW_TEXT_KEYS = ["newString", "new_string", "new_str", "newText", "new_text", "replacement", "replace", "content"];
const FILE_CONTENT_KEYS = ["fileText", "file_text", "content", "contents", "text", "body", "data", "fileContent", "file_content", "streamContent", "stream_content"];

/**
 * Resolve an SDK-emitted tool name to the best matching client tool.
 * Ported from composer-api openai.ts resolveToolSpec().
 */
export function resolveToolSpec(
  sdkToolName: string,
  tools: ToolDefinition[]
): ToolDefinition | undefined {
  const canonical = sdkCanonicalName(sdkToolName);
  // 1. Exact canonical name match
  const exact = tools.find((t) => sdkCanonicalName(t.function.name) === canonical);
  if (exact) return exact;
  // 2. Normalized match
  const normalized = tools.find((t) => normalizeToolName(t.function.name) === canonical);
  if (normalized) return normalized;
  // 3. MCP tool routing — bare mcp/callmcptool
  if (canonical === "mcp" || canonical === "callmcptool") {
    const mcpTool = tools.find((t) => t.function.name.startsWith("mcp__"));
    if (mcpTool) return mcpTool;
  }
  // 3b. MCP tool routing — mcp__provider__toolName → match underlying tool
  if (sdkToolName.startsWith("mcp__")) {
    const parts = sdkToolName.split("__");
    if (parts.length >= 3) {
      const underlying = parts.slice(2).join("__");
      const underlyingTool = tools.find((t) => sdkCanonicalName(t.function.name) === sdkCanonicalName(underlying));
      if (underlyingTool) return underlyingTool;
      // Also try exact match on the mcp__ name itself
      const exactMcp = tools.find((t) => t.function.name === sdkToolName);
      if (exactMcp) return exactMcp;
    }
  }
  // 4. Schema compatibility
  const compatible = tools.find((t) => toolSchemaLooksCompatible(canonical, t));
  if (compatible) return compatible;
  // 5. Shell fallback
  const shellTool = tools.find((t) => sdkCanonicalName(t.function.name) === "shell");
  if (shellTool && !["read", "glob", "ls"].includes(canonical)) return shellTool;
  return undefined;
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sdkCanonicalName(name: string): string {
  const n = normalizeToolName(name);
  if (["bash", "shell", "runshellcommand", "runterminalcommand", "terminal", "execute", "executecommand", "runcommand", "run"].includes(n)) return "shell";
  if (["write", "writefile", "createfile"].includes(n)) return "write";
  if (["read", "readfile", "openfile", "viewfile"].includes(n)) return "read";
  if (["edit", "editfile", "replacefile", "searchreplace"].includes(n)) return "edit";
  if (["delete", "deletefile", "removefile"].includes(n)) return "delete";
  if (["grep", "search", "searchfiles", "ripgrep", "rg"].includes(n)) return "grep";
  if (["glob", "globfiles", "findfiles", "find", "findfile"].includes(n)) return "glob";
  if (["ls", "list", "listfiles", "listdirectory", "listdir"].includes(n)) return "ls";
  if (["todowrite", "updatetodos", "writetodos"].includes(n)) return "todowrite";
  if (n.startsWith("mcp")) return "mcp";
  return n;
}

function toolSchemaLooksCompatible(canonical: string, tool: ToolDefinition): boolean {
  const params = tool.function.parameters;
  if (!params || typeof params !== "object") return false;
  const properties = (params as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") return false;
  const keys = Object.keys(properties as Record<string, unknown>).map((k) => k.toLowerCase());
  const has = (candidates: string[]) => candidates.some((c) => keys.includes(c));

  switch (canonical) {
    case "shell": return has(["command", "cmd"]);
    case "write": return has(["path", "filepath", "file"]) && has(["content", "filetext", "text"]);
    case "read": return has(["path", "filepath", "file"]);
    case "edit": return has(["path", "filepath", "file"]) && (has(["oldstring", "old_text", "old"]) || has(["patch", "diff"]));
    case "grep": return has(["pattern", "query", "regex", "search"]);
    case "glob": return has(["pattern", "globpattern", "glob", "query"]);
    case "ls": return has(["path", "directory", "dir"]);
    case "todowrite": return has(["todos", "todolist", "items"]);
    default: return false;
  }
}

function firstArgValue(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof args[key] === "string" && (args[key] as string).trim()) return args[key] as string;
  }
  return undefined;
}

function firstArgValueAllowEmpty(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return undefined;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9._\-\/=]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Generate a shell command that replicates the given SDK tool call.
 * Used as fallback when the client only exposes a shell tool.
 */
export function shellFallbackCommand(sdkName: string, args: Record<string, unknown>): string | undefined {
  const canonical = sdkCanonicalName(sdkName);
  switch (canonical) {
    case "write": {
      const path = firstArgValue(args, PATH_KEYS);
      const content = firstArgValueAllowEmpty(args, FILE_CONTENT_KEYS);
      if (!path) return undefined;
      if (content === undefined) return `touch ${shellQuote(path)}`;
      return `cat > ${shellQuote(path)} <<'CURSOR_PROXY_EOF'\n${content}\nCURSOR_PROXY_EOF`;
    }
    case "read": {
      const path = firstArgValue(args, PATH_KEYS);
      if (!path) return undefined;
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (offset || limit) {
        const start = offset ? offset + 1 : 1;
        const end = limit ? start + limit - 1 : "";
        return `sed -n '${start},${end}p' ${shellQuote(path)}`;
      }
      return `cat ${shellQuote(path)}`;
    }
    case "edit": {
      const path = firstArgValue(args, PATH_KEYS);
      const oldStr = firstArgValueAllowEmpty(args, OLD_TEXT_KEYS);
      const newStr = firstArgValueAllowEmpty(args, NEW_TEXT_KEYS);
      if (!path || oldStr === undefined || newStr === undefined) return undefined;
      return `python3 - <<'PY'\nfrom pathlib import Path\npath = Path(${JSON.stringify(path)})\nold = ${JSON.stringify(oldStr)}\nnew = ${JSON.stringify(newStr)}\ntext = path.read_text()\nif old not in text:\n    raise SystemExit(f"oldString not found in {path}")\npath.write_text(text.replace(old, new, 1))\nPY`;
    }
    case "delete": {
      const path = firstArgValue(args, PATH_KEYS);
      if (!path) return undefined;
      return `rm -rf ${shellQuote(path)}`;
    }
    case "grep": {
      const pattern = firstArgValue(args, ["pattern", "query", "regex", "search", "searchPattern"]);
      if (!pattern) return undefined;
      const targetPath = firstArgValue(args, [...PATH_KEYS, "directory", "dir"]) || ".";
      const include = firstArgValue(args, ["glob", "include", "includeGlob", "fileGlob"]);
      return ["rg", "--line-number", "--color", "never", "--hidden", include ? `--glob ${shellQuote(include)}` : "", shellQuote(pattern), shellQuote(targetPath)]
        .filter(Boolean).join(" ");
    }
    case "glob": {
      const pattern = firstArgValue(args, ["globPattern", "glob_pattern", "pattern", "glob", "filePattern", "file_pattern"]) || "**/*";
      const path = firstArgValue(args, [...PATH_KEYS, "targetDirectory", "target_directory"]) || ".";
      return `python3 - <<'PY'\nfrom pathlib import Path\nbase = Path(${JSON.stringify(path)})\npattern = ${JSON.stringify(pattern)}\nfor item in sorted(base.glob(pattern)):\n    print(item)\nPY`;
    }
    case "ls": {
      const path = firstArgValue(args, [...PATH_KEYS, "directory", "dir"]) || ".";
      return `ls -la ${shellQuote(path)}`;
    }
    case "semsearch":
    case "semanticsearch": {
      const query = firstArgValue(args, ["query", "pattern", "search"]);
      if (!query) return undefined;
      const directories = Array.isArray(args.targetDirectories) ? args.targetDirectories as string[] : [];
      return ["rg", "--line-number", "--color", "never", "--hidden", shellQuote(query), ...(directories.length ? directories : ["."]).map(shellQuote)].join(" ");
    }
    default:
      return undefined;
  }
}

/**
 * Convert ls-style arguments to glob-style when the client only exposes a glob tool.
 */
export function lsToGlobArguments(args: Record<string, unknown>): Record<string, unknown> {
  const path = firstArgValue(args, [...PATH_KEYS, "directory", "dir"]) || ".";
  return { pattern: `${path}/*`, path };
}

const CREATED = Math.floor(Date.now() / 1000);

// Lazy singleton — tiktoken's WASM encoder loaded once on first use
let _encoder: ReturnType<typeof get_encoding> | null = null;
function encoder() {
  if (!_encoder) _encoder = get_encoding("cl100k_base");
  return _encoder;
}

/**
 * Convert Cursor SDK tool calls to OpenAI tool_calls format.
 */
export function toOpenAiToolCalls(
  sdkToolCalls: CursorToolCall[],
  tools?: ToolDefinition[]
): ToolCall[] {
  return sdkToolCalls.map((tc, i) => {
    const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(
      tools ? normalizeToolArguments(tc.arguments as Record<string, unknown>, tc.name, tools) : tc.arguments
    );
    return {
      id: `call_${randomId()}`,
      type: "function" as const,
      function: { name: tc.name, arguments: args },
    };
  });
}

/**
 * Build a non-streaming OpenAI chat completion response.
 */
export function chatCompletionResponse(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: CursorToolCall[];
  finishReason: "stop" | "tool_calls";
  promptText?: string;
  tools?: ToolDefinition[];
}): ChatCompletionResponse {
  const openAiToolCalls =
    opts.toolCalls.length > 0 ? toOpenAiToolCalls(opts.toolCalls, opts.tools) : undefined;
  const promptTokens = estimateTokens(opts.promptText ?? "") + 500;
  const completionTokens = estimateTokens(opts.text);

  return {
    id: opts.id,
    object: "chat.completion",
    created: CREATED,
    model: opts.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: opts.toolCalls.length > 0 ? null : opts.text,
          tool_calls: openAiToolCalls,
          refusal: null,
          annotations: [],
        },
        logprobs: null,
        finish_reason: opts.finishReason,
      },
    ],
    usage: makeUsage(promptTokens, completionTokens, opts.model),
    service_tier: "default",
    system_fingerprint: null,
  };
}

/**
 * Emit SSE chunks for a streaming response.
 * Returns an async generator that yields chunk objects.
 */
export async function* streamChunks(opts: {
  id: string;
  model: string;
  eventStream: AsyncIterable<{ type: "text" | "thinking"; text: string }>;
  toolCalls: CursorToolCall[];
  promptText?: string;
  tools?: ToolDefinition[];
}): AsyncGenerator<ChatCompletionChunk> {
  // Role chunk
  yield {
    id: opts.id,
    object: "chat.completion.chunk",
    created: CREATED,
    model: opts.model,
    choices: [
      { index: 0, delta: { role: "assistant" }, logprobs: null, finish_reason: null },
    ],
    service_tier: "default",
    system_fingerprint: null,
  };

  let streamedText = "";

  if (opts.toolCalls.length > 0) {
    // Tool calls — emit as a single chunk
    const openAiToolCalls = toOpenAiToolCalls(opts.toolCalls, opts.tools);
    yield {
      id: opts.id,
      object: "chat.completion.chunk",
      created: CREATED,
      model: opts.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: openAiToolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: "function" as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
      service_tier: "default",
      system_fingerprint: null,
    };
  } else {
    // Text and thinking content chunks
    for await (const event of opts.eventStream) {
      if (event.type === "thinking") {
        yield {
          id: opts.id,
          object: "chat.completion.chunk",
          created: CREATED,
          model: opts.model,
          choices: [
            { index: 0, delta: { reasoning_content: event.text }, logprobs: null, finish_reason: null },
          ],
          service_tier: "default",
          system_fingerprint: null,
        };
      } else {
        streamedText += event.text;
        yield {
          id: opts.id,
          object: "chat.completion.chunk",
          created: CREATED,
          model: opts.model,
          choices: [
            { index: 0, delta: { content: event.text }, logprobs: null, finish_reason: null },
          ],
          service_tier: "default",
          system_fingerprint: null,
        };
      }
    }
  }

  // Finish chunk
  yield {
    id: opts.id,
    object: "chat.completion.chunk",
    created: CREATED,
    model: opts.model,
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: opts.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    service_tier: "default",
    system_fingerprint: null,
  };

  // Usage chunk
  const promptTokens = estimateTokens(opts.promptText ?? "") + 500;
  const completionTokens = estimateTokens(
    opts.toolCalls.length > 0
      ? JSON.stringify(opts.toolCalls)
      : streamedText
  );
  yield {
    id: opts.id,
    object: "chat.completion.chunk",
    created: CREATED,
    model: opts.model,
    choices: [],
    usage: makeUsage(promptTokens, completionTokens, opts.model),
    service_tier: "default",
    system_fingerprint: null,
  };
}

function makeUsage(promptTokens: number, completionTokens: number, model?: string): Usage {
  const base: Usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
  };

  if (model) {
    const info = findModel(model);
    if (info?.cost) {
      const inputCost = (promptTokens / 1_000_000) * info.cost.input;
      const outputCost = (completionTokens / 1_000_000) * info.cost.output;
      (base as unknown as Record<string, unknown>).cost = {
        currency: "USD",
        estimated: true,
        input_usd: roundUsd(inputCost),
        output_usd: roundUsd(outputCost),
        total_usd: roundUsd(inputCost + outputCost),
      };
    }
  }

  return base;
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return encoder().encode(text).length;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 14);
}
