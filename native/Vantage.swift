// Vantage native shell: a WKWebView in a real Mac window (transparent titlebar,
// vibrancy) plus a menu-bar extra, and a JS↔native bridge so the shell supports
// the capabilities the browser has (native notifications, save/open panels,
// clipboard, wake lock, idle detection, sharing, Dock badge).
//
// Build with native/build.sh, then launch "Vantage.app".

import Cocoa
import WebKit
import UserNotifications
import IOKit.pwr_mgt
import CoreGraphics
import LocalAuthentication
import Security

let dashboardURL = URL(string: "http://localhost:8790/?app=1")!

// Injected before the page loads; exposed as window.vantageNative.
let bridgeJS = """
window.vantageNative = (function () {
  let seq = 0; const pending = {};
  window.__vantageNativeReply = function (id, ok, value, error) {
    const p = pending[id]; if (!p) return; delete pending[id];
    if (ok) p.resolve(value); else p.reject(new Error(error || 'native error'));
  };
  function call(action, payload) {
    return new Promise(function (resolve, reject) {
      const id = String(++seq); pending[id] = { resolve: resolve, reject: reject };
      try { window.webkit.messageHandlers.vantage.postMessage(Object.assign({ action: action, id: id }, payload || {})); }
      catch (e) { delete pending[id]; reject(e); }
    });
  }
  return {
    available: true,
    platform: 'macos',
    notify: function (title, body) { return call('notify', { title: title, body: body }); },
    setBadge: function (count) { return call('badge', { count: count }); },
    saveFile: function (name, dataBase64) { return call('saveFile', { name: name, dataBase64: dataBase64 }); },
    openFile: function () { return call('openFile', {}); },
    readClipboard: function () { return call('readClipboard', {}); },
    writeClipboard: function (text) { return call('writeClipboard', { text: text }); },
    wakeLock: function (on) { return call('wakeLock', { on: !!on }); },
    idleSeconds: function () { return call('idleSeconds', {}); },
    share: function (text) { return call('share', { text: text }); },
    openURL: function (url) { return call('openURL', { url: url }); },
    revealFile: function (path) { return call('revealFile', { path: path }); },
    touchIdAvailable: function () { return call('touchIdAvailable', {}); },
    touchIdEnroll: function () { return call('touchIdEnroll', {}); },
    touchIdSign: function (challenge) { return call('touchIdSign', { challenge: challenge }); }
  };
})();
"""

// WKWebView otherwise swallows the mouse-down, so the window never drags.
final class DraggableWebView: WKWebView {
    override var mouseDownCanMoveWindow: Bool { true }
}

extension Data {
    init?(base64URLEncoded string: String) {
        var value = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while value.count % 4 != 0 { value += "=" }
        self.init(base64Encoded: value)
    }
}

final class Bridge: NSObject, WKScriptMessageHandler, WKUIDelegate {
    weak var webView: WKWebView?
    private var wakeAssertion: IOPMAssertionID = 0
    private var wakeHeld = false
    private var sharePicker: NSSharingServicePicker?
    private var touchIdKeyURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("Vantage", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("touchid.key")
    }

    // MARK: - Incoming messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String,
              let id = body["id"] as? String else { return }
        switch action {
        case "notify": notify(id, body)
        case "badge": badge(id, body)
        case "saveFile": saveFile(id, body)
        case "openFile": openFile(id)
        case "readClipboard": reply(id, ok: true, value: NSPasteboard.general.string(forType: .string) ?? "")
        case "writeClipboard":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString((body["text"] as? String) ?? "", forType: .string)
            reply(id, ok: true)
        case "wakeLock": wakeLock(id, body)
        case "idleSeconds": reply(id, ok: true, value: idleSeconds())
        case "share": share(id, body)
        case "openURL":
            if let raw = body["url"] as? String, let url = URL(string: raw) { NSWorkspace.shared.open(url) }
            reply(id, ok: true)
        case "revealFile":
            if let path = body["path"] as? String { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            reply(id, ok: true)
        case "touchIdAvailable": touchIdAvailable(id)
        case "touchIdEnroll": touchIdEnroll(id)
        case "touchIdSign": touchIdSign(id, body)
        default:
            reply(id, ok: false, error: "unknown action \(action)")
        }
    }

    // MARK: - Actions

    private func notify(_ id: String, _ body: [String: Any]) {
        let title = (body["title"] as? String) ?? "Vantage"
        let text = (body["body"] as? String) ?? ""
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { self.reply(id, ok: false, error: "notification permission denied"); return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = text
            content.sound = .default
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
                if let error = error { self.reply(id, ok: false, error: error.localizedDescription) }
                else { self.reply(id, ok: true) }
            }
        }
    }

    private func badge(_ id: String, _ body: [String: Any]) {
        let count = (body["count"] as? NSNumber)?.intValue ?? 0
        DispatchQueue.main.async { NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil }
        reply(id, ok: true)
    }

    private func saveFile(_ id: String, _ body: [String: Any]) {
        guard let name = body["name"] as? String,
              let b64 = body["dataBase64"] as? String,
              let data = Data(base64Encoded: b64) else {
            reply(id, ok: false, error: "invalid payload")
            return
        }
        DispatchQueue.main.async {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            panel.begin { result in
                guard result == .OK, let url = panel.url else { self.reply(id, ok: true, value: ["cancelled": true]); return }
                do {
                    try data.write(to: url)
                    self.reply(id, ok: true, value: ["path": url.path])
                } catch {
                    self.reply(id, ok: false, error: error.localizedDescription)
                }
            }
        }
    }

    private func openFile(_ id: String) {
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = false
            panel.canChooseDirectories = false
            panel.begin { result in
                guard result == .OK, let url = panel.url, let data = try? Data(contentsOf: url) else {
                    self.reply(id, ok: true, value: ["cancelled": true])
                    return
                }
                self.reply(id, ok: true, value: ["name": url.lastPathComponent, "dataBase64": data.base64EncodedString()])
            }
        }
    }

    private func wakeLock(_ id: String, _ body: [String: Any]) {
        let on = (body["on"] as? Bool) ?? ((body["on"] as? NSNumber)?.boolValue ?? false)
        if on && !wakeHeld {
            var assertion: IOPMAssertionID = 0
            let result = IOPMAssertionCreateWithName(
                kIOPMAssertionTypeNoDisplaySleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "Vantage active job" as CFString,
                &assertion
            )
            if result == kIOReturnSuccess { wakeAssertion = assertion; wakeHeld = true }
        } else if !on && wakeHeld {
            IOPMAssertionRelease(wakeAssertion)
            wakeHeld = false
        }
        reply(id, ok: true)
    }

    private func idleSeconds() -> Double {
        let anyEvent = CGEventType(rawValue: ~0)!
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyEvent)
    }

    private func share(_ id: String, _ body: [String: Any]) {
        let text = (body["text"] as? String) ?? ""
        DispatchQueue.main.async {
            let picker = NSSharingServicePicker(items: [text])
            self.sharePicker = picker
            if let view = self.webView { picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY) }
            self.reply(id, ok: true)
        }
    }

    // MARK: - WKUIDelegate (media permissions)

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    // MARK: - Touch ID (biometry-gated key)

    private func touchIdAvailable(_ id: String) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let kind: String
        switch context.biometryType {
        case .touchID: kind = "touchid"
        case .faceID: kind = "faceid"
        case .opticID: kind = "opticid"
        default: kind = "none"
        }
        reply(id, ok: true, value: ["available": available, "biometry": kind])
    }

    private func touchIdEnroll(_ id: String) {
        let context = LAContext()
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) else {
            reply(id, ok: false, error: authError?.localizedDescription ?? "Biometrics unavailable")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let attributes: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrKeySizeInBits as String: 256,
            ]
            var createError: Unmanaged<CFError>?
            guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &createError),
                  let privateData = SecKeyCopyExternalRepresentation(privateKey, nil) as Data?,
                  let publicKey = SecKeyCopyPublicKey(privateKey),
                  let publicData = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else {
                let message = (createError?.takeRetainedValue() as Error?)?.localizedDescription ?? "Could not create key"
                self.reply(id, ok: false, error: message)
                return
            }
            do {
                try privateData.write(to: self.touchIdKeyURL, options: [.atomic])
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.touchIdKeyURL.path)
            } catch {
                self.reply(id, ok: false, error: error.localizedDescription)
                return
            }
            self.reply(id, ok: true, value: ["publicKey": publicData.base64EncodedString()])
        }
    }

    private func touchIdSign(_ id: String, _ body: [String: Any]) {
        guard let challengeB64 = body["challenge"] as? String, let challenge = Data(base64URLEncoded: challengeB64) else {
            reply(id, ok: false, error: "challenge is required")
            return
        }
        let keyURL = touchIdKeyURL
        DispatchQueue.global(qos: .userInitiated).async {
            guard let privateData = try? Data(contentsOf: keyURL) else {
                self.reply(id, ok: false, error: "No enrolled key. Enable Touch ID first.")
                return
            }
            let keyAttributes: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            ]
            var dataError: Unmanaged<CFError>?
            guard let privateKey = SecKeyCreateWithData(privateData as CFData, keyAttributes as CFDictionary, &dataError) else {
                self.reply(id, ok: false, error: "Could not load the enrolled key")
                return
            }
            let context = LAContext()
            context.localizedReason = "Confirm your fingerprint for this action"
            var authError: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) else {
                self.reply(id, ok: false, error: authError?.localizedDescription ?? "Biometrics unavailable")
                return
            }
            let semaphore = DispatchSemaphore(value: 0)
            var verified = false
            var evalError: Error?
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Confirm your fingerprint for this action") { ok, error in
                verified = ok
                evalError = error
                semaphore.signal()
            }
            semaphore.wait()
            guard verified else {
                self.reply(id, ok: false, error: evalError?.localizedDescription ?? "Touch ID cancelled")
                return
            }
            var signError: Unmanaged<CFError>?
            let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
            guard let signature = SecKeyCreateSignature(privateKey, algorithm, challenge as CFData, &signError) as Data? else {
                let message = (signError?.takeRetainedValue() as Error?)?.localizedDescription ?? "Signing failed"
                self.reply(id, ok: false, error: message)
                return
            }
            self.reply(id, ok: true, value: ["signature": signature.base64EncodedString()])
        }
    }

    // MARK: - Reply plumbing

    private func reply(_ id: String, ok: Bool, value: Any? = nil, error: String? = nil) {
        let js = "window.__vantageNativeReply(\(jsString(id)), \(ok ? "true" : "false"), \(jsonLiteral(value)), \(jsonLiteral(error)));"
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    private func jsonLiteral(_ value: Any?) -> String {
        switch value {
        case nil:
            return "null"
        case let string as String:
            return jsString(string)
        case let number as NSNumber:
            return number.stringValue
        default:
            if let value = value, let data = try? JSONSerialization.data(withJSONObject: value),
               let json = String(data: data, encoding: .utf8) {
                return json
            }
            return "null"
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem?
    let bridge = Bridge()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        buildWindow()
        buildStatusItem()
    }

    // MARK: - Window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        controller.add(bridge, name: "vantage")
        config.userContentController = controller

        let web = DraggableWebView(frame: .zero, configuration: config)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.setValue(false, forKey: "drawsBackground")
        web.uiDelegate = bridge
        bridge.webView = web
        web.load(URLRequest(url: dashboardURL))
        webView = web

        let effect = NSVisualEffectView()
        effect.translatesAutoresizingMaskIntoConstraints = false
        effect.material = .underWindowBackground
        effect.blendingMode = .behindWindow
        effect.state = .active

        let container = NSView()
        container.addSubview(effect)
        container.addSubview(web)
        NSLayoutConstraint.activate([
            effect.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            effect.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            effect.topAnchor.constraint(equalTo: container.topAnchor),
            effect.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            web.topAnchor.constraint(equalTo: container.topAnchor),
            web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Vantage"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.contentView = container
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    // MARK: - Menu bar

    func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Vantage", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Vantage", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        NSApp.mainMenu = mainMenu
    }

    func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "gauge.medium", accessibilityDescription: "Vantage")
        let menu = NSMenu()
        let openItem = NSMenuItem(title: "Open Vantage", action: #selector(showWindow), keyEquivalent: "")
        openItem.target = self
        menu.addItem(openItem)
        menu.addItem(.separator())
        for (title, script) in [("Rescan machine", "triggerScan()"), ("Clean up disk", "startCleanup()"), ("Open Monitor", "setView('monitor')")] {
            let menuItem = NSMenuItem(title: title, action: #selector(runScript(_:)), keyEquivalent: "")
            menuItem.target = self
            menuItem.representedObject = script
            menu.addItem(menuItem)
        }
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        item.menu = menu
        statusItem = item
    }

    // MARK: - Actions

    @objc func showWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    @objc func reload() {
        webView?.load(URLRequest(url: dashboardURL))
    }

    @objc func zoomReset() {
        webView?.pageZoom = 1
    }

    @objc func runScript(_ sender: NSMenuItem) {
        guard let script = sender.representedObject as? String else { return }
        showWindow()
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
