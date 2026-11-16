// AI Flows notifier: posts one macOS notification and quits. Clicking the
// notification relaunches the app, which opens the session it points to.
//
//   open -n -g -a "AI Flows.app" --args --id q-123 --title "…" --subtitle "…" \
//        --body "…" --url "claude://code/continue?session=local_…" --thread <sid>
//   open -n -g -a "AI Flows.app" --args --remove q-123     (question answered)

import AppKit
import UserNotifications

func parseArguments() -> [String: String] {
    var out: [String: String] = [:]
    var key: String?
    for arg in CommandLine.arguments.dropFirst() {
        if arg.hasPrefix("--") {
            key = String(arg.dropFirst(2))
            out[key!] = ""
        } else if let k = key {
            out[k] = arg
            key = nil
        }
    }
    return out
}

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    let args = parseArguments()

    func quit(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { NSApp.terminate(nil) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self

        if let id = args["remove"], !id.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: [id])
            quit(after: 0.5)
            return
        }

        guard let title = args["title"], !title.isEmpty else {
            // Started by a click on a notification (or by hand): the click
            // arrives through the delegate below, then we are done.
            quit(after: 5)
            return
        }

        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { self.quit(after: 0); return }
            let content = UNMutableNotificationContent()
            content.title = title
            if let subtitle = self.args["subtitle"], !subtitle.isEmpty { content.subtitle = subtitle }
            content.body = self.args["body"] ?? ""
            content.sound = .default
            content.threadIdentifier = self.args["thread"] ?? "ai-flows"
            if let url = self.args["url"] { content.userInfo = ["url": url] }
            let request = UNNotificationRequest(
                identifier: self.args["id"] ?? UUID().uuidString, content: content, trigger: nil)
            self.center.add(request) { _ in self.quit(after: 1) }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let link = response.notification.request.content.userInfo["url"] as? String,
           let url = URL(string: link) {
            NSWorkspace.shared.open(url)
        }
        done()
        quit(after: 0.5)
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
