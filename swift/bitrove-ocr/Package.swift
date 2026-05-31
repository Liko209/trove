// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "bitrove-ocr",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "bitrove-ocr",
            path: ".",
            sources: ["main.swift"]
        )
    ]
)
