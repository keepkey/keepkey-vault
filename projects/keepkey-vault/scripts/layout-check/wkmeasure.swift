// Offscreen WKWebView: load a page at a viewport size, wait, run a JS probe
// (must return a JSON string), print it, and save a PNG snapshot.
// usage: wkmeasure <url> <width> <height> <probe.js> <out.png> [waitSeconds]
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 6 else { print("usage"); exit(2) }
let url = URL(string: args[1])!
let w = CGFloat(Double(args[2])!), h = CGFloat(Double(args[3])!)
let probe = try! String(contentsOfFile: args[4], encoding: .utf8)
let outPng = args[5]
let wait = args.count > 6 ? Double(args[6])! : 3.0

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let config = WKWebViewConfiguration()
config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: w, height: h), styleMask: [.borderless], backing: .buffered, defer: false)
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: config)
window.contentView = web
window.orderBack(nil)

final class Nav: NSObject, WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
      webView.evaluateJavaScript(probe) { result, error in
        if let error = error { print("PROBE_ERROR \(error)") }
        if let s = result as? String { print("PROBE_RESULT \(s)") }
        let cfg = WKSnapshotConfiguration()
        webView.takeSnapshot(with: cfg) { image, _ in
          if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
             let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: outPng))
          }
          exit(0)
        }
      }
    }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { print("NAV_FAIL \(error)"); exit(1) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { print("NAV_FAIL \(error)"); exit(1) }
}
let nav = Nav()
web.navigationDelegate = nav
if url.isFileURL { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) } else { web.load(URLRequest(url: url)) }
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { print("TIMEOUT"); exit(3) }
app.run()
