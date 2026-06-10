import type { ChatMessage, ToolDefinition, PreparedPrompt, ToolCall } from "./types.js";

// Track tool calls from assistant messages for round-trip fidelity
interface ToolCallMemory {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Convert OpenAI messages[] into a flat prompt text for the Cursor SDK.
 * Ported from composer-api worker/openai.ts prepareChatRequest() and prepareOpencodeSdkChatRequest().
 */
export function preparePrompt(
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  toolChoice?: string | { type: string; function?: { name: string } },
): PreparedPrompt {
  const hasTools = tools.length > 0;
  const mode = hasTools ? "agent" : "ask";
  const lines: string[] = [];

  // System directive
  if (hasTools) {
    lines.push(
      "You are running through an SDK-compatible OpenCode harness.",
      "OpenCode owns local tool execution. When local inspection, shell commands, or file changes are needed, request a tool call and wait for the tool result.",
      "When the conversation includes TOOL RESULT records, treat them as completed tool results for your previous tool requests and continue from those results.",
      "For creating new files when no specific client tool is requested, request write calls with both path and content. Do not use edit for new files.",
      "For project scaffolding when no specific client tool is requested, prefer bash with a complete command that creates files using heredocs, installs dependencies, and runs tests.",
      "When starting a dev server or other long-running watcher, start it in the background with output redirected and return immediately.",
      "Do not say that agent mode or tools are unavailable. Do not ask the user to switch modes.",
      "Use native tools (read, write, shell, edit, delete, glob, grep, ls) directly for all local operations. Do not use the mcp tool unless an MCP server is explicitly listed in the tool inventory.",
      ""
    );

    // Tool inventory
    appendToolInventory(lines, tools);

    // G4: tool_choice directive hints
    appendToolChoiceHints(lines, toolChoice);

    // SDK routing map
    appendSdkRoutingMap(lines, tools);

    // Workspace mutation detection
    const latestUserText = latestUserTextFromMessages(messages);
    const workspaceMutationRequired = shouldRequireLocalTool(latestUserText, tools);
    const workspaceMutationDone = workspaceMutationRequired && hasRequiredLocalToolCall(messages, tools);
    appendWorkspaceMutationRequirement(lines, workspaceMutationRequired, workspaceMutationDone, tools, latestUserText);
  } else {
    lines.push(
      "You are a helpful coding assistant. Answer the user's questions directly.",
      ""
    );
  }

  // Serialize messages
  const toolCallById = new Map<string, ToolCallMemory>();
  lines.push("Conversation:");

  for (const msg of messages) {
    const content = extractTextContent(msg);

    switch (msg.role) {
      case "system":
        lines.push(`SYSTEM: ${content}`);
        lines.push("");
        break;

      case "user":
        lines.push(`USER: ${content}`);
        lines.push("");
        break;

      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const toolCallsText = msg.tool_calls
            .map((tc) => `[tool_call] ${tc.function.name}(${tc.function.arguments})`)
            .join("\n");
          if (content) lines.push(`ASSISTANT: ${content}`);
          lines.push(toolCallsText);
          // Remember tool calls for round-trip fidelity
          rememberToolCalls(msg.tool_calls, toolCallById);
          lines.push("");
        } else {
          lines.push(`ASSISTANT: ${content}`);
          lines.push("");
        }
        break;

      case "tool":
        lines.push(
          `TOOL RESULT (${msg.name ? `name=${msg.name}` : ""}${msg.tool_call_id ? ` tool_call_id=${msg.tool_call_id}` : ""}): ${content || "[empty]"}`
        );
        // Emit structured SDK-native result for round-trip fidelity
        if (hasTools && msg.tool_call_id) {
          const feedback = sdkToolResultFeedback(msg.tool_call_id, msg.name ?? "", content, toolCallById, tools);
          lines.push(`SDK TOOL RESULT: ${JSON.stringify(feedback)}`);
        }
        lines.push("");
        break;
    }
  }

  return { text: lines.join("\n"), mode };
}

function extractTextContent(msg: ChatMessage): string {
  if (msg.content === null || msg.content === undefined) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return String(msg.content);
}

// --- Tool result round-tripping ---

function rememberToolCalls(
  toolCalls: ToolCall[],
  output: Map<string, ToolCallMemory>
): void {
  for (const tc of toolCalls) {
    if (!tc.id || !tc.function?.name) continue;
    let args: Record<string, unknown> = {};
    if (typeof tc.function.arguments === "string") {
      try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
    } else if (typeof tc.function.arguments === "object" && tc.function.arguments !== null) {
      args = tc.function.arguments as Record<string, unknown>;
    }
    output.set(tc.id, { name: tc.function.name, args });
  }
}

function sdkToolResultFeedback(
  toolCallId: string,
  fallbackToolName: string,
  resultText: string,
  toolCallById: Map<string, ToolCallMemory>,
  tools: ToolDefinition[]
): Record<string, unknown> {
  const original = toolCallById.get(toolCallId);
  const name = original?.name || fallbackToolName || "unknown";
  const args = original?.args ?? {};
  const canonical = opencodeCanonicalName(name);

  // For MCP tools, reconstruct the SDK mcp format with providerIdentifier and toolName
  let sdkName = canonical;
  let sdkArgs = args;
  if (canonical === "mcp" && name.includes("__")) {
    const parts = name.split("__").filter(Boolean);
    if (parts.length >= 3) {
      sdkName = "mcp";
      sdkArgs = {
        providerIdentifier: parts[1],
        toolName: parts.slice(2).join("__"),
        args,
      };
    }
  }

  return {
    type: "tool_call",
    call_id: toolCallId,
    name: sdkName,
    status: "completed",
    args: sdkArgs,
    result: formatToolResultForSdk(canonical, args, resultText),
  };
}

function formatToolResultForSdk(
  canonical: string,
  args: Record<string, unknown>,
  resultText: string
): Record<string, unknown> {
  const parsed = tryParseJson(resultText);
  const isError = isErrorResult(parsed, resultText);

  if (isError) {
    return { status: "error", error: { message: errorMessage(parsed, resultText) } };
  }

  switch (canonical) {
    case "shell":
      return {
        status: "success",
        value: {
          exitCode: numberFrom(parsed, ["exitCode", "exit_code", "code"]) ?? 0,
          stdout: stringFrom(parsed, ["stdout", "output", "text"]) ?? resultText,
          stderr: stringFrom(parsed, ["stderr", "error"]) ?? "",
          signal: stringFrom(parsed, ["signal"]) ?? null,
          executionTime: numberFrom(parsed, ["executionTime", "execution_time", "duration"]) ?? 0,
        },
      };
    case "read": {
      const content = stringFrom(parsed, ["content", "text", "output"]) ?? resultText;
      return {
        status: "success",
        value: { content, totalLines: lineCount(content), fileSize: content.length },
      };
    }
    case "write": {
      const content = stringArg(args, "content", "fileText", "text") ?? "";
      return {
        status: "success",
        value: {
          path: stringArg(args, "path", "filePath", "file") ?? "",
          linesCreated: lineCount(content),
          fileSize: content.length,
        },
      };
    }
    case "edit":
      return {
        status: "success",
        value: { diffString: stringFrom(parsed, ["diff", "diffString", "output"]) ?? resultText },
      };
    case "glob": {
      const files = stringsFrom(parsed, ["files", "paths"]) ?? resultTextLines(resultText);
      return { status: "success", value: { files, totalFiles: files.length } };
    }
    case "grep": {
      const matches = stringsFrom(parsed, ["matches", "results", "lines"]) ?? resultTextLines(resultText);
      return { status: "success", value: { matches, totalMatches: matches.length } };
    }
    default:
      return { status: "success", value: { text: resultText } };
  }
}

function opencodeCanonicalName(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["bash", "shell", "runshellcommand", "runterminalcommand", "terminal", "execute", "executecommand", "runcommand"].includes(n)) return "shell";
  if (["write", "writefile", "createfile"].includes(n)) return "write";
  if (["read", "readfile", "openfile", "viewfile"].includes(n)) return "read";
  if (["edit", "editfile", "replacefile", "searchreplace"].includes(n)) return "edit";
  if (["delete", "deletefile", "removefile"].includes(n)) return "delete";
  if (["grep", "search", "searchfiles", "ripgrep", "rg"].includes(n)) return "grep";
  if (["glob", "globfiles", "findfiles"].includes(n)) return "glob";
  if (["ls", "list", "listfiles", "listdirectory", "listdir"].includes(n)) return "ls";
  if (["todowrite", "updatetodos", "writetodos"].includes(n)) return "todowrite";
  if (n.startsWith("mcp")) return "mcp";
  return n;
}

// --- SDK routing map ---

function appendSdkRoutingMap(lines: string[], tools: ToolDefinition[]): void {
  const routes = sdkRoutingRecords(tools);
  if (!routes.length) return;
  lines.push(
    "SDK TOOL ROUTING MAP:",
    "These tool name mappings are available. Use the client tool names listed below."
  );
  for (const route of routes) {
    lines.push(JSON.stringify(route));
  }
  lines.push("");
}

function sdkRoutingRecords(tools: ToolDefinition[]): Record<string, unknown>[] {
  const routes: Record<string, unknown>[] = [];
  const samples: Array<{ sdk: string; args: Record<string, unknown> }> = [
    { sdk: "shell", args: { command: "ls -la", workingDirectory: "." } },
    { sdk: "read", args: { path: "src/index.ts", offset: 1, limit: 80 } },
    { sdk: "write", args: { path: "src/new.ts", fileText: "export {};" } },
    { sdk: "edit", args: { path: "src/index.ts", oldString: "old", newString: "new" } },
    { sdk: "glob", args: { targetDirectory: ".", globPattern: "**/*.ts" } },
    { sdk: "grep", args: { pattern: "TODO", path: ".", glob: "*.ts" } },
    { sdk: "ls", args: { path: "." } },
    { sdk: "todowrite", args: { todos: [{ content: "task", status: "in_progress", priority: "medium" }] } },
  ];

  for (const sample of samples) {
    const tool = findMatchingTool(sample.sdk, sample.args, tools);
    if (!tool) continue;
    routes.push({ sdk: sample.sdk, client: tool.function.name });
  }

  // MCP tools
  for (const tool of tools) {
    if (tool.function.name.startsWith("mcp__")) {
      const parts = tool.function.name.split("__");
      if (parts.length >= 3) {
        routes.push({
          sdk: "mcp",
          client: tool.function.name,
          sdkArgs: { providerIdentifier: parts[1], toolName: parts.slice(2).join("__") },
        });
      }
    }
  }

  return routes.slice(0, 16);
}

function findMatchingTool(
  sdkName: string,
  sdkArgs: Record<string, unknown>,
  tools: ToolDefinition[]
): ToolDefinition | undefined {
  const canonical = opencodeCanonicalName(sdkName);
  // Exact canonical match
  const exact = tools.find((t) => opencodeCanonicalName(t.function.name) === canonical);
  if (exact) return exact;
  // Schema compatibility check
  const compatible = tools.find((t) => schemaLooksCompatible(canonical, t));
  return compatible;
}

function schemaLooksCompatible(canonical: string, tool: ToolDefinition): boolean {
  const params = tool.function.parameters;
  if (!params || typeof params !== "object") return false;
  const properties = params.properties;
  if (!properties || typeof properties !== "object") return false;
  const keys = Object.keys(properties).map((k) => k.toLowerCase());
  const has = (candidates: string[]) => candidates.some((c) => keys.includes(c));

  switch (canonical) {
    case "shell": return has(["command", "cmd"]);
    case "write": return has(["path", "filepath", "file"]) && has(["content", "filetext", "text"]);
    case "read": return has(["path", "filepath", "file"]);
    case "edit": return has(["path", "filepath", "file"]) && has(["oldstring", "old_text", "old"]) && has(["newstring", "new_text", "new"]);
    case "grep": return has(["pattern", "query", "regex", "search"]);
    case "glob": return has(["pattern", "globpattern", "glob", "query"]);
    case "ls": return has(["path", "directory", "dir"]);
    case "todowrite": return has(["todos", "todolist", "items"]);
    default: return false;
  }
}

// --- Workspace mutation detection ---

const MUTATION_KEYWORDS = [
  "create", "write", "edit", "modify", "update", "change", "add", "append",
  "delete", "remove", "rename", "move", "scaffold", "generate", "implement",
  "fix", "patch", "refactor", "set up", "setup", "initialize", "init",
];

function shouldRequireLocalTool(latestUserText: string, tools: ToolDefinition[]): boolean {
  if (!tools.length || !latestUserText) return false;
  const lower = latestUserText.toLowerCase();
  return MUTATION_KEYWORDS.some((kw) => lower.includes(kw));
}

function hasRequiredLocalToolCall(messages: ChatMessage[], tools: ToolDefinition[]): boolean {
  const toolNames = new Set(tools.map((t) => opencodeCanonicalName(t.function.name)));
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (toolNames.has(opencodeCanonicalName(tc.function.name))) return true;
      }
    }
    if (msg.role === "user") break; // Only check after last user message
  }
  return false;
}

function latestUserTextFromMessages(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return extractTextContent(messages[i]);
  }
  return "";
}

function appendWorkspaceMutationRequirement(
  lines: string[],
  required: boolean,
  done: boolean,
  tools: ToolDefinition[],
  latestUserText: string
): void {
  if (!required) return;
  const requestedTool = explicitlyRequestedTool(latestUserText, tools);
  lines.push(
    "",
    "WORKSPACE MUTATION REQUIRED:",
    "The user is asking you to create or change project files. You must perform the change with the available tools.",
    "If the workspace is empty, create the necessary starter files directly. Do not output a standalone file for the user to save.",
  );
  if (done) {
    lines.push("A file-mutating tool call has already been made. After tool results confirm the change, briefly summarize what you created.");
  } else if (requestedTool) {
    lines.push(`Use the \`${requestedTool}\` tool now. Do not substitute a different tool.`);
  } else {
    lines.push("No file-mutating tool call has been made yet. Your next tool call must be write, edit, or bash with complete arguments.");
  }
  lines.push("");
}

function explicitlyRequestedTool(text: string, tools: ToolDefinition[]): string | undefined {
  const lower = text.toLowerCase();
  return tools
    .sort((a, b) => b.function.name.length - a.function.name.length)
    .find((t) => {
      const name = t.function.name.toLowerCase();
      return name.length > 3 && lower.includes(name);
    })?.function.name;
}

// --- Tool inventory ---

function appendToolInventory(lines: string[], tools: ToolDefinition[]): void {
  lines.push("Available tools:");
  for (const tool of tools) {
    const spec: Record<string, unknown> = { name: tool.function.name };
    if (tool.function.description) spec.description = tool.function.description;
    if (tool.function.parameters) spec.parameters = tool.function.parameters;
    lines.push(JSON.stringify(spec));
  }
  lines.push("");
}

// G4: tool_choice directive hints
function appendToolChoiceHints(lines: string[], toolChoice?: string | { type: string; function?: { name: string } }): void {
  if (!toolChoice) return;
  if (typeof toolChoice === "string") {
    if (toolChoice === "required") {
      lines.push("You must call at least one tool.", "");
    }
    return;
  }
  if (typeof toolChoice === "object" && toolChoice.type === "function" && toolChoice.function?.name) {
    lines.push(`Use the \`${toolChoice.function.name}\` tool if you call a tool.`, "");
  }
}

// --- Utility functions ---

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function isErrorResult(parsed: unknown, text: string): boolean {
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (p.isError === true || p.error !== undefined) return true;
    const exitCode = numberFrom(p, ["exitCode", "exit_code", "code"]);
    if (exitCode !== undefined && exitCode !== 0) return true;
  }
  return /^\s*(error|failed|exception)\b/i.test(text);
}

function errorMessage(parsed: unknown, text: string): string {
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (typeof p.error === "string") return p.error;
    if (p.error && typeof p.error === "object" && typeof (p.error as Record<string, unknown>).message === "string") {
      return (p.error as Record<string, unknown>).message as string;
    }
    if (typeof p.message === "string") return p.message;
  }
  return text || "Tool failed";
}

function stringFrom(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof r[key] === "string") return r[key] as string;
  }
  return undefined;
}

function numberFrom(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof r[key] === "number" && Number.isFinite(r[key])) return r[key] as number;
  }
  return undefined;
}

function stringsFrom(value: unknown, keys: string[]): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  for (const key of keys) {
    const arr = r[key];
    if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr as string[];
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof args[key] === "string" && (args[key] as string).trim()) return args[key] as string;
  }
  return undefined;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function resultTextLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim());
}
