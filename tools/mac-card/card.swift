import Cocoa
import WebKit

// 菜单栏常驻的基金估值卡片。
//
// 两种状态：
//   收起 —— 只在菜单栏显示一行数字（今日收益 %），像 Wi-Fi / 电池那样不占地方
//   展开 —— 点一下菜单栏，在图标正下方弹出 320×220 的卡片；点外面自动收起
//
// 卡片仍可拖动（拖走后就不再跟随菜单栏，方便丢到副屏）；
// 右键菜单里有「复位到菜单栏下方」把位置还给菜单栏。

private let kAppURL = "http://127.0.0.1:5178/?compact=1"
private let kFullURL = "http://127.0.0.1:5178/"
private let kApiURL = "http://127.0.0.1:5178/api/estimate"
private let kCardSize = NSSize(width: 340, height: 440)   // 上方总览 + 中间曲线 + 下方可滚动的基金列表
private let kOriginXKey = "cardOriginX"
private let kOriginYKey = "cardOriginY"
private let kMovedKey = "cardMoved"

/// borderless 窗口默认 `canBecomeKey == false`，后果是：
///   - 失去焦点时不会 resignKey，「点外面自动收起」永远不触发
///   - 接收不到键盘事件，Esc 关不掉
/// 两者叠加就是「卡片弹出来遮住东西，还点不掉」。
final class CardWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Esc 收起
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            orderOut(nil)
        } else {
            super.keyDown(with: event)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var retryTimer: Timer?
    private var titleTimer: Timer?
    private var showingError = false
    private var lastPct: Double = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        buildWindow()
        loadApp()
        startTitlePolling()
        NotificationCenter.default.addObserver(
            self, selector: #selector(windowDidResignKey(_:)),
            name: NSWindow.didResignKeyNotification, object: nil
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        saveOrigin()
        retryTimer?.invalidate()
        titleTimer?.invalidate()
    }

    // MARK: - 菜单栏

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }
        button.title = "…"
        button.toolTip = "美股基金估值"
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showContextMenu()
        } else {
            toggleCard()
        }
    }

    private func showContextMenu() {
        let menu = NSMenu()
        let items: [(String, Selector, String)] = [
            ("打开完整页面", #selector(openFullPage), "o"),
            ("立即刷新", #selector(reloadNow), "r"),
            ("复位到菜单栏下方", #selector(resetCardPosition), ""),
        ]
        for (title, action, key) in items {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        // 临时挂上菜单再点一次：这样右键能出菜单，而左键仍是自己处理
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    /// 每 5 秒取一次总览，把「今日收益百分比」写进菜单栏
    private func startTitlePolling() {
        updateStatusTitle()
        titleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.updateStatusTitle()
        }
    }

    private func updateStatusTitle() {
        guard let url = URL(string: kApiURL) else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        req.cachePolicy = .reloadIgnoringLocalCacheData

        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self else { return }
            guard
                let data,
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let funds = obj["funds"] as? [[String: Any]]
            else {
                DispatchQueue.main.async { self.setTitle(text: "离线", pct: nil) }
                return
            }

            var total = 0.0
            var amount = 0.0
            for f in funds {
                total += (f["marketValue"] as? Double) ?? 0
                amount += (f["amount"] as? Double) ?? 0
            }
            // 百分比以「昨收市值」为分母，与券商 App 的当日涨幅同口径
            let base = total - amount
            let pct = base > 0 ? amount / base * 100 : 0

            DispatchQueue.main.async {
                self.lastPct = pct
                if funds.isEmpty {
                    self.setTitle(text: "无持仓", pct: nil)
                } else {
                    self.setTitle(text: String(format: "%+.2f%%", pct), pct: pct)
                }
            }
        }.resume()
    }

    private func setTitle(text: String, pct: Double?) {
        guard let button = statusItem.button else { return }
        let color: NSColor
        if let p = pct {
            color = p > 0 ? NSColor.systemRed : (p < 0 ? NSColor.systemGreen : NSColor.labelColor)
        } else {
            color = NSColor.secondaryLabelColor
        }
        button.attributedTitle = NSAttributedString(
            string: text,
            attributes: [
                .foregroundColor: color,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            ]
        )
    }

    // MARK: - 卡片窗口

    private func buildWindow() {
        let origin = savedOrigin() ?? originBelowStatusItem()

        window = CardWindow(
            contentRect: NSRect(origin: origin, size: kCardSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .statusBar
        window.isMovableByWindowBackground = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.isReleasedWhenClosed = false

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(origin: .zero, size: kCardSize), configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.wantsLayer = true
        webView.layer?.cornerRadius = 16
        webView.layer?.masksToBounds = true
        window.contentView = webView

        let dblclick = NSClickGestureRecognizer(target: self, action: #selector(openFullPage))
        dblclick.numberOfClicksRequired = 2
        webView.addGestureRecognizer(dblclick)

        NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: window, queue: .main
        ) { [weak self] _ in
            self?.saveOrigin()
            UserDefaults.standard.set(true, forKey: kMovedKey)
        }
    }

    /// 贴在菜单栏图标正下方，水平居中于图标，并夹在屏幕可见区内
    private func originBelowStatusItem() -> NSPoint {
        guard
            let button = statusItem.button,
            let buttonWindow = button.window,
            let screen = buttonWindow.screen
        else {
            let v = NSScreen.main?.visibleFrame ?? .zero
            return NSPoint(x: v.maxX - kCardSize.width - 24, y: v.maxY - kCardSize.height - 24)
        }
        let rectOnScreen = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let cx = rectOnScreen.midX - kCardSize.width / 2
        let x = min(max(cx, screen.visibleFrame.minX + 8), screen.visibleFrame.maxX - kCardSize.width - 8)
        return NSPoint(x: x, y: rectOnScreen.minY - kCardSize.height - 6)
    }

    @objc private func toggleCard() {
        if window.isVisible {
            window.orderOut(nil)
            return
        }
        if !UserDefaults.standard.bool(forKey: kMovedKey) {
            window.setFrameOrigin(originBelowStatusItem())
        }
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func resetCardPosition() {
        UserDefaults.standard.set(false, forKey: kMovedKey)
        window.setFrameOrigin(originBelowStatusItem())
        window.orderFrontRegardless()
    }

    @objc private func windowDidResignKey(_ note: Notification) {
        guard let w = note.object as? NSWindow, w == window else { return }
        if window.isVisible { window.orderOut(nil) }
    }

    private func savedOrigin() -> NSPoint? {
        let d = UserDefaults.standard
        guard d.bool(forKey: kMovedKey) else { return nil }
        guard d.object(forKey: kOriginXKey) != nil, d.object(forKey: kOriginYKey) != nil else { return nil }
        let p = NSPoint(x: d.double(forKey: kOriginXKey), y: d.double(forKey: kOriginYKey))
        let rect = NSRect(origin: p, size: kCardSize)
        return NSScreen.screens.contains { $0.visibleFrame.intersects(rect) } ? p : nil
    }

    private func saveOrigin() {
        guard let w = window else { return }
        let d = UserDefaults.standard
        d.set(w.frame.origin.x, forKey: kOriginXKey)
        d.set(w.frame.origin.y, forKey: kOriginYKey)
    }

    // MARK: - 动作

    @objc private func openFullPage() {
        guard let url = URL(string: kFullURL) else { return }
        NSWorkspace.shared.open(url)
        window.orderOut(nil)
    }

    @objc private func reloadNow() {
        loadApp()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - 加载

    private func loadApp() {
        guard let url = URL(string: kAppURL) else { return }
        showingError = false
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    private func showOfflineCard() {
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self, self.showingError else { return }
            self.loadApp()
        }
        let html = """
        <!doctype html><meta charset="utf-8">
        <style>
          html,body{margin:0;height:100%;background:transparent}
          .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
                font:13px/1.5 -apple-system,"PingFang SC",sans-serif;color:#8892a6;
                background:rgba(16,22,36,.94);border-radius:16px;
                box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
          .t{color:#e8edf7;font-weight:600;margin-bottom:6px}
          .s{font-size:11px;opacity:.8}
        </style>
        <div class="wrap">
          <div class="t">连不上本地服务</div>
          <div class="s">先在项目目录运行 pnpm dev</div>
          <div class="s">每 15 秒自动重试</div>
        </div>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if showingError { return }
        showingError = true
        showOfflineCard()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !showingError { retryTimer?.invalidate() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // 不占 Dock，只留菜单栏
app.run()
