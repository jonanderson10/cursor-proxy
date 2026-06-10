import { describe, it, expect } from "vitest";
import { toOpenAiToolCalls, chatCompletionResponse, streamChunks, sdkToOpencodeToolName, toSdkCustomTools, resolveToolSpec, shellFallbackCommand, lsToGlobArguments, normalizeToolArguments } from "./translate.js";
import type { CursorToolCall, ToolDefinition } from "./types.js";

describe("sdkToOpencodeToolName", () => {
  it("translates shell to bash", () => {
    expect(sdkToOpencodeToolName("shell")).toBe("bash");
  });

  it("translates callmcptool to mcp", () => {
    expect(sdkToOpencodeToolName("callmcptool")).toBe("mcp");
  });

  it("translates readfile to read", () => {
    expect(sdkToOpencodeToolName("readfile")).toBe("read");
  });

  it("translates writefile to write", () => {
    expect(sdkToOpencodeToolName("writefile")).toBe("write");
  });

  it("translates editfile to edit", () => {
    expect(sdkToOpencodeToolName("editfile")).toBe("edit");
  });

  it("translates deletefile to delete", () => {
    expect(sdkToOpencodeToolName("deletefile")).toBe("delete");
  });

  it("translates listdirectory to glob", () => {
    expect(sdkToOpencodeToolName("listdirectory")).toBe("glob");
  });

  it("translates searchfiles to grep", () => {
    expect(sdkToOpencodeToolName("searchfiles")).toBe("grep");
  });

  it("translates readlints to bash", () => {
    expect(sdkToOpencodeToolName("readlints")).toBe("bash");
  });

  it("translates semanticsearch to grep", () => {
    expect(sdkToOpencodeToolName("semanticsearch")).toBe("grep");
  });

  it("translates updatetodos to todowrite", () => {
    expect(sdkToOpencodeToolName("updatetodos")).toBe("todowrite");
  });

  it("passes through unknown names unchanged", () => {
    expect(sdkToOpencodeToolName("customtool")).toBe("customtool");
    expect(sdkToOpencodeToolName("bash")).toBe("bash");
    expect(sdkToOpencodeToolName("read")).toBe("read");
  });

  it("is case-insensitive", () => {
    expect(sdkToOpencodeToolName("Shell")).toBe("bash");
    expect(sdkToOpencodeToolName("SHELL")).toBe("bash");
    expect(sdkToOpencodeToolName("ReadFile")).toBe("read");
  });
});

describe("toSdkCustomTools", () => {
  it("returns empty object for empty input", () => {
    expect(toSdkCustomTools([])).toEqual({});
  });

  it("converts a single tool definition", () => {
    const tools = [{
      type: "function" as const,
      function: { name: "bash", description: "Run a command", parameters: { command: { type: "string" } } },
    }];
    const result = toSdkCustomTools(tools);
    expect(result.bash).toBeDefined();
    expect(result.bash.description).toBe("Run a command");
    expect(result.bash.inputSchema).toEqual({ command: { type: "string" } });
    expect(typeof result.bash.execute).toBe("function");
  });

  it("converts multiple tool definitions", () => {
    const tools = [
      { type: "function" as const, function: { name: "bash" } },
      { type: "function" as const, function: { name: "read" } },
      { type: "function" as const, function: { name: "write" } },
    ];
    const result = toSdkCustomTools(tools);
    expect(Object.keys(result)).toEqual(["bash", "read", "write"]);
  });

  it("execute returns __pending__", async () => {
    const tools = [{
      type: "function" as const,
      function: { name: "test" },
    }];
    const result = toSdkCustomTools(tools);
    expect(await result.test.execute({}, {} as never)).toBe("__pending__");
  });

  it("handles missing description and parameters", () => {
    const tools = [{
      type: "function" as const,
      function: { name: "minimal" },
    }];
    const result = toSdkCustomTools(tools);
    expect(result.minimal.description).toBeUndefined();
    expect(result.minimal.inputSchema).toBeUndefined();
  });
});

describe("toOpenAiToolCalls", () => {
  it("returns empty array for empty input", () => {
    expect(toOpenAiToolCalls([])).toEqual([]);
  });

  it("converts a single tool call", () => {
    const result = toOpenAiToolCalls([{ name: "bash", arguments: { cmd: "ls" } }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "function",
      function: {
        name: "bash",
        arguments: '{"cmd":"ls"}',
      },
    });
    expect(result[0].id).toMatch(/^call_/);
  });

  it("converts multiple tool calls", () => {
    const result = toOpenAiToolCalls([
      { name: "read", arguments: { path: "a.ts" } },
      { name: "write", arguments: { path: "b.ts", content: "x" } },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("read");
    expect(result[1].function.name).toBe("write");
  });

  it("generates unique IDs", () => {
    const result = toOpenAiToolCalls([
      { name: "a", arguments: {} },
      { name: "b", arguments: {} },
    ]);
    expect(result[0].id).not.toBe(result[1].id);
  });

  it("passes through string arguments unchanged", () => {
    const result = toOpenAiToolCalls([
      { name: "test", arguments: '{"already":"string"}' as unknown as Record<string, unknown> },
    ]);
    expect(result[0].function.arguments).toBe('{"already":"string"}');
  });

  it("stringifies object arguments", () => {
    const args = { nested: { key: "value" }, arr: [1, 2] };
    const result = toOpenAiToolCalls([{ name: "test", arguments: args }]);
    expect(result[0].function.arguments).toBe(JSON.stringify(args));
  });
});

describe("chatCompletionResponse", () => {
  it("builds a text response", () => {
    const res = chatCompletionResponse({
      id: "chatcmpl-test123",
      model: "composer-2.5",
      text: "Hello world",
      toolCalls: [],
      finishReason: "stop",
    });
    expect(res.id).toBe("chatcmpl-test123");
    expect(res.object).toBe("chat.completion");
    expect(res.model).toBe("composer-2.5");
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0].message.content).toBe("Hello world");
    expect(res.choices[0].message.tool_calls).toBeUndefined();
    expect(res.choices[0].finish_reason).toBe("stop");
  });

  it("builds a tool_calls response", () => {
    const toolCalls: CursorToolCall[] = [{ name: "bash", arguments: { cmd: "ls" } }];
    const res = chatCompletionResponse({
      id: "chatcmpl-test123",
      model: "composer-2.5",
      text: "",
      toolCalls,
      finishReason: "tool_calls",
    });
    expect(res.choices[0].message.content).toBeNull();
    expect(res.choices[0].message.tool_calls).toHaveLength(1);
    expect(res.choices[0].message.tool_calls![0].function.name).toBe("bash");
    expect(res.choices[0].finish_reason).toBe("tool_calls");
  });

  it("includes usage with token estimates", () => {
    const res = chatCompletionResponse({
      id: "chatcmpl-test123",
      model: "composer-2.5",
      text: "Hello",
      toolCalls: [],
      finishReason: "stop",
    });
    expect(res.usage).toBeDefined();
    expect(res.usage.total_tokens).toBe(res.usage.prompt_tokens + res.usage.completion_tokens);
    expect(res.usage.prompt_tokens_details).toEqual({ cached_tokens: 0, audio_tokens: 0 });
    expect(res.usage.completion_tokens_details).toEqual({ reasoning_tokens: 0, audio_tokens: 0 });
  });

  it("includes service_tier and system_fingerprint", () => {
    const res = chatCompletionResponse({
      id: "chatcmpl-test123",
      model: "composer-2.5",
      text: "x",
      toolCalls: [],
      finishReason: "stop",
    });
    expect(res.service_tier).toBe("default");
    expect(res.system_fingerprint).toBeNull();
  });

  it("sets created timestamp", () => {
    const res = chatCompletionResponse({
      id: "chatcmpl-test123",
      model: "composer-2.5",
      text: "x",
      toolCalls: [],
      finishReason: "stop",
    });
    expect(typeof res.created).toBe("number");
    expect(res.created).toBeGreaterThan(0);
  });
});

describe("streamChunks", () => {
  async function collectChunks(opts: {
    id: string;
    model: string;
    eventStream: AsyncIterable<{ type: "text" | "thinking"; text: string }>;
    toolCalls: CursorToolCall[];
  }) {
    const chunks = [];
    for await (const chunk of streamChunks(opts)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("yields role chunk first", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () {})(),
      toolCalls: [],
    });
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].finish_reason).toBeNull();
  });

  it("yields text content chunks", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () { yield { type: "text" as const, text: "Hello" }; yield { type: "text" as const, text: " world" }; })(),
      toolCalls: [],
    });
    // role + "Hello" + " world" + finish + usage = 5
    expect(chunks).toHaveLength(5);
    expect(chunks[1].choices[0].delta.content).toBe("Hello");
    expect(chunks[2].choices[0].delta.content).toBe(" world");
  });

  it("yields finish chunk with stop reason for text", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () { yield { type: "text" as const, text: "x" }; })(),
      toolCalls: [],
    });
    const finish = chunks.find((c) => c.choices[0]?.finish_reason === "stop");
    expect(finish).toBeDefined();
  });

  it("yields usage chunk at the end", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () { yield { type: "text" as const, text: "x" }; })(),
      toolCalls: [],
    });
    const last = chunks[chunks.length - 1];
    expect(last.choices).toEqual([]);
    expect(last.usage).toBeDefined();
    expect(last.usage!.total_tokens).toBe(last.usage!.prompt_tokens + last.usage!.completion_tokens);
  });

  it("emits tool calls as single chunk", async () => {
    const toolCalls: CursorToolCall[] = [
      { name: "bash", arguments: { cmd: "ls" } },
      { name: "read", arguments: { path: "a.ts" } },
    ];
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () {})(),
      toolCalls,
    });
    // role + tool_calls + finish + usage = 4
    expect(chunks).toHaveLength(4);
    const tcChunk = chunks[1];
    expect(tcChunk.choices[0].delta.tool_calls).toHaveLength(2);
    expect(tcChunk.choices[0].delta.tool_calls![0].function?.name).toBe("bash");
    expect(tcChunk.choices[0].delta.tool_calls![1].function?.name).toBe("read");
  });

  it("tool calls get sequential index", async () => {
    const toolCalls: CursorToolCall[] = [
      { name: "a", arguments: {} },
      { name: "b", arguments: {} },
    ];
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () {})(),
      toolCalls,
    });
    const tcChunk = chunks[1];
    expect(tcChunk.choices[0].delta.tool_calls![0].index).toBe(0);
    expect(tcChunk.choices[0].delta.tool_calls![1].index).toBe(1);
  });

  it("tool calls finish_reason is tool_calls", async () => {
    const toolCalls: CursorToolCall[] = [{ name: "bash", arguments: {} }];
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () {})(),
      toolCalls,
    });
    const finish = chunks.find((c) => c.choices[0]?.finish_reason === "tool_calls");
    expect(finish).toBeDefined();
  });

  it("consistent id and model across all chunks", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-abc",
      model: "gpt-5.5",
      eventStream: (async function* () { yield { type: "text" as const, text: "x" }; })(),
      toolCalls: [],
    });
    for (const chunk of chunks) {
      expect(chunk.id).toBe("chatcmpl-abc");
      expect(chunk.model).toBe("gpt-5.5");
    }
  });

  it("empty text stream yields role + finish + usage", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      eventStream: (async function* () {})(),
      toolCalls: [],
    });
    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
    expect(chunks[2].choices).toEqual([]);
  });
});

// --- G2: Deep arg normalization ---

function makeTool(name: string, params?: Record<string, unknown>): ToolDefinition {
  return { type: "function", function: { name, parameters: params } };
}

describe("resolveToolSpec", () => {
  const tools: ToolDefinition[] = [
    makeTool("bash", { type: "object", properties: { command: { type: "string" } } }),
    makeTool("read", { type: "object", properties: { path: { type: "string" } } }),
    makeTool("write", { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }),
    makeTool("edit", { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } }),
    makeTool("grep", { type: "object", properties: { pattern: { type: "string" } } }),
    makeTool("glob", { type: "object", properties: { pattern: { type: "string" } } }),
  ];

  it("finds bash for shell", () => {
    expect(resolveToolSpec("shell", tools)?.function.name).toBe("bash");
  });

  it("finds read for readfile", () => {
    expect(resolveToolSpec("readfile", tools)?.function.name).toBe("read");
  });

  it("finds write for writefile", () => {
    expect(resolveToolSpec("writefile", tools)?.function.name).toBe("write");
  });

  it("finds edit for editfile", () => {
    expect(resolveToolSpec("editfile", tools)?.function.name).toBe("edit");
  });

  it("finds grep for searchfiles", () => {
    expect(resolveToolSpec("searchfiles", tools)?.function.name).toBe("grep");
  });

  it("finds glob for listdirectory when glob tool has path property", () => {
    const globWithPath: ToolDefinition[] = [
      makeTool("glob", { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } } }),
    ];
    expect(resolveToolSpec("listdirectory", globWithPath)?.function.name).toBe("glob");
  });

  it("falls back to shell for unknown tool", () => {
    expect(resolveToolSpec("semsearch", tools)?.function.name).toBe("bash");
  });

  it("returns undefined when no tools", () => {
    expect(resolveToolSpec("shell", [])).toBeUndefined();
  });

  it("finds mcp tool for mcp name", () => {
    const mcpTools: ToolDefinition[] = [
      makeTool("mcp__filesystem__read_file", { type: "object", properties: { path: { type: "string" } } }),
    ];
    expect(resolveToolSpec("mcp", mcpTools)?.function.name).toBe("mcp__filesystem__read_file");
  });

  it("does not fall back to shell for read", () => {
    // read should NOT fall back to shell — only non-read/glob/ls tools do
    const shellOnly: ToolDefinition[] = [
      makeTool("bash", { type: "object", properties: { command: { type: "string" } } }),
    ];
    expect(resolveToolSpec("read", shellOnly)).toBeUndefined();
  });
});

describe("shellFallbackCommand", () => {
  it("generates cat for read", () => {
    expect(shellFallbackCommand("read", { path: "src/index.ts" })).toBe("cat src/index.ts");
  });

  it("generates cat heredoc for write", () => {
    const cmd = shellFallbackCommand("write", { path: "f.txt", fileText: "hello" });
    expect(cmd).toContain("cat > f.txt");
    expect(cmd).toContain("hello");
  });

  it("generates touch for write without content", () => {
    expect(shellFallbackCommand("write", { path: "f.txt" })).toBe("touch f.txt");
  });

  it("generates python for edit", () => {
    const cmd = shellFallbackCommand("edit", { path: "f.txt", oldString: "a", newString: "b" });
    expect(cmd).toContain("python3");
    expect(cmd).toContain("replace");
  });

  it("generates rm for delete", () => {
    expect(shellFallbackCommand("delete", { path: "f.txt" })).toContain("rm");
  });

  it("generates rg for grep", () => {
    const cmd = shellFallbackCommand("grep", { pattern: "TODO", path: "src" });
    expect(cmd).toContain("rg");
    expect(cmd).toContain("TODO");
  });

  it("generates ls for ls", () => {
    expect(shellFallbackCommand("ls", { path: "src" })).toBe("ls -la src");
  });

  it("generates python glob for glob", () => {
    const cmd = shellFallbackCommand("glob", { globPattern: "**/*.ts" });
    expect(cmd).toContain("python3");
    expect(cmd).toContain("glob");
  });

  it("returns undefined for unknown tool", () => {
    expect(shellFallbackCommand("unknown", {})).toBeUndefined();
  });

  it("returns undefined for write without path", () => {
    expect(shellFallbackCommand("write", { content: "hi" })).toBeUndefined();
  });

  it("returns undefined for grep without pattern", () => {
    expect(shellFallbackCommand("grep", { path: "." })).toBeUndefined();
  });
});

describe("lsToGlobArguments", () => {
  it("converts path to glob pattern", () => {
    expect(lsToGlobArguments({ path: "src" })).toEqual({ pattern: "src/*", path: "src" });
  });

  it("defaults to current directory", () => {
    expect(lsToGlobArguments({})).toEqual({ pattern: "./*", path: "." });
  });
});

describe("normalizeToolArguments", () => {
  const readTool: ToolDefinition = {
    type: "function",
    function: {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    },
  };

  const editTool: ToolDefinition = {
    type: "function",
    function: {
      name: "edit",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
        },
        required: ["filePath", "oldString", "newString"],
      },
    },
  };

  const bashTool: ToolDefinition = {
    type: "function",
    function: {
      name: "bash",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  it("maps SDK path to filePath via alias", () => {
    const result = normalizeToolArguments({ path: "src/index.ts" }, "read", [readTool]);
    expect(result).toEqual({ filePath: "src/index.ts" });
  });

  it("maps SDK filePath directly via normalizedProps", () => {
    const result = normalizeToolArguments({ filePath: "src/index.ts" }, "read", [readTool]);
    expect(result).toEqual({ filePath: "src/index.ts" });
  });

  it("maps SDK oldString/newString directly via normalizedProps", () => {
    const result = normalizeToolArguments(
      { filePath: "f.txt", oldString: "a", newString: "b" },
      "edit",
      [editTool],
    );
    expect(result).toEqual({ filePath: "f.txt", oldString: "a", newString: "b" });
  });

  it("maps SDK cmd to command via alias", () => {
    const result = normalizeToolArguments({ cmd: "ls -la" }, "bash", [bashTool]);
    expect(result).toEqual({ command: "ls -la" });
  });

  it("passes through unmapped keys unchanged", () => {
    const result = normalizeToolArguments({ command: "ls", extra: "val" }, "bash", [bashTool]);
    expect(result).toEqual({ command: "ls", extra: "val" });
  });

  it("returns args unchanged when tool not found", () => {
    const result = normalizeToolArguments({ path: "f.txt" }, "unknown_tool", [readTool]);
    expect(result).toEqual({ path: "f.txt" });
  });

  it("maps file_path to filePath via alias chain", () => {
    const result = normalizeToolArguments({ file_path: "src/index.ts" }, "read", [readTool]);
    expect(result).toEqual({ filePath: "src/index.ts" });
  });

  it("resolves MCP tool name to underlying tool spec", () => {
    const result = normalizeToolArguments({ path: "src/index.ts" }, "mcp__filesystem__read", [readTool]);
    expect(result).toEqual({ filePath: "src/index.ts" });
  });

  it("resolves SDK tool name via resolveToolSpec canonical matching", () => {
    const result = normalizeToolArguments({ path: "src/index.ts" }, "readfile", [readTool]);
    expect(result).toEqual({ filePath: "src/index.ts" });
  });
});
