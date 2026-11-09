import Cocoa
import WebKit

// 桌面小卡片：无边框、半透明、始终置顶的 WKWebView 窗口。
// 页面由后端提供（/?compact=1），所以卡片本身不含任何业务逻辑。

private let kAppURL = "http://127.0.0.1:5178/?compact=1"
private let kCardSize = NSSize(width: 320, height: 220)
private let kOriginXKey = "cardOriginX"
private let kOriginYKey = "cardOriginY"
private let kVisibleKey = "cardVisible"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var retryTimer: Timer?
    private var reloadTimer: Timer?
    private var showingError = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        buildWindow()
        loadApp()

        // 每 5 分钟整页重载一次：长时间常驻后 WebContent 进程可能被系统回收成白屏
        reloadTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.loadApp()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        saveOrigin()
        retryTimer?.invalidate()
        reloadTimer?.invalidate()
    }

    // MARK: - 菜单栏

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "📈"
        statusItem.button?.toolTip = "美股基金估值卡片"

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "显示 / 隐藏", action: #selector(toggleWindow), keyEquivalent: "t"))
        menu.addItem(NSMenuItem(title: "立即刷新", action: #selector(reloadNow), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    @objc private func toggleWindow() {
        if window.isVisible {
            window.orderOut(nil)
            UserDefaults.standard.set(false, forKey: kVisibleKey)
        } else {
            window.orderFrontRegardless()
            UserDefaults.standard.set(true, forKey: kVisibleKey)
        }
    }

    @objc private func reloadNow() {
        loadApp()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - 窗口

    private func buildWindow() {
        let origin = savedOrigin() ?? defaultOrigin()

        window = NSWindow(
            contentRect: NSRect(origin: origin, size: kCardSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .floating                     // 始终浮在其他窗口之上
        window.isMovableByWindowBackground = true    // 拖动卡片任意位置即可移动
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(origin: .zero, size: kCardSize), configuration: config)
        webView.navigationDelegate = self
        // 关键：让 WKWebView 自身透明，页面才能画出圆角玻璃面板
        webView.setValue(false, forKey: "drawsBackground")
        webView.wantsLayer = true
        webView.layer?.cornerRadius = 16
        webView.layer?.masksToBounds = true

        window.contentView = webView

        NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            self?.saveOrigin()
        }

        if UserDefaults.standard.object(forKey: kVisibleKey) as? Bool ?? true {
            window.orderFrontRegardless()
        }
    }

    private func defaultOrigin() -> NSPoint {
        guard let screen = NSScreen.main else { return NSPoint(x: 100, y: 100) }
        let v = screen.visibleFrame
        // 默认贴右上角，留 24pt 边距
        return NSPoint(x: v.maxX - kCardSize.width - 24, y: v.maxY - kCardSize.height - 24)
    }

    private func savedOrigin() -> NSPoint? {
        let d = UserDefaults.standard
        guard d.object(forKey: kOriginXKey) != nil, d.object(forKey: kOriginYKey) != nil else { return nil }
        return NSPoint(x: d.double(forKey: kOriginXKey), y: d.double(forKey: kOriginYKey))
    }

    private func saveOrigin() {
        guard let w = window else { return }
        let d = UserDefaults.standard
        d.set(w.frame.origin.x, forKey: kOriginXKey)
        d.set(w.frame.origin.y, forKey: kOriginYKey)
    }

    // MARK: - 加载

    private func loadApp() {
        guard let url = URL(string: kAppURL) else { return }
        showingError = false
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    // 后端没起来时给一句人话，而不是一片空白
    private func showOfflineCard() {
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.showingError { self.loadApp() }
        }

        let html = """
        <!doctype html><meta charset="utf-8">
        <style>
          html,body{margin:0;height:100%;background:transparent}
          .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
                font:13px/1.5 -apple-system,"PingFang SC",sans-serif;color:#8892a6;
                background:rgba(16,22,36,.92);border-radius:16px;
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
        // loadHTMLString 也会走进来，用标志位避免自己套自己
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
// .accessory：不占 Dock、不抢菜单栏焦点，只留一个状态栏图标
app.setActivationPolicy(.accessory)
app.run()
