import Testing
@testable import CursorProxyCore

@Test func proxyStatusDescriptions() {
    #expect(ProxyStatus.stopped.description == "Stopped")
    #expect(ProxyStatus.starting.description == "Starting...")
    #expect(ProxyStatus.running(port: 8787).description == "Running on port 8787")
    #expect(ProxyStatus.error("test").description == "Error: test")
}

@Test func proxyStatusIsRunning() {
    #expect(ProxyStatus.stopped.isRunning == false)
    #expect(ProxyStatus.starting.isRunning == false)
    #expect(ProxyStatus.running(port: 8787).isRunning == true)
    #expect(ProxyStatus.error("x").isRunning == false)
}

@Test func proxyStatusPort() {
    #expect(ProxyStatus.stopped.port == nil)
    #expect(ProxyStatus.running(port: 9999).port == 9999)
}

@Test func proxyConfigDefaults() {
    let config = ProxyConfig()
    #expect(config.port == 8787)
    #expect(config.apiKey == nil)
    #expect(config.proxySourcePath == nil)
    #expect(config.nodePath == nil)
    #expect(config.tsxPath == nil)
}

@Test func proxyErrorDescriptions() {
    let notFound = ProxyError.proxyNotFound("missing")
    #expect(notFound.localizedDescription.contains("missing"))

    let noPort = ProxyError.noAvailablePort
    #expect(noPort.localizedDescription.contains("port"))
}
