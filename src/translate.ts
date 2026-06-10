import type {
  CursorToolCall,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ToolCall,
  Usage,
} from "./types.js";
import { get_encoding } from "tiktoken";

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
  sdkToolCalls: CursorToolCall[]
): ToolCall[] {
  return sdkToolCalls.map((tc, i) => ({
    id: `call_${randomId()}`,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
    },
  }));
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
}): ChatCompletionResponse {
  const openAiToolCalls =
    opts.toolCalls.length > 0 ? toOpenAiToolCalls(opts.toolCalls) : undefined;
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
    usage: makeUsage(promptTokens, completionTokens),
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
  textStream: AsyncIterable<string>;
  toolCalls: CursorToolCall[];
  promptText?: string;
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
    const openAiToolCalls = toOpenAiToolCalls(opts.toolCalls);
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
    // Text content chunks
    for await (const chunk of opts.textStream) {
      streamedText += chunk;
      yield {
        id: opts.id,
        object: "chat.completion.chunk",
        created: CREATED,
        model: opts.model,
        choices: [
          { index: 0, delta: { content: chunk }, logprobs: null, finish_reason: null },
        ],
        service_tier: "default",
        system_fingerprint: null,
      };
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
    usage: makeUsage(promptTokens, completionTokens),
    service_tier: "default",
    system_fingerprint: null,
  };
}

function makeUsage(promptTokens: number, completionTokens: number): Usage {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
  };
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return encoder().encode(text).length;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 14);
}
