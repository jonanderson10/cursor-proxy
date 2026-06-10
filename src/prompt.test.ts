import { describe, it, expect } from "vitest";
import { preparePrompt } from "./prompt.js";
import type { ChatMessage, ToolDefinition } from "./types.js";

describe("preparePrompt", () => {
  describe("mode", () => {
    it("returns ask mode when no tools", () => {
      const result = preparePrompt([{ role: "user", content: "hello" }]);
      expect(result.mode).toBe("ask");
    });

    it("returns agent mode when tools present", () => {
      const tools: ToolDefinition[] = [
        { type: "function", function: { name: "bash", description: "run a command" } },
      ];
      const result = preparePrompt([{ role: "user", content: "hello" }], tools);
      expect(result.mode).toBe("agent");
    });
  });

  describe("system directive", () => {
    it("uses ask directive when no tools", () => {
      const result = preparePrompt([{ role: "user", content: "hi" }]);
      expect(result.text).toContain("helpful coding assistant");
      expect(result.text).not.toContain("You are an agent");
    });

    it("uses agent directive when tools present", () => {
      const tools: ToolDefinition[] = [
        { type: "function", function: { name: "bash" } },
      ];
      const result = preparePrompt([{ role: "user", content: "hi" }], tools);
      expect(result.text).toContain("You are an agent");
      expect(result.text).toContain("Do not say you cannot run tools");
    });
  });

  describe("message serialization", () => {
    it("serializes system messages", () => {
      const result = preparePrompt([{ role: "system", content: "Be terse." }]);
      expect(result.text).toContain("SYSTEM: Be terse.");
    });

    it("serializes user messages", () => {
      const result = preparePrompt([{ role: "user", content: "What is 2+2?" }]);
      expect(result.text).toContain("USER: What is 2+2?");
    });

    it("serializes assistant messages", () => {
      const result = preparePrompt([{ role: "assistant", content: "4" }]);
      expect(result.text).toContain("ASSISTANT: 4");
    });

    it("serializes tool result messages", () => {
      const result = preparePrompt([
        { role: "tool", content: "file contents here", name: "read", tool_call_id: "call_123" },
      ]);
      expect(result.text).toContain("TOOL RESULT");
      expect(result.text).toContain("name=read");
      expect(result.text).toContain("tool_call_id=call_123");
      expect(result.text).toContain("file contents here");
    });

    it("serializes tool result without name or tool_call_id", () => {
      const result = preparePrompt([{ role: "tool", content: "output" }]);
      expect(result.text).toContain("TOOL RESULT");
      expect(result.text).toContain("output");
    });

    it("serializes multiple messages in order", () => {
      const result = preparePrompt([
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
        { role: "assistant", content: "asst" },
      ]);
      const text = result.text;
      const sysIdx = text.indexOf("SYSTEM: sys");
      const usrIdx = text.indexOf("USER: usr");
      const asstIdx = text.indexOf("ASSISTANT: asst");
      expect(sysIdx).toBeLessThan(usrIdx);
      expect(usrIdx).toBeLessThan(asstIdx);
    });
  });

  describe("assistant tool_calls", () => {
    it("renders tool calls inline", () => {
      const result = preparePrompt([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          ],
        },
      ]);
      expect(result.text).toContain("[tool_call] bash({\"cmd\":\"ls\"})");
    });

    it("renders content alongside tool calls", () => {
      const result = preparePrompt([
        {
          role: "assistant",
          content: "Let me check that.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          ],
        },
      ]);
      expect(result.text).toContain("ASSISTANT: Let me check that.");
      expect(result.text).toContain("[tool_call] bash");
    });

    it("renders multiple tool calls", () => {
      const result = preparePrompt([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
            { id: "call_2", type: "function", function: { name: "write", arguments: '{"path":"b.ts","content":"x"}' } },
          ],
        },
      ]);
      expect(result.text).toContain("[tool_call] read");
      expect(result.text).toContain("[tool_call] write");
    });
  });

  describe("content extraction", () => {
    it("handles null content", () => {
      const result = preparePrompt([{ role: "user", content: null }]);
      expect(result.text).toContain("USER: \n");
    });

    it("handles undefined content", () => {
      const result = preparePrompt([{ role: "user", content: undefined as unknown as string }]);
      expect(result.text).toContain("USER:");
    });

    it("extracts text from ContentPart array", () => {
      const result = preparePrompt([
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
            { type: "image_url", image_url: { url: "http://example.com/img.png" } },
          ],
        },
      ]);
      expect(result.text).toContain("Hello\nWorld");
      expect(result.text).not.toContain("image_url");
    });
  });

  describe("tool inventory", () => {
    it("appends tool inventory when tools present", () => {
      const tools: ToolDefinition[] = [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        },
      ];
      const result = preparePrompt([{ role: "user", content: "hi" }], tools);
      expect(result.text).toContain("Available tools:");
      expect(result.text).toContain('"name":"bash"');
      expect(result.text).toContain('"description":"Run a shell command"');
    });

    it("uses empty string for missing description", () => {
      const tools: ToolDefinition[] = [
        { type: "function", function: { name: "test" } },
      ];
      const result = preparePrompt([{ role: "user", content: "hi" }], tools);
      expect(result.text).toContain('"description":""');
    });

    it("uses empty object for missing parameters", () => {
      const tools: ToolDefinition[] = [
        { type: "function", function: { name: "test" } },
      ];
      const result = preparePrompt([{ role: "user", content: "hi" }], tools);
      expect(result.text).toContain('"parameters":{}');
    });

    it("does not append tool inventory when no tools", () => {
      const result = preparePrompt([{ role: "user", content: "hi" }]);
      expect(result.text).not.toContain("Available tools:");
    });
  });

  describe("agent mode primer", () => {
    it("appends primer when tools present", () => {
      const tools: ToolDefinition[] = [
        { type: "function", function: { name: "bash" } },
      ];
      const result = preparePrompt([{ role: "user", content: "hi" }], tools);
      expect(result.text).toContain("respond with exactly one tool call");
    });

    it("does not append primer when no tools", () => {
      const result = preparePrompt([{ role: "user", content: "hi" }]);
      expect(result.text).not.toContain("respond with exactly one tool call");
    });
  });

  describe("empty input", () => {
    it("handles empty messages array", () => {
      const result = preparePrompt([]);
      expect(result.mode).toBe("ask");
      expect(result.text).toContain("helpful coding assistant");
    });
  });
});
