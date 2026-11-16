// AI Flows notifier: posts one macOS notification and quits. Clicking the
// notification relaunches the app, which opens the session it points to.
//
//   open -n -g -a "AI Flows.app" --args --payload ~/.claude/ai-flows/notify/<random>.json
//   open -n -g -a "AI Flows.app" --args --remove q-123     (question answered)
//
// The payload file holds {"id","title","subtitle","body","url","thread"}. It
// is a file and not arguments because other accounts can read the arguments
// of running programs. It is only accepted from the private notify folder,
// owned by you and readable by nobody else, and deleted once read.

import AppKit
import Darwin
import UserNotifications

let knownKeys: Set<String> = ["payload", "remove"]

// The argument after a known key is always its value, even when it starts
// with "--".
func parseArguments() -> [String: String] {
    let args = Array(CommandLine.arguments.dropFirst())
    var out: [String: String] = [:]
    var i = 0
    while i < args.count {
        let key = args[i].hasPrefix("--") ? String(args[i].dropFirst(2)) : ""
        if knownKeys.contains(key) {
            out[key] = i + 1 < args.count ? args[i + 1] : ""
            i += 2
        } else {
            i += 1
        }
    }
    return out
}

func readPayload(_ path: String) -> [String: String]? {
    let folder = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/ai-flows/notify")
    let resolved = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
    guard resolved.hasPrefix(folder + "/"), resolved.hasSuffix(".json") else { return nil }
    var info = stat()
    guard lstat(resolved, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFREG,          // a plain file, not a link or a pipe
          info.st_uid == getuid(),                      // yours
          (info.st_mode & 0o077) == 0,                  // nobody else can read or change it
          info.st_size < 64 * 1024 else { return nil }
    defer { unlink(resolved) }
    guard let data = FileManager.default.contents(atPath: resolved),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return object.compactMapValues { $0 as? String }
}

// A click only ever opens a Claude session or the dashboard on 127.0.0.1,
// whatever URL the payload holds.
func isAllowed(_ url: URL) -> Bool {
    switch url.scheme?.lowercased() {
    case "claude": return url.host?.lowercased() == "code"
    case "http": return url.host == "127.0.0.1"
    default: return false
    }
}

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    let args = parseArguments()

    func quit(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { NSApp.terminate(nil) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        // Never linger, even if macOS never answers the permission request.
        quit(after: 30)

        if let id = args["remove"], !id.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: [id])
            quit(after: 0.5)
            return
        }

        guard let path = args["payload"], let payload = readPayload(path),
              let title = payload["title"], !title.isEmpty else {
            // Started by a click on a notification (or by hand): the click
            // arrives through the delegate below, then we are done.
            quit(after: 5)
            return
        }

        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { self.quit(after: 0); return }
            let content = UNMutableNotificationContent()
            content.title = title
            if let subtitle = payload["subtitle"], !subtitle.isEmpty { content.subtitle = subtitle }
            content.body = payload["body"] ?? ""
            content.sound = .default
            content.threadIdentifier = payload["thread"] ?? "ai-flows"
            if let url = payload["url"] { content.userInfo = ["url": url] }
            let request = UNNotificationRequest(
                identifier: payload["id"] ?? UUID().uuidString, content: content, trigger: nil)
            self.center.add(request) { _ in self.quit(after: 1) }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let link = response.notification.request.content.userInfo["url"] as? String,
              let url = URL(string: link), isAllowed(url) else {
            done()
            quit(after: 0.5)
            return
        }
        // Since macOS 14 an app only comes to the front when the active app
        // hands over. The click made us the active app, so hand over to the
        // app that opens the link (Claude, or the browser for the dashboard)
        // and ask for it to be activated, so your keyboard lands there.
        let target = NSWorkspace.shared.urlForApplication(toOpen: url)
        if #available(macOS 14.0, *), let target, let id = Bundle(url: target)?.bundleIdentifier {
            NSApp.yieldActivation(toApplicationWithBundleIdentifier: id)
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open(url, configuration: config) { app, _ in
            DispatchQueue.main.async {
                if #available(macOS 14.0, *) { app?.activate() } else { app?.activate(options: []) }
                done()
                self.quit(after: 0.5)
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }
}

let app = NSApplication.shared
let notifier = Notifier()
app.delegate = notifier
app.run()
