// OpenAI Chat Completions request types
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  response_format?: { type: "text" | "json_object" | "json_schema"; [key: string]: unknown };
  n?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  reasoningEffort?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// OpenAI Chat Completions response types
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage;
  service_tier: "default";
  system_fingerprint: null;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
    refusal: null;
    annotations: unknown[];
  };
  logprobs: null;
  finish_reason: "stop" | "tool_calls";
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number; audio_tokens: number };
  completion_tokens_details: { reasoning_tokens: number; audio_tokens: number };
}

// OpenAI streaming chunk types
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage;
  service_tier: "default";
  system_fingerprint: null;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolCallDelta[];
  };
  logprobs: null;
  finish_reason: "stop" | "tool_calls" | null;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

// Cursor SDK types
export interface CursorToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// Internal types
export interface PreparedPrompt {
  text: string;
  mode: "ask" | "agent";
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: "cursor";
  name?: string;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  limit?: {
    context: number;
    output: number;
  };
  variants?: ModelVariant[];
}

export interface ModelVariant {
  id: string;
  name: string;
  params: { id: string; value: string }[];
}
