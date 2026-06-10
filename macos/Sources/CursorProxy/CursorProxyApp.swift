import AppKit
import SwiftUI
import CursorProxyCore

@main
@MainActor
final class CursorProxyAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem?
    private var mainWindow: NSWindow?
    private let model = AppModel()

    // MARK: - App Lifecycle

    static func main() {
        let app = NSApplication.shared
        let delegate = CursorProxyAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)  // Start as menu-bar-only
        delegate.installStatusItem()
        app.finishLaunching()

        DispatchQueue.main.async {
            delegate.model.startServer()
        }

        app.run()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { @MainActor in
            await model.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: - Status Item

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = Self.menuBarIcon()
            button.image?.isTemplate = true
        }
        statusItem = item
        rebuildMenu()
    }

    /// Rebuild the dropdown menu. Called when status changes.
    private func rebuildMenu() {
        guard let statusItem else { return }
        let menu = NSMenu(title: "Cursor Proxy")

        // Status line
        let statusLine = NSMenuItem(title: model.status.description, action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)

        // URL (clickable to copy)
        if !model.baseURL.isEmpty {
            let urlItem = NSMenuItem(title: model.baseURL, action: #selector(copyURL(_:)), keyEquivalent: "")
            urlItem.target = self
            menu.addItem(urlItem)
        }

        // Model count
        if model.modelCount > 0 {
            let modelItem = NSMenuItem(title: "\(model.modelCount) models available", action: nil, keyEquivalent: "")
            modelItem.isEnabled = false
            menu.addItem(modelItem)
        }

        menu.addItem(.separator())

        // Start / Stop
        if model.isRunning {
            let stop = NSMenuItem(title: "Stop Server", action: #selector(stopServer(_:)), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)

            let restart = NSMenuItem(title: "Restart Server", action: #selector(restartServer(_:)), keyEquivalent: "")
            restart.target = self
            menu.addItem(restart)
        } else {
            let start = NSMenuItem(title: "Start Server", action: #selector(startServer(_:)), keyEquivalent: "")
            start.target = self
            menu.addItem(start)
        }

        menu.addItem(.separator())

        // Show Settings
        let settings = NSMenuItem(title: "Settings...", action: #selector(showSettings(_:)), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        menu.addItem(.separator())

        // Quit
        let quit = NSMenuItem(title: "Quit Cursor Proxy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)

        statusItem.menu = menu
    }

    // MARK: - Actions

    @objc private func copyURL(_ sender: Any?) {
        model.copyURL()
    }

    @objc private func startServer(_ sender: Any?) {
        model.startServer()
        rebuildMenu()
        // Rebuild menu again after status settles
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.rebuildMenu()
        }
    }

    @objc private func stopServer(_ sender: Any?) {
        model.stopServer()
        rebuildMenu()
    }

    @objc private func restartServer(_ sender: Any?) {
        model.restartServer()
        rebuildMenu()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.rebuildMenu()
        }
    }

    @objc private func showSettings(_ sender: Any?) {
        if mainWindow == nil {
            createSettingsWindow()
        }
        mainWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Settings Window

    private func createSettingsWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Cursor Proxy Settings"
        window.contentView = NSHostingView(rootView: SettingsView(model: model, onMenuRebuild: { [weak self] in
            self?.rebuildMenu()
        }))
        window.delegate = self
        window.center()
        mainWindow = window
    }

    func windowWillClose(_ notification: Notification) {
        mainWindow = nil
    }

    // MARK: - Icon

    /// Simple menu bar icon — a small circle with an arrow (proxy symbol).
    static func menuBarIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let ctx = NSGraphicsContext.current!.cgContext
            let midX = rect.midX
            let midY = rect.midY

            // Draw a small server box
            let boxRect = NSRect(x: midX - 6, y: midY - 4, width: 12, height: 8)
            ctx.setStrokeColor(NSColor.labelColor.cgColor)
            ctx.setLineWidth(1.5)
            ctx.stroke(boxRect)

            // Draw dots inside (representing activity)
            ctx.setFillColor(NSColor.labelColor.cgColor)
            ctx.fillEllipse(in: NSRect(x: midX - 3, y: midY - 1, width: 2, height: 2))
            ctx.fillEllipse(in: NSRect(x: midX + 1, y: midY - 1, width: 2, height: 2))

            return true
        }
        image.isTemplate = true
        return image
    }
}
