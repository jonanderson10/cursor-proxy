# cursor-proxy

A lightweight OpenAI-compatible proxy for Cursor's API. Uses `@cursor/sdk` directly — no CLI subprocesses, no heavy dependencies.

Works with any OpenAI-compatible client: [opencode](https://opencode.ai), curl, or your own app.

## Quick start

```bash
git clone https://github.com/yourname/cursor-proxy.git
cd cursor-proxy
npm install
export CURSOR_API_KEY="your-cursor-api-key"
npm start
```

Server starts on `http://127.0.0.1:8787`. Test it:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"hello"}]}'
```

### opencode setup

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "enabled_providers": ["cursor"],
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "{env:CURSOR_API_KEY}"
      },
      "models": {
        "composer-2.5": {
          "name": "Composer 2.5",
          "cost": { "input": 0.5, "output": 2.5 },
          "limit": { "context": 200000, "output": 65536 }
        },
        "composer-2.5-fast": {
          "name": "Composer 2.5 Fast",
          "cost": { "input": 3, "output": 15 },
          "limit": { "context": 200000, "output": 65536 }
        },
        "gpt-5.5": {
          "name": "GPT-5.5",
          "cost": { "input": 5, "output": 30 },
          "limit": { "context": 1000000, "output": 65536 },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        },
        "gpt-5.2": {
          "name": "GPT-5.2",
          "cost": { "input": 1.75, "output": 14 },
          "limit": { "context": 200000, "output": 65536 }
        },
        "gpt-5.1": {
          "name": "GPT-5.1",
          "cost": { "input": 1.25, "output": 10 },
          "limit": { "context": 200000, "output": 65536 }
        },
        "gpt-5-mini": {
          "name": "GPT-5 Mini",
          "cost": { "input": 0.25, "output": 2 },
          "limit": { "context": 200000, "output": 65536 }
        },
        "claude-opus-4-8": {
          "name": "Claude Opus 4.8",
          "cost": { "input": 5, "output": 25 },
          "limit": { "context": 1000000, "output": 131072 },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        },
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6",
          "cost": { "input": 3, "output": 15 },
          "limit": { "context": 200000, "output": 65536 },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        },
        "claude-fable-5": {
          "name": "Claude Fable 5",
          "cost": { "input": 10, "output": 50 },
          "limit": { "context": 1000000, "output": 131072 },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        },
        "gemini-3.1-pro": {
          "name": "Gemini 3.1 Pro",
          "cost": { "input": 2, "output": 12 },
          "limit": { "context": 1000000, "output": 131072 }
        },
        "gemini-3.5-flash": {
          "name": "Gemini 3.5 Flash",
          "cost": { "input": 1.5, "output": 9 },
          "limit": { "context": 1000000, "output": 131072 }
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash",
          "cost": { "input": 0.3, "output": 2.5 },
          "limit": { "context": 1000000, "output": 131072 }
        },
        "grok-4.3": {
          "name": "Grok 4.3",
          "cost": { "input": 1.25, "output": 2.5 },
          "limit": { "context": 200000, "output": 65536 }
        },
        "kimi-k2.5": {
          "name": "Kimi K2.5",
          "cost": { "input": 0.6, "output": 3 },
          "limit": { "context": 200000, "output": 65536 }
        }
      }
    }
  }
}
```

Then `/model cursor/composer-2.5` in opencode.

### Why model info is in opencode.json

Opencode's `@ai-sdk/openai-compatible` provider doesn't auto-discover models from the proxy's `/v1/models` endpoint. Built-in providers (Anthropic, OpenAI, Google) have their model lists hardcoded in opencode's source — generic providers need manual config. Our proxy serves `/v1/models` for other clients (Continue, curl, etc.), but opencode reads exclusively from its config file.

This means cost, limits, and variants must be defined in `opencode.json`. The proxy handles everything else — prompt translation, variant mapping, token counting — so the config entries are minimal.

### Reasoning variants

OpenCode supports effort levels natively via `/variant`. The proxy auto-discovers available parameters from Cursor's API at runtime and maps them correctly.

Configure variants in your `opencode.json` under each model:

```json
"gpt-5.5": {
  "name": "GPT-5.5",
  "cost": { "input": 5, "output": 30 },
  "limit": { "context": 200000, "output": 65536 },
  "variants": {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
```

Then use `/variant high` in opencode. The proxy reads `reasoningEffort` from the request body and queries `Cursor.models.list()` to find the correct SDK param for that model. Unknown effort levels pass through as-is.

You can also pass `reasoningEffort` directly in curl:

```bash
curl ... -d '{"model":"gpt-5.5","messages":[...],"reasoningEffort":"high"}'
```

Or use the model suffix syntax (`:reasoning`, `:reasoning-high`, etc.) — both work.

## Models

| ID | Name | Context | Max Output | $/1M in | $/1M out | Notes |
|----|------|---------|------------|---------|----------|-------|
| `default` | Auto (Cursor picks) | — | — | — | — | |
| `composer-2.5` | Composer 2.5 | 200,000 | 65,536 | $0.50 | $2.50 | |
| `composer-2.5-fast` | Composer 2.5 Fast | 200,000 | 65,536 | $3.00 | $15.00 | |
| `gpt-5.5` | GPT-5.5 | 1,050,000 | 131,072 | $5.00 | $30.00 | 2x input / 1.5x output above 272K |
| `gpt-5.2` | GPT-5.2 | 400,000 | 65,536 | $1.75 | $14.00 | |
| `gpt-5.1` | GPT-5.1 | 400,000 | 65,536 | $1.25 | $10.00 | |
| `gpt-5-mini` | GPT-5 Mini | 400,000 | 65,536 | $0.25 | $2.00 | |
| `claude-opus-4-8` | Claude Opus 4.8 | 1,000,000 | 131,072 | $5.00 | $25.00 | |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1,000,000 | 131,072 | $3.00 | $15.00 | |
| `claude-fable-5` | Claude Fable 5 | 1,000,000 | 131,072 | $10.00 | $50.00 | |
| `gemini-3.1-pro` | Gemini 3.1 Pro | 1,000,000 | 131,072 | $2.00 | $12.00 | |
| `gemini-3.5-flash` | Gemini 3.5 Flash | 1,000,000 | 131,072 | $1.50 | $9.00 | |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 1,000,000 | 131,072 | $0.30 | $2.50 | |
| `grok-4.3` | Grok 4.3 | 1,000,000 | 131,072 | $1.25 | $2.50 | |
| `kimi-k2.5` | Kimi K2.5 | 262,000 | 65,536 | $0.60 | $3.00 | |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `GET` | `/v1/models` | List available models |
| `GET` | `/v1/models/guide` | Model list with config example |
| `GET` | `/health` | Health check |

## How it works

```
opencode / curl / any client
    │
    ▼
cursor-proxy (Node.js HTTP server)
    │  translates OpenAI messages → Cursor prompt
    │  translates Cursor output → OpenAI response
    ▼
@cursor/sdk
    │
    ▼
Cursor API
```

The proxy translates between OpenAI's Chat Completions format and Cursor's SDK. Tool calls are handled natively through the SDK — no prompt-based hacks or CLI output parsing.

Token usage is counted with [tiktoken](https://github.com/nicbarker/tiktoken) (the same tokenizer GPT-4 uses), not estimated from character counts.

## Comparison with other approaches

There are several projects that connect OpenCode to Cursor. Here's how this one differs:

| | cursor-proxy | [opencode-cursor](https://github.com/Nomadcxx/opencode-cursor) | [composer-api](https://github.com/standardagents/composer-api) | [yet-another-opencode-cursor-auth](https://github.com/Yukaii/yet-another-opencode-cursor-auth) | [opencode-cursor-auth](https://github.com/POSO-PocketSolutions/opencode-cursor-auth) |
|---|---|---|---|---|---|
| **Runtime** | Node.js | Bun + `cursor-agent` CLI | Swift app / Cloudflare Workers | Bun | Bun + `cursor-agent` CLI |
| **Dependencies** | 2 (`@cursor/sdk`, `tiktoken`) | ~10 + CLI tool | Cloudflare stack + Swift | ~10 | ~5 + CLI tool |
| **Cursor integration** | `@cursor/sdk` (direct) | `cursor-agent` CLI (subprocess) | `@cursor/sdk` (direct) | Connect-RPC (protobuf) | `cursor-agent` CLI (subprocess) |
| **Requests** | In-process function call | Spawns subprocess per request | Cloudflare Worker | Custom fetch handler | Spawns subprocess per request |
| **Tool calling** | Native SDK | OpenCode-owned loop | Agent mode only | Mapped functions | Prompt-based (fragile) |
| **Token counting** | tiktoken (precise) | N/A | char/4 estimate | char/4 estimate | None |
| **OpenCode plugin** | No (standalone) | Yes | No | Yes | Yes |
| **Client agnostic** | Yes | No (OpenCode only) | Yes | No (OpenCode only) | No (OpenCode only) |
| **Auth** | API key | `cursor-agent login` | API key + hosted keys | OAuth PKCE | `cursor-agent login` |
| **MCP bridge** | No | Yes | No | No | No |

### Why this approach

**Simplicity.** Two dependencies, one process, no subprocess spawning per request. The SDK call happens in-process — no parsing CLI stdout, no protobuf encoding, no Cloudflare infrastructure.

**Client agnostic.** Standard OpenAI Chat Completions API means it works with anything that speaks OpenAI — not just OpenCode. Point Continue, a custom app, or `curl` at it.

**Accurate token counts.** tiktoken gives real token counts instead of dividing character length by 4.

**No external tools to install.** No `cursor-agent` CLI, no Bun runtime, no Swift compiler. Just Node.js and `npm install`.

### Tradeoffs

- **No MCP bridge** — opencode-cursor can bridge MCP servers into Cursor's tool space. This proxy doesn't.
- **No OpenCode plugin** — this is a standalone server, not an opencode plugin. You configure it manually in `opencode.json`.
- **No OAuth** — you need a Cursor API key. The OAuth-based projects handle key acquisition automatically.
- **Unknown models pass through** — if you request a model not in the hardcoded list, it works but has no pricing/limit metadata until we update the code.
- **Reasoning levels auto-discovered** — the proxy queries `Cursor.models.list()` at runtime to find the correct SDK params per model. No hardcoded mapping needed.

## Credits

This project builds on ideas from two existing projects:

**[composer-api](https://github.com/standardagents/composer-api)** by Standard Agents — Showed that `@cursor/sdk` is the right integration path for talking to Cursor's backend. Their `openai.ts` translation layer (converting OpenAI messages to Cursor prompts and back) was the blueprint for our prompt and response handling. Their architecture docs and test patterns also informed the project structure.

**[opencode-cursor](https://github.com/Nomadcxx/opencode-cursor)** by Nomadcxx — Demonstrated the tool-calling loop pattern, model name normalization, and how to surface Cursor models through an OpenAI-compatible proxy. Their approach to handling Cursor's tool call events validated the design direction. Also the most feature-complete option if you need MCP bridging or an OpenCode plugin.

## Development

```bash
npm run dev          # Start with file watching
npm test             # Run 128 tests
npm run typecheck    # Type check
npm run check        # Typecheck + tests
```

## License

MIT
