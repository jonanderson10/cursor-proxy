import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCompletionRequest } from "./types.js";
import { preparePrompt } from "./prompt.js";
import { runAgent, runAgentStream } from "./cursor-agent.js";
import { chatCompletionResponse, streamChunks } from "./translate.js";
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

  // Validate
  if (!request.model) {
    return jsonError(res, 400, "Missing required field: model");
  }
  if (!request.messages || request.messages.length === 0) {
    return jsonError(res, 400, "Missing required field: messages");
  }

  // Track unknown models for /v1/models discovery
  recordModel(request.model);

  const requestId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model = request.model;
  const tools = request.tools ?? [];
  const { text: prompt } = preparePrompt(request.messages, tools);

  if (request.stream) {
    return handleStreaming(res, requestId, model, apiKey, prompt, tools, request.reasoningEffort);
  }

  return handleNonStreaming(res, requestId, model, apiKey, prompt, request.reasoningEffort);
}

async function handleNonStreaming(
  res: ServerResponse,
  requestId: string,
  model: string,
  apiKey: string,
  prompt: string,
  reasoningEffort?: string
): Promise<void> {
  try {
    const result = await runAgent({
      apiKey,
      model,
      prompt,
      reasoningEffort,
    });

    const response = chatCompletionResponse({
      id: requestId,
      model,
      text: result.text,
      toolCalls: result.toolCalls,
      finishReason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
      promptText: prompt,
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

async function handleStreaming(
  res: ServerResponse,
  requestId: string,
  model: string,
  apiKey: string,
  prompt: string,
  tools: { type: "function"; function: { name: string } }[],
  reasoningEffort?: string
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  try {
    // Collect tool calls or stream text
    const toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
    const textChunks: string[] = [];

    for await (const event of runAgentStream({ apiKey, model, prompt, reasoningEffort })) {
      if (event.type === "tool_call" && event.toolCall) {
        toolCalls.push(event.toolCall);
      } else if (event.type === "text" && event.text) {
        textChunks.push(event.text);
      }
    }

    // Now emit SSE chunks
    const textStream = async function* () {
      for (const chunk of textChunks) yield chunk;
    };

    for await (const chunk of streamChunks({
      id: requestId,
      model,
      textStream: textStream(),
      toolCalls,
      promptText: prompt,
    })) {
      writeSSE(res, chunk);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Cursor SDK streaming error:", error);
    // Emit error as SSE event
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
