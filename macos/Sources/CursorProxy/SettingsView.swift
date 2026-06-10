import SwiftUI
import CursorProxyCore

/// Settings window view for configuring the proxy.
struct SettingsView: View {
    @ObservedObject var model: AppModel
    var onMenuRebuild: () -> Void

    @State private var portText: String = ""
    @State private var apiKeyText: String = ""
    @State private var proxyPathText: String = ""
    @State private var showAPIKey: Bool = false

    var body: some View {
        Form {
            Section("Server") {
                HStack {
                    Text("Port:")
                        .frame(width: 80, alignment: .trailing)
                    TextField("8787", text: $portText)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 100)
                    Button("Apply") {
                        if let port = UInt16(portText), port > 0 {
                            model.updatePort(port)
                            onMenuRebuild()
                        }
                    }
                    .disabled(portText.isEmpty)
                }

                HStack {
                    Text("Status:")
                        .frame(width: 80, alignment: .trailing)
                    Text(model.status.description)
                        .foregroundStyle(model.isRunning ? .green : .secondary)
                }
            }

            Section("Authentication") {
                HStack {
                    Text("API Key:")
                        .frame(width: 80, alignment: .trailing)
                    if showAPIKey {
                        TextField("cur_...", text: $apiKeyText)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        SecureField("cur_...", text: $apiKeyText)
                            .textFieldStyle(.roundedBorder)
                    }
                    Button(action: { showAPIKey.toggle() }) {
                        Image(systemName: showAPIKey ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.borderless)
                }

                HStack {
                    Spacer().frame(width: 80)
                    Button("Save") {
                        model.updateAPIKey(apiKeyText.isEmpty ? nil : apiKeyText)
                    }
                    Text("Stored in Keychain")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Proxy Source") {
                HStack {
                    Text("Path:")
                        .frame(width: 80, alignment: .trailing)
                    TextField("Auto-detect", text: $proxyPathText)
                        .textFieldStyle(.roundedBorder)
                    Button("Browse") {
                        let panel = NSOpenPanel()
                        panel.canChooseDirectories = true
                        panel.canChooseFiles = false
                        panel.allowsMultipleSelection = false
                        if panel.runModal() == .OK, let url = panel.url {
                            proxyPathText = url.path
                            model.updateProxyPath(url.path)
                            onMenuRebuild()
                        }
                    }
                }

                HStack {
                    Spacer().frame(width: 80)
                    Button("Reset to Auto") {
                        proxyPathText = ""
                        model.updateProxyPath(nil)
                        onMenuRebuild()
                    }
                    .disabled(proxyPathText.isEmpty)
                }
            }

            if let error = model.lastError {
                Section {
                    HStack {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .frame(minWidth: 400, minHeight: 280)
        .onAppear {
            portText = String(UserDefaults.standard.integer(forKey: "proxyPort"))
            if portText == "0" { portText = "8787" }
            proxyPathText = UserDefaults.standard.string(forKey: "proxySourcePath") ?? ""
            // Load API key from model (it reads from keychain)
            apiKeyText = ""
        }
    }
}
