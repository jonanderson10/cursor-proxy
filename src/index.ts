import { createServer } from "node:http";
import { handleCompletions } from "./completions.js";
import { modelList, modelGuide } from "./models.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_API_KEY = process.env.CURSOR_API_KEY || "";

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // CORS headers on all responses
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    // GET /v1/models
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(modelList()));
      return;
    }

    // GET /v1/models/guide
    if (req.method === "GET" && url.pathname === "/v1/models/guide") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(modelGuide(), null, 2));
      return;
    }

    // GET /health
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
      return;
    }

    // POST /v1/chat/completions
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const apiKey = extractApiKey(req) || DEFAULT_API_KEY;
      if (!apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Missing API key. Set Authorization: Bearer <key> or CURSOR_API_KEY env var.",
              type: "invalid_request_error",
              code: "unauthorized",
              status: 401,
            },
          })
        );
        return;
      }
      await handleCompletions(req, res, apiKey);
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Not found: ${req.method} ${url.pathname}`,
          type: "invalid_request_error",
          code: "not_found",
          status: 404,
        },
      })
    );
  } catch (error) {
    console.error("Unhandled error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: {
          message: "Internal server error",
          type: "api_error",
          code: "internal_error",
          status: 500,
        },
      })
    );
  }
});

function extractApiKey(req: { headers: { authorization?: string } }): string {
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
}

server.listen(PORT, HOST, () => {
  console.log(`cursor-proxy listening on http://${HOST}:${PORT}`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /v1/models/guide`);
  if (DEFAULT_API_KEY) {
    console.log(`  Default API key: ${DEFAULT_API_KEY.slice(0, 8)}...`);
  } else {
    console.warn(`  ⚠ No CURSOR_API_KEY set — requests must include Authorization header`);
  }
});

function shutdown() {
  console.log("\nShutting down...");
  server.close(() => process.exit(0));
  // Force exit after 2s if connections don't close
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
