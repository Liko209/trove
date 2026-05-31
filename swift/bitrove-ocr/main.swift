// bitrove-ocr — extract text from PDF or image files using Vision Framework.
//
// Usage:
//   bitrove-ocr <path>
//
// Stdout: extracted text (UTF-8). Pages separated by \f (form-feed).
// Stderr: progress + warnings.
// Exit codes:
//   0  ok
//   2  bad arguments / file not found
//   3  PDF could not be opened (corrupt / encrypted)
//   4  Vision request failed
//
// Designed to be called from Node via child_process.execFile. Stays
// fully on-device — VNRecognizeTextRequest is part of the system
// Vision framework, no network, no telemetry.

import Foundation
import Vision
import PDFKit
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: bitrove-ocr <path>\n".data(using: .utf8)!)
    exit(2)
}
let path = args[1]
let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: path) else {
    FileHandle.standardError.write("file not found: \(path)\n".data(using: .utf8)!)
    exit(2)
}

// Recognized languages prioritised for Chinese + English + Japanese +
// Korean. Vision picks the best language per text region — order is a
// preference hint, not a filter.
let langs = ["zh-Hans", "zh-Hant", "en-US", "ja", "ko"]

func recognize(cgImage: CGImage) -> String {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    if #available(macOS 13.0, *) {
        req.revision = VNRecognizeTextRequestRevision3
        req.automaticallyDetectsLanguage = true
    }
    req.recognitionLanguages = langs

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([req])
    } catch {
        FileHandle.standardError.write("vision error: \(error.localizedDescription)\n".data(using: .utf8)!)
        return ""
    }
    guard let observations = req.results else { return "" }
    // Each observation may have several candidates; the top one is
    // already the highest-confidence pick. Join on \n so the chunker
    // downstream can still split paragraphs.
    let lines = observations.compactMap { $0.topCandidates(1).first?.string }
    return lines.joined(separator: "\n")
}

let ext = url.pathExtension.lowercased()
let stdout = FileHandle.standardOutput

if ext == "pdf" {
    guard let pdf = PDFDocument(url: url) else {
        FileHandle.standardError.write("could not open PDF\n".data(using: .utf8)!)
        exit(3)
    }
    let pageCount = pdf.pageCount
    for i in 0..<pageCount {
        guard let page = pdf.page(at: i) else { continue }
        // Render at 2x to give Vision enough resolution. PDFKit's
        // default thumbnail is too small for reliable OCR on dense
        // pages; 2x roughly matches a 144 DPI scan.
        let bounds = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0
        let pixelSize = NSSize(width: bounds.width * scale, height: bounds.height * scale)
        let img = NSImage(size: pixelSize)
        img.lockFocus()
        if let ctx = NSGraphicsContext.current?.cgContext {
            ctx.saveGState()
            ctx.setFillColor(CGColor.white)
            ctx.fill(CGRect(origin: .zero, size: pixelSize))
            ctx.scaleBy(x: scale, y: scale)
            page.draw(with: .mediaBox, to: ctx)
            ctx.restoreGState()
        }
        img.unlockFocus()
        var rect = NSRect(origin: .zero, size: pixelSize)
        guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
            FileHandle.standardError.write("page \(i): cg render failed\n".data(using: .utf8)!)
            continue
        }
        let text = recognize(cgImage: cg)
        if !text.isEmpty {
            stdout.write(text.data(using: .utf8)!)
            // Form-feed between pages so the chunker treats them as
            // distinct sections. Trailing \f after the last page is
            // intentional and harmless.
            stdout.write("\u{0C}".data(using: .utf8)!)
        }
        FileHandle.standardError.write("page \(i+1)/\(pageCount): \(text.count) chars\n".data(using: .utf8)!)
    }
    exit(0)
}

// Image inputs (png/jpg/heic/tiff) — Vision handles them directly.
if let img = NSImage(contentsOf: url),
   let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    let text = recognize(cgImage: cg)
    stdout.write(text.data(using: .utf8)!)
    exit(0)
}

FileHandle.standardError.write("unsupported file type: \(ext)\n".data(using: .utf8)!)
exit(2)
