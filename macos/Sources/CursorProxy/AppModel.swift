import Foundation
import AppKit
import Combine
import CursorProxyCore

/// Observable state model for the menu bar app.
@MainActor
public final class AppModel: ObservableObject {
    @Published public private(set) var status: ProxyStatus = .stopped
    @Published public private(set) var baseURL: String = ""
    @Published public private(set) var lastError: String?
    @Published public private(set) var modelCount: Int = 0

    public var isRunning: Bool { status.isRunning }

    private let server = ProxyServer()
    private var config: ProxyConfig
    private let defaults = UserDefaults.standard
    private var statusTimer: Timer?

    public init() {
        let savedPort = UInt16(defaults.integer(forKey: "proxyPort"))
        self.config = ProxyConfig(
            port: savedPort > 0 ? savedPort : 8787,
            apiKey: Self.loadAPIKey(),
            proxySourcePath: defaults.string(forKey: "proxySourcePath")
        )
    }

    // MARK: - Server Control

    public func startServer() {
        guard !isRunning else { return }
        lastError = nil
        status = .starting

        Task {
            do {
                let port = try server.start(config: config)
                status = .running(port: port)
                baseURL = "http://127.0.0.1:\(port)/v1"
                defaults.set(Int(port), forKey: "proxyPort")
                fetchModelCount()
            } catch {
                status = .error(error.localizedDescription)
                lastError = error.localizedDescription
            }
        }
    }

    public func stopServer() {
        server.stop()
        status = .stopped
        baseURL = ""
        modelCount = 0
        lastError = nil
    }

    public func restartServer() {
        stopServer()
        startServer()
    }

    // MARK: - Actions

    public func copyURL() {
        guard !baseURL.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(baseURL, forType: .string)
    }

    public func openInBrowser() {
        guard !baseURL.isEmpty else { return }
        // Open models endpoint in browser for quick verification
        if let port = status.port,
           let url = URL(string: "http://127.0.0.1:\(port)/v1/models") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Config

    public func updatePort(_ port: UInt16) {
        config.port = port
        defaults.set(Int(port), forKey: "proxyPort")
    }

    public func updateAPIKey(_ key: String?) {
        config.apiKey = key
        Self.saveAPIKey(key)
    }

    public func updateProxyPath(_ path: String?) {
        config.proxySourcePath = path
        if let path {
            defaults.set(path, forKey: "proxySourcePath")
        } else {
            defaults.removeObject(forKey: "proxySourcePath")
        }
    }

    // MARK: - Model Discovery

    private func fetchModelCount() {
        guard let port = status.port else { return }
        let url = URL(string: "http://127.0.0.1:\(port)/v1/models")!

        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let models = json["data"] as? [[String: Any]] {
                    modelCount = models.count
                }
            } catch {
                // Non-critical, just don't show count
            }
        }
    }

    // MARK: - Keychain

    private static let keychainService = "com.cursor-proxy.api-key"
    private static let keychainAccount = "cursor-api-key"

    private static func loadAPIKey() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func saveAPIKey(_ key: String?) {
        // Delete existing
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Add new if provided
        guard let key, !key.isEmpty else { return }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: key.data(using: .utf8)!,
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    // MARK: - Termination

    public func shutdown() async {
        server.stop()
    }
}
