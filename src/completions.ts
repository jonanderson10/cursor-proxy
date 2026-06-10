import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCompletionRequest } from "./types.js";
import { preparePrompt } from "./prompt.js";
import { runAgent, runAgentStream } from "./cursor-agent.js";
import { chatCompletionResponse, streamChunks, toSdkCustomTools } from "./translate.js";
import { recordModel } from "./models.js";

/**
 * Handle POST /v1/chat/completions
 */
export async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string
): Promise<void> {
  let request: ChatCompletionRequest;
  try {
    const body = await readBody(req);
    request = parseRequest(body);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonError(res, error.status, error.message);
    }
    throw error;
  }

  // Validate required fields
  if (!request.model) {
    return jsonError(res, 400, "Missing required field: model");
  }
  if (!request.messages || request.messages.length === 0) {
    return jsonError(res, 400, "Missing required field: messages");
  }

  // #7 Request validation — reject unsupported parameters
  if (typeof request.n === "number" && request.n !== 1) {
    return jsonError(res, 400, "Only n=1 is supported");
  }
  if (request.logprobs || request.top_logprobs !== undefined) {
    return jsonError(res, 400, "logprobs are not available");
  }

  // Track unknown models for /v1/models discovery
  recordModel(request.model);

  const requestId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model = request.model;
  const tools = request.tools ?? [];
  const { text: prompt } = preparePrompt(request.messages, tools, request.tool_choice);
  const customTools = tools.length > 0 ? toSdkCustomTools(tools) : undefined;
  const requiresLocalTool = tools.length > 0;

  if (request.stream) {
    return handleStreaming(res, requestId, model, apiKey, prompt, tools, customTools, request.reasoningEffort, requiresLocalTool);
  }

  return handleNonStreaming(res, requestId, model, apiKey, prompt, tools, customTools, request.reasoningEffort, requiresLocalTool);
}

async function handleNonStreaming(
  res: ServerResponse,
  requestId: string,
  model: string,
  apiKey: string,
  prompt: string,
  tools: { type: "function"; function: { name: string } }[],
  customTools?: Record<string, import("@cursor/sdk").SDKCustomTool>,
  reasoningEffort?: string,
  requiresLocalTool?: boolean
): Promise<void> {
  try {
    const result = await runAgent({
      apiKey,
      model,
      prompt,
      reasoningEffort,
      customTools,
      requiresLocalTool,
    });

    const response = chatCompletionResponse({
      id: requestId,
      model,
      text: result.text,
      toolCalls: result.toolCalls,
      finishReason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
      promptText: prompt,
      tools,
    });

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(response));
  } catch (error) {
    console.error("Cursor SDK error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    jsonError(res, 502, message);
  }
}

/**
 * #6 True streaming — yields SSE chunks incrementally as events arrive.
 */
async function handleStreaming(
  res: ServerResponse,
  requestId: string,
  model: string,
  apiKey: string,
  prompt: string,
  tools: { type: "function"; function: { name: string } }[],
  customTools?: Record<string, import("@cursor/sdk").SDKCustomTool>,
  reasoningEffort?: string,
  requiresLocalTool?: boolean
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  try {
    const toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
    let streamedText = "";

    // Yield SSE chunks incrementally as events arrive
    for await (const event of runAgentStream({ apiKey, model, prompt, reasoningEffort, customTools, requiresLocalTool })) {
      if (event.type === "tool_call" && event.toolCall) {
        toolCalls.push(event.toolCall);
      } else if (event.type === "text" && event.text) {
        streamedText += event.text;
        // Emit text chunk immediately
        writeSSE(res, {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: event.text }, logprobs: null, finish_reason: null }],
          service_tier: "default",
          system_fingerprint: null,
        });
      } else if (event.type === "thinking" && event.text) {
        // Emit thinking chunk immediately
        writeSSE(res, {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { reasoning_content: event.text }, logprobs: null, finish_reason: null }],
          service_tier: "default",
          system_fingerprint: null,
        });
      }
    }

    // Emit role chunk at start (retroactive for clients that need it)
    // Note: Some clients expect the role chunk first. We emit it here as a
    // single combined chunk with tool_calls if present.
    if (toolCalls.length > 0) {
      // Emit tool calls as final chunk
      const { toOpenAiToolCalls } = await import("./translate.js");
      const openAiToolCalls = toOpenAiToolCalls(toolCalls, tools);
      writeSSE(res, {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
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
        }],
        service_tier: "default",
        system_fingerprint: null,
      });
    }

    // Finish chunk
    writeSSE(res, {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
      service_tier: "default",
      system_fingerprint: null,
    });

    // Usage chunk
    writeSSE(res, {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage: {
        prompt_tokens: Math.ceil((prompt?.length ?? 0) / 4) + 500,
        completion_tokens: Math.ceil(streamedText.length / 4),
        total_tokens: Math.ceil((prompt?.length ?? 0) / 4) + 500 + Math.ceil(streamedText.length / 4),
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
      },
      service_tier: "default",
      system_fingerprint: null,
    });

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Cursor SDK streaming error:", error);
    const errorChunk = {
      error: {
        message: error instanceof Error ? error.message : "Streaming error",
        type: "server_error",
        code: "cursor_sdk_error",
      },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function writeSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseRequest(body: string): ChatCompletionRequest {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError("Invalid JSON", 400);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new HttpError("Request body too large", 413));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        message,
        type: status >= 500 ? "api_error" : "invalid_request_error",
        code: status >= 500 ? "internal_error" : "invalid_request",
        status,
      },
    })
  );
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
