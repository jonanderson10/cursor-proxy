import Foundation

/// Configuration for the cursor-proxy server.
public struct ProxyConfig: Sendable {
    /// Preferred port for the proxy server.
    public var port: UInt16

    /// Cursor API key (passed as CURSOR_API_KEY env var to the child process).
    public var apiKey: String?

    /// Explicit path to the cursor-proxy project directory.
    /// If nil, the server will search standard locations.
    public var proxySourcePath: String?

    /// Explicit path to the Node.js binary.
    /// If nil, searches PATH for `node`.
    public var nodePath: String?

    /// Path to tsx binary. If nil, uses `npx tsx`.
    public var tsxPath: String?

    public init(
        port: UInt16 = 8787,
        apiKey: String? = nil,
        proxySourcePath: String? = nil,
        nodePath: String? = nil,
        tsxPath: String? = nil
    ) {
        self.port = port
        self.apiKey = apiKey
        self.proxySourcePath = proxySourcePath
        self.nodePath = nodePath
        self.tsxPath = tsxPath
    }
}

/// Runtime status of the proxy server.
public enum ProxyStatus: Sendable, CustomStringConvertible {
    case stopped
    case starting
    case running(port: UInt16)
    case error(String)

    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    public var port: UInt16? {
        if case .running(let p) = self { return p }
        return nil
    }

    public var description: String {
        switch self {
        case .stopped: return "Stopped"
        case .starting: return "Starting..."
        case .running(let p): return "Running on port \(p)"
        case .error(let msg): return "Error: \(msg)"
        }
    }
}
