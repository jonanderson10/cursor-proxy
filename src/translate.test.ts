import { describe, it, expect } from "vitest";
import { toOpenAiToolCalls, chatCompletionResponse, streamChunks } from "./translate.js";
import type { CursorToolCall } from "./types.js";

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
    textStream: AsyncIterable<string>;
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
      textStream: (async function* () {})(),
      toolCalls: [],
    });
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[0].choices[0].finish_reason).toBeNull();
  });

  it("yields text content chunks", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      textStream: (async function* () { yield "Hello"; yield " world"; })(),
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
      textStream: (async function* () { yield "x"; })(),
      toolCalls: [],
    });
    const finish = chunks.find((c) => c.choices[0]?.finish_reason === "stop");
    expect(finish).toBeDefined();
  });

  it("yields usage chunk at the end", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-test",
      model: "composer-2.5",
      textStream: (async function* () { yield "x"; })(),
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
      textStream: (async function* () {})(),
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
      textStream: (async function* () {})(),
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
      textStream: (async function* () {})(),
      toolCalls,
    });
    const finish = chunks.find((c) => c.choices[0]?.finish_reason === "tool_calls");
    expect(finish).toBeDefined();
  });

  it("consistent id and model across all chunks", async () => {
    const chunks = await collectChunks({
      id: "chatcmpl-abc",
      model: "gpt-5.5",
      textStream: (async function* () { yield "x"; })(),
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
      textStream: (async function* () {})(),
      toolCalls: [],
    });
    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
    expect(chunks[2].choices).toEqual([]);
  });
});
