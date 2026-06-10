// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CursorProxy",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CursorProxyCore", targets: ["CursorProxyCore"]),
        .executable(name: "CursorProxy", targets: ["CursorProxy"]),
    ],
    targets: [
        .target(
            name: "CursorProxyCore",
            path: "Sources/CursorProxyCore"
        ),
        .executableTarget(
            name: "CursorProxy",
            dependencies: ["CursorProxyCore"],
            path: "Sources/CursorProxy"
        ),
        .testTarget(
            name: "CursorProxyTests",
            dependencies: ["CursorProxyCore"],
            path: "Tests/CursorProxyTests"
        ),
    ]
)
