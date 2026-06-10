# macOS Menu Bar App for cursor-proxy

## Goal

A lightweight macOS menu bar app that runs the existing cursor-proxy Node.js server as a child process. Users get a system tray icon showing server status, one-click start/stop, and a dropdown with the API URL + model list.

## Architecture Decision

**Spawn Node.js as a child process** (like composer-api's bridge pattern).

Three options considered:
1. **Spawn Node.js child process** — Simplest. Requires Node installed. Ship just the Swift app + proxy source.
2. **Bundle Node/Bun binary** — No runtime dependency. Heavier .app (Bun ~50MB). Adds build complexity.
3. **Rewrite proxy in Swift** — Zero dependencies. Most work. Loses tiktoken (no good Swift port).

**Recommendation: Option 1 first.** The target users (developers using opencode/Continue) already have Node.js. We can add bundling later if needed.

## Reusable Patterns from composer-api

From the research at `/Users/jon/repos/misc/composer-api/macos/`:

- **Menu bar + window dual mode**: `NSApp.setActivationPolicy(.accessory)` / `.regular`
- **Status item with template icon**: `NSStatusBar.system.statusItem(withLength: .squareLength)`, `button.image?.isTemplate = true`
- **AppKit-first with NSHostingController**: Create `NSWindow` manually, host SwiftUI views via `NSHostingController`
- **Child process lifecycle**: `Process()` + `process.run()`, SIGTERM → poll → SIGKILL on stop
- **Port fallback**: Try preferred port + N consecutive ports
- **Graceful termination**: `applicationShouldTerminate` → `.terminateLater` → async cleanup → `reply(toApplicationShouldTerminate: true)`

## Project Structure

```
macos/
  Package.swift                    # SPM manifest (macOS 14+, Swift 6.0)
  Sources/
    CursorProxyCore/               # Library target (no UI)
      ProxyServer.swift            # Child process manager for Node.js proxy
      ProxyConfig.swift            # Settings model (port, API key, model list)
      HTTPTypes.swift              # Lightweight health check client
    CursorProxy/                   # Executable target (UI)
      CursorProxyApp.swift         # @main, NSApplicationDelegate, menu bar setup
      AppModel.swift               # ObservableObject, server lifecycle, status
      ContentView.swift            # Settings window (if needed)
      Resources/
        icon.png                   # Menu bar icon (template style)
  Tests/
    CursorProxyTests/
      ProxyServerTests.swift
```

## Key Components

### 1. `ProxyServer.swift` — Child Process Manager

```swift
// Spawns: node <proxy-source>/src/index.ts (via tsx/npx tsx)
// Or: node <bundled>/dist/index.js (if built)
actor ProxyServer {
    func start(config: ProxyConfig) throws -> UInt16  // returns actual port
    func stop()
    func restart(config: ProxyConfig) throws -> UInt16
    var isRunning: Bool { get }
    var status: ProxyStatus  // .stopped, .starting, .running(port), .error(msg)
}
```

Runtime discovery order:
1. `CURSOR_PROXY_PATH` env var (explicit override)
2. `<app-bundle>/Resources/cursor-proxy/` (bundled copy)
3. `<app-bundle>/../cursor-proxy/` (sibling directory, dev mode)
4. Look for `npx tsx` or `node` + `src/index.ts` in cwd

Health check: poll `GET /health` on the target port until 200 or timeout.

### 2. `CursorProxyApp.swift` — Menu Bar

```
Menu bar dropdown:
  ● cursor-proxy running         (status text, disabled)
  http://127.0.0.1:8787/v1       (clickable → copies URL)
  ─────────────────────────────
  5 models available              (disabled)
  composer-2.5                    (disabled, informational)
  ─────────────────────────────
  [Start] / [Stop] Server        (toggle)
  Restart Server
  ─────────────────────────────
  Show Settings...                (opens window)
  Quit
```

### 3. `AppModel.swift` — State Management

```swift
@MainActor
class AppModel: ObservableObject {
    @Published var isRunning = false
    @Published var statusText = "Stopped"
    @Published var baseURL = ""
    @Published var lastError: String?
    
    private let server = ProxyServer()
    
    func startServer() { ... }
    func stopServer() { ... }
    func restartServer() { ... }
    func copyURL() { ... }
}
```

### 4. `ProxyConfig.swift` — Settings

```swift
struct ProxyConfig {
    var port: UInt16 = 8787
    var apiKey: String?             // from Keychain
    var proxySourcePath: String?    // override for proxy location
    var nodePath: String?           // override for Node.js binary
}
```

Settings stored in UserDefaults (without API key). API key in Keychain.

## Build & Run (Development)

```bash
cd macos/
swift build                     # compile
swift run CursorProxy           # run directly (dev mode)
```

For development, the app finds the proxy at `../` relative to the `macos/` directory.

## Build & Package (Distribution)

### Simple approach (requires Node.js)
```bash
swift build -c release
# Bundle the .app with proxy source included
# User needs: Node.js 18+ installed
```

### Future: Bundled approach
Bundle a `bun` or `node` binary + pre-built `dist/index.js` into `Contents/Resources/`. Eliminates runtime dependency. ~50MB larger .app.

## Implementation Order

1. **Package.swift + project skeleton** — SPM manifest, empty targets, build runs
2. **ProxyServer.swift** — Spawn Node child process, health check, stop (SIGTERM → SIGKILL)
3. **CursorProxyApp.swift** — Menu bar item, basic dropdown (start/stop/quit)
4. **AppModel.swift** — Wire up lifecycle, status tracking, error display
5. **ContentView.swift** — Settings window (port, API key, proxy path)
6. **Keychain integration** — Store/retrieve Cursor API key
7. **Port fallback** — Try preferred + 20 consecutive ports
8. **Graceful shutdown** — `applicationShouldTerminate` pattern

## Dependencies

- **None** for the MVP. Pure Swift + Foundation + Network.framework.
- Optional later: Sparkle for auto-updates.
