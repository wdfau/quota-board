import AppKit
import ApplicationServices

@MainActor
enum GeminiDesktop {
    private static let bundleID = "com.google.GeminiMacOS"
    enum Outcome {
        case submitted(pid_t), current, permissionNeeded, appMissing, accountMenuMissing, accountMissing, actionUnavailable
    }

    static func select(email: String) async -> Outcome {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return .appMissing }
        guard AXIsProcessTrusted() else { return .permissionNeeded }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        guard let app = try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration),
              app.bundleIdentifier == bundleID else { return .appMissing }

        let pid = app.processIdentifier
        return await Task.detached(priority: .userInitiated) {
            await Self.select(in: pid, email: email)
        }.value
    }

    static func requestPermission() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    static func verifyAfterRestart(from pid: pid_t, email: String) async -> Bool {
        let deadline = Date().addingTimeInterval(30)
        while !Task.isCancelled, Date() < deadline {
            if let newApp = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                .first(where: { $0.processIdentifier != pid && $0.isFinishedLaunching }) {
                let newPID = newApp.processIdentifier
                return await Task.detached(priority: .utility) {
                    let root = AXUIElementCreateApplication(newPID)
                    AXUIElementSetMessagingTimeout(root, 0.5)
                    guard let profile = await Self.waitForProfile(in: root) else { return false }
                    return Self.contains(email: email, in: Self.strings(profile) + Self.labels(in: profile, depth: 2))
                }.value
            }
            try? await Task.sleep(for: .milliseconds(400))
        }
        return false
    }

    nonisolated private static func waitForProfile(in root: AXUIElement) async -> AXUIElement? {
        let anchors = Set(["账号和设置", "account and settings", "帳戶與設定", "帳戶同設定"])
        return await waitForElement(in: root, seconds: 5) { item, role in
            guard ["AXButton", "AXMenuButton", "AXPopUpButton"].contains(role) else { return false }
            return strings(item).contains { anchors.contains($0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
                && supportsPress(item)
        }
    }

    nonisolated private static func select(in pid: pid_t, email: String) async -> Outcome {
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 0.7)
        let expected = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard expected.contains("@") else { return .accountMissing }

        guard let profile = await waitForProfile(in: root) else { return .accountMenuMissing }
        if contains(email: expected, in: strings(profile) + labels(in: profile, depth: 2)) { return .current }

        if attribute(profile, kAXExpandedAttribute) as? Bool != true {
            let result = AXUIElementPerformAction(profile, kAXPressAction as CFString)
            guard result == .success || result == .cannotComplete else { return .actionUnavailable }
        }
        // Read only the account menu/popover after opening it. Never match a chat message,
        // an account's nickname, a menu position, or an approximate pointer coordinate.
        let isAccount: (AXUIElement, String) -> Bool = { item, role in
            guard ["AXMenuItem", "AXButton", "AXLink", "AXRadioButton", "AXRow"].contains(role),
                  attribute(item, kAXEnabledAttribute) as? Bool != false else { return false }
            return contains(email: expected, in: strings(item) + labels(in: item, depth: 2)) && supportsPress(item)
        }
        let account = await waitForElement(in: root, seconds: 2, insideAccountMenu: true, matches: isAccount)
        let fallback = account == nil ? findInAccountGroup(in: root, matches: isAccount) : nil
        guard let account = account ?? fallback else { return .accountMissing }
        if attribute(account, kAXSelectedAttribute) as? Bool == true ||
            (attribute(account, kAXMenuItemMarkCharAttribute) as? String)?.isEmpty == false {
            return .current
        }
        let result = AXUIElementPerformAction(account, kAXPressAction as CFString)
        // Gemini may ask the user to confirm a restart. Leave that dialog in Gemini.
        return result == .success || result == .cannotComplete ? .submitted(pid) : .actionUnavailable
    }

    // Some SwiftUI popovers are exposed as groups. Identify one by Gemini's own Add account action.
    nonisolated private static func findInAccountGroup(in root: AXUIElement,
                                                       matches: (AXUIElement, String) -> Bool) -> AXUIElement? {
        let addLabels = Set(["添加账号", "add account", "新增帳戶"])
        guard let add = find(in: root, insideAccountMenu: false, matches: { item, role in
            ["AXMenuItem", "AXButton", "AXLink"].contains(role) &&
                strings(item).contains { addLabels.contains($0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) } &&
                supportsPress(item)
        }) else { return nil }
        var node = add
        for _ in 0..<4 {
            guard let raw = attribute(node, kAXParentAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { break }
            node = unsafeBitCast(raw, to: AXUIElement.self)
            let role = attribute(node, kAXRoleAttribute) as? String
            guard role != "AXApplication", role != "AXWindow" else { break }
            if let account = find(in: node, insideAccountMenu: false, matches: matches) { return account }
        }
        return nil
    }

    nonisolated private static func waitForElement(in root: AXUIElement, seconds: TimeInterval,
                                                   insideAccountMenu: Bool = false,
                                                   matches: (AXUIElement, String) -> Bool) async -> AXUIElement? {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if let element = find(in: root, insideAccountMenu: insideAccountMenu, matches: matches) { return element }
            try? await Task.sleep(for: .milliseconds(160))
        } while Date() < deadline
        return nil
    }

    nonisolated private static func find(in root: AXUIElement, insideAccountMenu: Bool,
                                         matches: (AXUIElement, String) -> Bool) -> AXUIElement? {
        var queue: [(AXUIElement, Bool, Int)] = [(root, false, 0)]
        // The focused item can expose an AppKit menu that's absent from AXWindows.
        if attribute(root, kAXRoleAttribute) as? String == "AXApplication" {
            for key in [kAXFocusedUIElementAttribute, kAXFocusedWindowAttribute] {
                if let raw = attribute(root, key), CFGetTypeID(raw) == AXUIElementGetTypeID() {
                    let element = unsafeBitCast(raw, to: AXUIElement.self)
                    queue.append((element, false, 0))
                    if let parent = attribute(element, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() {
                        queue.append((unsafeBitCast(parent, to: AXUIElement.self), false, 0))
                    }
                }
            }
        }
        var visited = Set<AXUIElement>()
        var visitedInMenu = Set<AXUIElement>()
        var cursor = 0
        while cursor < queue.count, cursor < 380 {
            let (item, inheritedMenu, depth) = queue[cursor]
            cursor += 1
            let role = attribute(item, kAXRoleAttribute) as? String ?? ""
            if role == "AXMenuBar" || role == "AXWebArea" || role == "AXTextArea" { continue }
            let inMenu = inheritedMenu || ["AXMenu", "AXPopover"].contains(role)
            let fresh = inMenu ? visitedInMenu.insert(item).inserted : visited.insert(item).inserted
            guard fresh else { continue }
            if (!insideAccountMenu || inMenu), matches(item, role) { return item }
            if depth < 13 {
                queue.append(contentsOf: children(item).prefix(70).map { ($0, inMenu, depth + 1) })
            }
        }
        return nil
    }

    nonisolated private static func attribute(_ item: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(item, key as CFString, &value) == .success ? value : nil
    }

    nonisolated private static func children(_ item: AXUIElement) -> [AXUIElement] {
        attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }

    nonisolated private static func strings(_ item: AXUIElement) -> [String] {
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute].compactMap {
            attribute(item, $0) as? String
        }
    }

    nonisolated private static func labels(in item: AXUIElement, depth: Int) -> [String] {
        guard depth > 0 else { return [] }
        return children(item).prefix(12).flatMap { child -> [String] in
            let role = attribute(child, kAXRoleAttribute) as? String ?? ""
            if ["AXMenuItem", "AXButton", "AXLink", "AXMenu", "AXPopover", "AXRadioButton", "AXRow"].contains(role) { return [] }
            return strings(child) + labels(in: child, depth: depth - 1)
        }
    }

    nonisolated static func contains(email: String, in labels: [String]) -> Bool {
        let emailCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "@._+!#$%&'*-/=?^`{|}~"))
        return labels.contains { label in
            label.components(separatedBy: emailCharacters.inverted).contains { $0.caseInsensitiveCompare(email) == .orderedSame }
        }
    }

    nonisolated private static func supportsPress(_ item: AXUIElement) -> Bool {
        var actions: CFArray?
        return AXUIElementCopyActionNames(item, &actions) == .success &&
            (actions as? [String])?.contains(kAXPressAction) == true
    }
}
