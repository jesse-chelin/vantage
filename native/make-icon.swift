// Renders the Vantage app icon (1024px PNG) used by the native .app bundle.

import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// Rounded-square background with a diagonal gradient.
let inset = size * 0.09
let body = NSBezierPath(
    roundedRect: NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2),
    xRadius: size * 0.225,
    yRadius: size * 0.225
)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.44, green: 0.51, blue: 0.98, alpha: 1),
    NSColor(calibratedRed: 0.20, green: 0.24, blue: 0.66, alpha: 1),
])!
gradient.draw(in: body, angle: -70)

// Specular highlight along the top edge.
NSColor.white.withAlphaComponent(0.18).set()
let sheen = NSBezierPath(
    roundedRect: NSRect(x: inset + size * 0.03, y: size * 0.56, width: size - inset * 2 - size * 0.06, height: size * 0.30),
    xRadius: size * 0.2, yRadius: size * 0.2
)
sheen.fill()

// Gauge glyph.
let cx = size / 2
let cy = size / 2
let radius = size * 0.26
NSColor.white.set()

let arc = NSBezierPath()
arc.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: radius, startAngle: 200, endAngle: -20, clockwise: true)
arc.lineWidth = size * 0.05
arc.lineCapStyle = .round
arc.stroke()

let needleAngle = Double.pi / 4
let needle = NSBezierPath()
needle.move(to: NSPoint(x: cx, y: cy))
needle.line(to: NSPoint(x: cx + radius * 0.72 * cos(needleAngle), y: cy + radius * 0.72 * sin(needleAngle)))
needle.lineWidth = size * 0.05
needle.lineCapStyle = .round
needle.stroke()

let hub = NSBezierPath(ovalIn: NSRect(x: cx - size * 0.045, y: cy - size * 0.045, width: size * 0.09, height: size * 0.09))
hub.fill()

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("icon render failed\n".data(using: .utf8)!)
    exit(1)
}
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
