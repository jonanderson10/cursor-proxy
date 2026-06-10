import type { ChatMessage, ToolDefinition, PreparedPrompt } from "./types.js";

/**
 * Convert OpenAI messages[] into a flat prompt text for the Cursor SDK.
 * Ported from composer-api worker/openai.ts prepareChatRequest().
 */
export function preparePrompt(
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
): PreparedPrompt {
  const hasTools = tools.length > 0;
  const mode = hasTools ? "agent" : "ask";
  const lines: string[] = [];

  // System directive
  if (hasTools) {
    lines.push(
      "You are an agent. When the user request requires a local tool, call a tool immediately.",
      "Do not say you cannot run tools; use the available tools.",
      ""
    );
  } else {
    lines.push(
      "You are a helpful coding assistant. Answer the user's questions directly.",
      ""
    );
  }

  // Serialize messages
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
          // Assistant message with tool calls
          const toolCallsText = msg.tool_calls
            .map(
              (tc) =>
                `[tool_call] ${tc.function.name}(${tc.function.arguments})`
            )
            .join("\n");
          if (content) {
            lines.push(`ASSISTANT: ${content}`);
          }
          lines.push(toolCallsText);
          lines.push("");
        } else {
          lines.push(`ASSISTANT: ${content}`);
          lines.push("");
        }
        break;

      case "tool":
        lines.push(
          `TOOL RESULT (${msg.name ? `name=${msg.name}` : ""}${msg.tool_call_id ? ` tool_call_id=${msg.tool_call_id}` : ""}): ${content}`
        );
        lines.push("");
        break;
    }
  }

  // Append tool inventory
  if (hasTools) {
    lines.push("Available tools:");
    for (const tool of tools) {
      const spec = {
        name: tool.function.name,
        description: tool.function.description ?? "",
        parameters: tool.function.parameters ?? {},
      };
      lines.push(JSON.stringify(spec));
    }
    lines.push("");
  }

  // Agent mode primer
  if (hasTools) {
    lines.push(
      "When you need to perform a local action, respond with exactly one tool call. Do not explain the tool call in prose before making it."
    );
    lines.push("");
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
