// Renders SF Symbols to PNG using the system API, so Vantage can show the real
// system icons (not exported/redistributed assets). Compiled on demand by
// lib/symbols.js. The symbol is drawn as a template (black on transparent);
// the web UI uses it as a CSS mask so it inherits the theme colour.
//
//   sfrender <symbol> <size> <out.png>      render one symbol
//   sfrender --check <symbol>               exit 0 if the symbol exists here
//   sfrender --batch <list.tsv>             render lines of "symbol<TAB>size<TAB>out"

import AppKit
import Foundation

func render(_ name: String, size: Int, out: String) -> Bool {
    let config = NSImage.SymbolConfiguration(pointSize: CGFloat(size), weight: .regular)
    guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(config) else { return false }
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return false }
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current = context
    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    image.draw(in: rect)
    // Recolor the symbol white (keeping its alpha) so the PNG works as a mask
    // whether the engine treats it as alpha or luminance.
    NSColor.white.set()
    context?.compositingOperation = .sourceIn
    NSBezierPath(rect: rect).fill()
    NSGraphicsContext.restoreGraphicsState()

    // macOS draws symbols with generous transparent margins; crop to the glyph
    // so it fills the element it is masked into (like the line icons did).
    guard let bitmap = rep.bitmapData, let source = rep.cgImage else {
        return write(rep, to: out)
    }
    let stride = rep.bytesPerRow
    let bpp = max(1, rep.bitsPerPixel / 8)
    var minX = size, minY = size, maxX = -1, maxY = -1
    for y in 0..<size {
        for x in 0..<size where bitmap[y * stride + x * bpp + (bpp - 1)] > 16 {
            if x < minX { minX = x }
            if x > maxX { maxX = x }
            if y < minY { minY = y }
            if y > maxY { maxY = y }
        }
    }
    guard maxX >= minX else { return write(rep, to: out) }
    let pad = 1
    let x0 = max(0, minX - pad)
    let y0 = max(0, minY - pad)
    let w = min(size - x0, (maxX - minX + 1) + pad * 2)
    let h = min(size - y0, (maxY - minY + 1) + pad * 2)
    if let cropped = source.cropping(to: CGRect(x: x0, y: y0, width: w, height: h)) {
        return write(NSBitmapImageRep(cgImage: cropped), to: out)
    }
    return write(rep, to: out)
}

func write(_ rep: NSBitmapImageRep, to out: String) -> Bool {
    guard let data = rep.representation(using: .png, properties: [:]) else { return false }
    do { try data.write(to: URL(fileURLWithPath: out)); return true } catch { return false }
}

let args = CommandLine.arguments

if args.count >= 3 && args[1] == "--batch" {
    guard let content = try? String(contentsOfFile: args[2], encoding: .utf8) else { exit(66) }
    for line in content.split(separator: "\n") {
        let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3 else { continue }
        let ok = render(parts[0], size: Int(parts[1]) ?? 64, out: parts[2])
        print("\(ok ? "ok" : "fail")\t\(parts[0])")
    }
    exit(0)
}

if args.count >= 3 && args[1] == "--check" {
    exit(NSImage(systemSymbolName: args[2], accessibilityDescription: nil) != nil ? 0 : 2)
}

guard args.count >= 4 else {
    FileHandle.standardError.write("usage: sfrender <symbol> <size> <out> | --check <symbol> | --batch <list.tsv>\n".data(using: .utf8)!)
    exit(64)
}
exit(render(args[1], size: Int(args[2]) ?? 64, out: args[3]) ? 0 : 2)
