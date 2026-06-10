import Foundation

/// Manages the cursor-proxy Node.js server as a child process.
public final class ProxyServer: @unchecked Sendable {
    private var process: Process?
    private let queue = DispatchQueue(label: "cursor-proxy-server", qos: .userInitiated)
    private var _status: ProxyStatus = .stopped
    private let statusLock = NSLock()

    public var status: ProxyStatus {
        statusLock.lock()
        defer { statusLock.unlock() }
        return _status
    }

    private func setStatus(_ newStatus: ProxyStatus) {
        statusLock.lock()
        _status = newStatus
        statusLock.unlock()
    }

    public var isRunning: Bool { status.isRunning }

    public init() {}

    // MARK: - Lifecycle

    /// Start the proxy server. Returns the actual port used (may differ if preferred port is busy).
    @MainActor
    public func start(config: ProxyConfig, fallbackLimit: Int = 20) throws -> UInt16 {
        stop()

        let proxyDir = try resolveProxyDirectory(override: config.proxySourcePath)
        let nodeExec = try resolveNodePath(override: config.nodePath)
        let tsxExec = resolveTsxPath(override: config.tsxPath, proxyDir: proxyDir)

        // Try preferred port + fallback ports
        for offset in 0..<max(1, fallbackLimit) {
            let candidatePort = UInt16(exactly: Int(config.port) + offset)!
            do {
                try launch(
                    nodePath: nodeExec,
                    tsxPath: tsxExec,
                    proxyDir: proxyDir,
                    port: candidatePort,
                    apiKey: config.apiKey
                )
                // Wait for health check
                try waitForHealth(port: candidatePort, timeoutSeconds: 10)
                setStatus(.running(port: candidatePort))
                return candidatePort
            } catch {
                // If it's a launch error and we have more ports to try, continue
                if offset < fallbackLimit - 1 {
                    killProcess()
                    continue
                }
                throw error
            }
        }

        throw ProxyError.noAvailablePort
    }

    /// Stop the proxy server gracefully.
    public func stop() {
        killProcess()
        setStatus(.stopped)
    }

    /// Restart the proxy server with the same config.
    @MainActor
    public func restart(config: ProxyConfig, fallbackLimit: Int = 20) throws -> UInt16 {
        stop()
        return try start(config: config, fallbackLimit: fallbackLimit)
    }

    // MARK: - Process Management

    private func launch(nodePath: String, tsxPath: String?, proxyDir: String, port: UInt16, apiKey: String?) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)

        // Build arguments: either use tsx directly or npx tsx
        if let tsxPath {
            process.arguments = [tsxPath, "src/index.ts"]
        } else {
            // Use npx to find tsx
            let npxPath = (nodePath as NSString).deletingLastPathComponent + "/npx"
            if FileManager.default.fileExists(atPath: npxPath) {
                process.executableURL = URL(fileURLWithPath: npxPath)
                process.arguments = ["tsx", "src/index.ts"]
            } else {
                // Fallback: try node with --import tsx
                process.arguments = ["--import", "tsx", "src/index.ts"]
            }
        }

        process.currentDirectoryURL = URL(fileURLWithPath: proxyDir)

        // Build environment
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        if let apiKey, !apiKey.isEmpty {
            env["CURSOR_API_KEY"] = apiKey
        }
        // Ensure node_modules/.bin is on PATH
        let nodeModulesBin = proxyDir + "/node_modules/.bin"
        if let existingPath = env["PATH"] {
            env["PATH"] = nodeModulesBin + ":" + existingPath
        } else {
            env["PATH"] = nodeModulesBin
        }
        process.environment = env

        // Capture output for debugging
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        process.terminationHandler = { [weak self] proc in
            if proc.terminationStatus != 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""
                DispatchQueue.main.async {
                    guard let self else { return }
                    if case .running = self.status {
                        // Server died unexpectedly
                        self.setStatus(.error("Process exited with code \(proc.terminationStatus): \(output.prefix(200))"))
                    }
                }
            }
        }

        try process.run()
        self.process = process
    }

    private func killProcess() {
        guard let process, process.isRunning else {
            self.process = nil
            return
        }

        // SIGTERM first
        process.terminate()

        // Wait up to 2 seconds for graceful exit
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }

        // SIGKILL if still running
        if process.isRunning {
            Darwin.kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }

        self.process = nil
    }

    // MARK: - Health Check

    private func waitForHealth(port: UInt16, timeoutSeconds: TimeInterval) throws {
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        let deadline = Date().addingTimeInterval(timeoutSeconds)

        while Date() < deadline {
            var healthy = false
            let semaphore = DispatchSemaphore(value: 0)

            // Use a class wrapper to avoid Sendable warnings with value types
            final class Box: @unchecked Sendable {
                var value = false
            }
            let box = Box()

            let task = URLSession.shared.dataTask(with: url) { _, response, _ in
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    box.value = true
                }
                semaphore.signal()
            }
            task.resume()
            _ = semaphore.wait(timeout: .now() + 1)

            healthy = box.value
            if healthy { return }

            // Check if process died
            if let process, !process.isRunning {
                throw ProxyError.processExited
            }

            Thread.sleep(forTimeInterval: 0.25)
        }

        throw ProxyError.healthCheckTimeout
    }

    // MARK: - Path Resolution

    /// Find the cursor-proxy project directory.
    private func resolveProxyDirectory(override: String?) throws -> String {
        if let override, !override.isEmpty {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: override, isDirectory: &isDir), isDir.boolValue {
                return override
            }
            throw ProxyError.proxyNotFound("Explicit path does not exist: \(override)")
        }

        // Search locations (in priority order):
        // 1. CURSOR_PROXY_PATH env var
        // 2. Bundle resources (for bundled app)
        // 3. Sibling directory (../ from macos/)
        // 4. Current working directory

        let fm = FileManager.default

        // Env var
        if let envPath = ProcessInfo.processInfo.environment["CURSOR_PROXY_PATH"] {
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: envPath, isDirectory: &isDir), isDir.boolValue {
                return envPath
            }
        }

        // Bundle resources
        if let bundlePath = Bundle.main.resourcePath {
            let candidate = bundlePath + "/cursor-proxy"
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: candidate, isDirectory: &isDir), isDir.boolValue {
                return candidate
            }
        }

        // Sibling directory (../ from macos/)
        // When running from macos/ directory, proxy is at ../
        let cwd = fm.currentDirectoryPath
        let sibling = (cwd as NSString).deletingLastPathComponent
        let siblingSrc = sibling + "/src/index.ts"
        if fm.fileExists(atPath: siblingSrc) {
            return sibling
        }

        // If cwd itself has src/index.ts (running from project root)
        let cwdSrc = cwd + "/src/index.ts"
        if fm.fileExists(atPath: cwdSrc) {
            return cwd
        }

        throw ProxyError.proxyNotFound(
            "Could not find cursor-proxy project. Set CURSOR_PROXY_PATH or run from the project directory."
        )
    }

    /// Find the Node.js binary.
    private func resolveNodePath(override: String?) throws -> String {
        if let override, !override.isEmpty {
            if FileManager.default.fileExists(atPath: override) {
                return override
            }
            throw ProxyError.nodeNotFound("Explicit node path does not exist: \(override)")
        }

        // Use `which` to find node
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["node"]
        let pipe = Pipe()
        which.standardOutput = pipe
        try which.run()
        which.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if !path.isEmpty && FileManager.default.fileExists(atPath: path) {
            return path
        }

        throw ProxyError.nodeNotFound(
            "Node.js not found. Install Node.js 18+ or set nodePath in config."
        )
    }

    /// Find tsx binary in the proxy project's node_modules.
    private func resolveTsxPath(override: String?, proxyDir: String) -> String? {
        if let override, !override.isEmpty, FileManager.default.fileExists(atPath: override) {
            return override
        }

        // Check node_modules/.bin/tsx
        let localTsx = proxyDir + "/node_modules/.bin/tsx"
        if FileManager.default.fileExists(atPath: localTsx) {
            return localTsx
        }

        // Check global tsx
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["tsx"]
        let pipe = Pipe()
        which.standardOutput = pipe
        try? which.run()
        which.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !path.isEmpty && FileManager.default.fileExists(atPath: path) {
            return path
        }

        return nil
    }
}

// MARK: - Errors

public enum ProxyError: LocalizedError {
    case proxyNotFound(String)
    case nodeNotFound(String)
    case noAvailablePort
    case processExited
    case healthCheckTimeout

    public var errorDescription: String? {
        switch self {
        case .proxyNotFound(let msg): return msg
        case .nodeNotFound(let msg): return msg
        case .noAvailablePort: return "Could not find an available port."
        case .processExited: return "Proxy process exited unexpectedly."
        case .healthCheckTimeout: return "Proxy server did not become healthy within timeout."
        }
    }
}
