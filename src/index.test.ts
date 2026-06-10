import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { modelList, modelGuide } from "./models.js";

// We test the server handler by building the same handler inline
// (importing index.ts directly would auto-start the server)

function extractApiKey(req: { headers: { authorization?: string } }): string {
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
}

function buildHandler() {
  const DEFAULT_API_KEY = process.env.CURSOR_API_KEY || "";
  // Lazy import to avoid auto-start
  return async (req: any, res: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1:8787");

    try {
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(modelList()));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models/guide") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(modelGuide(), null, 2));
        return;
      }

      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const apiKey = extractApiKey(req) || DEFAULT_API_KEY;
        if (!apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: {
              message: "Missing API key. Set Authorization: Bearer <key> or CURSOR_API_KEY env var.",
              type: "invalid_request_error",
              code: "unauthorized",
              status: 401,
            },
          }));
          return;
        }
        // We won't actually call handleCompletions — just verify routing
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, apiKey }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `Not found: ${req.method} ${url.pathname}`,
          type: "invalid_request_error",
          code: "not_found",
          status: 404,
        },
      }));
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({
        error: {
          message: "Internal server error",
          type: "api_error",
          code: "internal_error",
          status: 500,
        },
      }));
    }
  };
}

describe("extractApiKey", () => {
  it("extracts token from Bearer header", () => {
    expect(extractApiKey({ headers: { authorization: "Bearer sk-123" } })).toBe("sk-123");
  });

  it("is case-insensitive on scheme", () => {
    expect(extractApiKey({ headers: { authorization: "bearer sk-123" } })).toBe("sk-123");
    expect(extractApiKey({ headers: { authorization: "BEARER sk-123" } })).toBe("sk-123");
  });

  it("returns empty for non-Bearer scheme", () => {
    expect(extractApiKey({ headers: { authorization: "Basic sk-123" } })).toBe("");
  });

  it("returns empty for missing header", () => {
    expect(extractApiKey({ headers: {} })).toBe("");
  });

  it("returns empty for Bearer without token", () => {
    expect(extractApiKey({ headers: { authorization: "Bearer" } })).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(extractApiKey({ headers: { authorization: "" } })).toBe("");
  });
});

describe("HTTP server routing", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(buildHandler());
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  async function get(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, { method: "GET", headers });
    return { status: res.status, body: await res.json() };
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) };
  }

  describe("GET /health", () => {
    it("returns ok", async () => {
      const { status, body } = await get("/health");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.version).toBe("0.1.0");
    });
  });

  describe("GET /", () => {
    it("returns ok", async () => {
      const { status, body } = await get("/");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });

  describe("GET /v1/models", () => {
    it("returns model list", async () => {
      const { status, body } = await get("/v1/models");
      expect(status).toBe(200);
      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(15);
    });
  });

  describe("GET /v1/models/guide", () => {
    it("returns guide", async () => {
      const { status, body } = await get("/v1/models/guide");
      expect(status).toBe(200);
      expect(body.description).toContain("Cursor proxy");
    });
  });

  describe("OPTIONS", () => {
    it("returns 204 with CORS headers", async () => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    });
  });

  describe("POST /v1/chat/completions", () => {
    it("returns 401 when no API key", async () => {
      const { status, body } = await post("/v1/chat/completions", {
        model: "composer-2.5",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(status).toBe(401);
      expect(body.error.code).toBe("unauthorized");
    });

    it("accepts Bearer token", async () => {
      const { status, body } = await post(
        "/v1/chat/completions",
        { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] },
        { Authorization: "Bearer test-key" }
      );
      expect(status).toBe(200);
      expect(body.apiKey).toBe("test-key");
    });
  });

  describe("404", () => {
    it("returns 404 for unknown routes", async () => {
      const { status, body } = await get("/unknown");
      expect(status).toBe(404);
      expect(body.error.code).toBe("not_found");
    });

    it("includes method and path in error", async () => {
      const { body } = await get("/foo");
      expect(body.error.message).toContain("GET");
      expect(body.error.message).toContain("/foo");
    });
  });

  describe("CORS", () => {
    it("sets Access-Control-Allow-Origin on all responses", async () => {
      const res = await fetch(`${baseUrl}/v1/models`);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
