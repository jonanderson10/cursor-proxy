import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCompletions } from "./completions.js";
import { mockRequest, mockResponse, responseJson } from "./test-helpers.js";

// Mock cursor-agent to avoid real SDK calls
vi.mock("./cursor-agent.js", () => ({
  runAgent: vi.fn(),
  runAgentStream: vi.fn(),
}));

import { runAgent, runAgentStream } from "./cursor-agent.js";
const mockRunAgent = vi.mocked(runAgent);
const mockRunAgentStream = vi.mocked(runAgentStream);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleCompletions", () => {
  describe("request validation", () => {
    it("returns 400 for invalid JSON", async () => {
      const req = mockRequest("not json");
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");
      expect(res.statusCode).toBe(400);
      expect(responseJson(res).error.message).toContain("Invalid JSON");
    });

    it("returns 400 when model is missing", async () => {
      const req = mockRequest(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");
      expect(res.statusCode).toBe(400);
      expect(responseJson(res).error.message).toContain("model");
    });

    it("returns 400 when messages is missing", async () => {
      const req = mockRequest(JSON.stringify({ model: "composer-2.5" }));
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");
      expect(res.statusCode).toBe(400);
      expect(responseJson(res).error.message).toContain("messages");
    });

    it("returns 400 when messages is empty", async () => {
      const req = mockRequest(JSON.stringify({ model: "composer-2.5", messages: [] }));
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");
      expect(res.statusCode).toBe(400);
      expect(responseJson(res).error.message).toContain("messages");
    });
  });

  describe("non-streaming", () => {
    it("returns 200 with OpenAI response on success", async () => {
      mockRunAgent.mockResolvedValue({
        text: "Hello there",
        toolCalls: [],
        agentID: "agent-1",
        runID: "run-1",
        status: "finished",
      });

      const req = mockRequest(JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "Say hello" }],
      }));
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");

      expect(res.statusCode).toBe(200);
      const body = responseJson(res);
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("Hello there");
      expect(body.choices[0].finish_reason).toBe("stop");
      expect(body.model).toBe("composer-2.5");
    });

    it("returns 502 when SDK throws", async () => {
      mockRunAgent.mockRejectedValue(new Error("Invalid User API Key"));

      const req = mockRequest(JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "hi" }],
      }));
      const res = mockResponse();
      await handleCompletions(req, res, "bad-key");

      expect(res.statusCode).toBe(502);
      expect(responseJson(res).error.message).toContain("Invalid User API Key");
    });

    it("returns 502 with generic message for non-Error throws", async () => {
      mockRunAgent.mockRejectedValue("string error");

      const req = mockRequest(JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "hi" }],
      }));
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");

      expect(res.statusCode).toBe(502);
      expect(responseJson(res).error.message).toBe("Internal server error");
    });

    it("passes apiKey to runAgent", async () => {
      mockRunAgent.mockResolvedValue({
        text: "ok",
        toolCalls: [],
        agentID: "a",
        runID: "r",
        status: "finished",
      });

      const req = mockRequest(JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }));
      const res = mockResponse();
      await handleCompletions(req, res, "my-api-key");

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "my-api-key", model: "gpt-5.5" })
      );
    });
  });

  describe("streaming", () => {
    it("emits SSE chunks and [DONE]", async () => {
      mockRunAgentStream.mockImplementation(async function* () {
        yield { type: "text", text: "Hello" };
        yield { type: "text", text: " world" };
      });

      const req = mockRequest(JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }));
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");

      expect(res.statusCode).toBe(200);
      expect(res.writtenHeaders["Content-Type"]).toBe("text/event-stream");
      expect(res.writtenBody).toContain("data:");
      expect(res.writtenBody).toContain("[DONE]");
      expect(res.ended).toBe(true);
    });

    it("emits error as SSE on SDK failure", async () => {
      mockRunAgentStream.mockImplementation(async function* () {
        throw new Error("SDK failure");
      });

      const req = mockRequest(JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
      const res = mockResponse();
      await handleCompletions(req, res, "test-key");

      expect(res.writtenBody).toContain("SDK failure");
      expect(res.writtenBody).toContain("[DONE]");
    });
  });

  describe("error format", () => {
    it("4xx errors use invalid_request_error type", async () => {
      const req = mockRequest("bad");
      const res = mockResponse();
      await handleCompletions(req, res, "key");
      const body = responseJson(res);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("invalid_request");
    });

    it("5xx errors use api_error type", async () => {
      mockRunAgent.mockRejectedValue(new Error("fail"));
      const req = mockRequest(JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "hi" }],
      }));
      const res = mockResponse();
      await handleCompletions(req, res, "key");
      const body = responseJson(res);
      expect(body.error.type).toBe("api_error");
      expect(body.error.code).toBe("internal_error");
    });
  });
});
