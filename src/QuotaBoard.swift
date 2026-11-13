import AppKit
import SwiftUI

struct QuotaWindow: Codable, Identifiable {
    let title: String
    let remaining: Double
    let resetsAt: String?
    let detail: String?
    var minutes: Int?
    var id: String { title }

    var englishTitle: String {
        switch title {
        case "5 小时": return "5 Hours"
        case "每周": return "Weekly"
        case "本月": return "Monthly"
        case "主要额度": return "Primary"
        case "其他额度": return "Other"
        case "额外额度": return "Additional"
        default: return title
        }
    }

    var durationForDisplay: Int {
        let known = ["5 Hours": 300, "Daily": 1440, "Weekly": 10080, "Monthly": 43200]
        return minutes ?? known[englishTitle] ?? Int.max
    }
}

struct QuotaCard: Codable, Identifiable {
    let id: String
    let provider: String
    let label: String
    var email: String
    var plan: String
    var status: String
    var message: String?
    var windows: [QuotaWindow]
    var details: [String]
    var updatedAt: String?
    var source: String
    let url: String
    var errorCode: String?
    var identityKey: String?

    var emailPrefix: String? {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = address.lastIndex(of: "@"),
              at != address.startIndex, address.index(after: at) != address.endIndex else { return nil }
        return String(address[..<at])
    }

    static func initial(_ id: String, _ provider: String, _ label: String) -> QuotaCard {
        let links = [
            "Codex": "https://chatgpt.com/codex/settings/usage",
            "Kiro": "https://app.kiro.dev/account/usage",
            "Cursor": "https://cursor.com/dashboard",
            "Claude": "https://claude.ai/settings/usage",
            "GitHub Copilot": "https://github.com/settings/copilot"
        ]
        return QuotaCard(id: id, provider: provider, label: label, email: "",
                         plan: provider, status: "pending", windows: [], details: [],
                         source: "等待读取", url: links[provider]!)
    }
}

struct ImportAccount: Codable, Identifiable {
    let id: String
    let provider: String
    let label: String
    var email: String
    let identityKey: String

    var selectionKey: String { provider + ":" + identityKey }

    var placeholder: QuotaCard {
        var card = QuotaCard.initial(id, provider, label)
        card.email = email
        card.identityKey = identityKey
        return card
    }
}

private struct DiscoveryResult: Decodable {
    var accounts: [ImportAccount]?
    var message: String?
}

private struct SwitchResult: Decodable {
    var switched: Bool?
    var launch: Bool?
    var previousID: String?
    var previousIdentity: String?
    var message: String?
}

final class BoardStore: ObservableObject {
    private static let importedKey = "ImportedQuotaAccounts"
    @Published var cards: [QuotaCard] = []
    @Published private(set) var imported: [ImportAccount] = []
    @Published private(set) var hiddenProviders: Set<String> =
        Set(UserDefaults.standard.stringArray(forKey: "HiddenQuotaProviders") ?? [])
    private(set) var isConfigured = false
    private var refreshAfterChange = false
    @Published private(set) var activeAccounts: [String: String] = [:]
    @Published var refreshing = false
    @Published var refreshingIDs: Set<String> = []
    @Published var lastRefresh: Date?
    @Published var processMessage: String?
    @Published private(set) var aliases = UserDefaults.standard.dictionary(forKey: "AccountAliases") as? [String: String] ?? [:]
    @Published var renamingAccount: QuotaCard?
    @Published private(set) var switchingAccount = false
    @Published var switchMessage: String?
    @Published var switchConfirmation: QuotaCard?
    private var process: Process?
    private var timer: Timer?
    private var activeLookupGeneration = 0
    private let cacheURL: URL
    private let resources: URL

    init() {
        resources = Bundle.main.resourceURL!
        cacheURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/QuotaBoard/snapshot.json")
        if let data = UserDefaults.standard.data(forKey: Self.importedKey),
           let accounts = try? JSONDecoder().decode([ImportAccount].self, from: data) {
            isConfigured = true
            imported = accounts.filter { QuotaProvider(rawValue: $0.provider) != nil }
            cards = imported.map(\.placeholder)
        }
        if let bytes = try? Data(contentsOf: cacheURL),
           let stored = try? JSONDecoder().decode([QuotaCard].self, from: bytes) {
            for card in stored {
                var cached = card
                cached.status = "cached"
                if let index = cards.firstIndex(where: { $0.id == card.id && $0.identityKey == card.identityKey }) {
                    cards[index] = cached
                }
            }
        }
    }

    func saveImports(_ accounts: [ImportAccount]) {
        guard let data = try? JSONEncoder().encode(accounts) else { return }
        let cache = (try? Data(contentsOf: cacheURL)).flatMap { try? JSONDecoder().decode([QuotaCard].self, from: $0) } ?? []
        let oldCards = cards + cache.map { card in
            var cached = card
            cached.status = "cached"
            return cached
        }
        isConfigured = true
        imported = accounts
        UserDefaults.standard.set(data, forKey: Self.importedKey)
        cards = accounts.map { account in
            guard var previous = oldCards.first(where: { $0.id == account.id && $0.identityKey == account.identityKey })
            else { return account.placeholder }
            if !account.email.isEmpty { previous.email = account.email }
            return previous
        }
        persist()
        if refreshing { refreshAfterChange = true }
        else if timer != nil { refresh() }
    }

    func setVisible(_ visible: Bool, provider: String) {
        if visible { hiddenProviders.remove(provider) } else { hiddenProviders.insert(provider) }
        UserDefaults.standard.set(hiddenProviders.sorted(), forKey: "HiddenQuotaProviders")
    }

    var visibleOverviewProviders: [QuotaProvider] {
        let importedProviders = Set(cards.map(\.provider))
        return QuotaProvider.allCases.filter {
            importedProviders.contains($0.rawValue) && !hiddenProviders.contains($0.rawValue)
        }
    }

    func overviewCard(for provider: String) -> QuotaCard? {
        let candidates = cards.filter { $0.provider == provider }
        return candidates.first { $0.id == activeAccounts[provider] } ?? candidates.first
    }

    func canSwitch(to card: QuotaCard) -> Bool {
        card.identityKey != nil && activeAccounts[card.provider] != card.id
    }

    func discover(_ providers: [QuotaProvider], completion: @escaping ([ImportAccount], String?) -> Void) {
        let script = resources.appendingPathComponent("worker.py").path
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            task.arguments = [script, "--discover"] + providers.map(\.rawValue)
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = FileHandle.nullDevice
            var result: DiscoveryResult?
            if (try? task.run()) != nil {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()
                result = try? JSONDecoder().decode(DiscoveryResult.self, from: data)
            }
            let accounts = result?.accounts ?? []
            let message = result == nil ? "账号扫描未完成，请重试。" : result?.message
            DispatchQueue.main.async { completion(accounts, message) }
        }
    }

    func startRefreshing() {
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    var readyCount: Int { cards.filter { $0.status == "ok" }.count }

    func displayName(for card: QuotaCard) -> String {
        aliases[aliasKey(card)] ?? card.emailPrefix ?? card.label
    }

    func saveName(_ name: String, for card: QuotaCard) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        aliases[aliasKey(card)] = name.isEmpty ? nil : String(name.prefix(60))
        UserDefaults.standard.set(aliases, forKey: "AccountAliases")
    }

    private func aliasKey(_ card: QuotaCard) -> String {
        card.id + (card.identityKey.map { ":" + $0 } ?? "")
    }

    @MainActor func beginLogin(_ provider: QuotaProvider, completion: @escaping (String?) -> Void) {
        if provider == .cursor {
            let profile = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            launchCursor(accountID: "cursor-profile-" + profile, completion: completion)
            return
        }
        let arguments = ["--login", provider.rawValue, UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()]
        let script = resources.appendingPathComponent("worker.py").path
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            task.arguments = [script] + arguments + ["--check"]
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = FileHandle.nullDevice
            var message: String?
            if (try? task.run()) != nil {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()
                if task.terminationStatus != 0 {
                    let output = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    message = output.isEmpty ? "无法启动登录组件。" : output
                }
            } else {
                message = "无法检查登录组件。"
            }
            let error = message
            DispatchQueue.main.async {
                if let error, !error.isEmpty { completion(error) }
                else {
                    Self.openTerminal(worker: script, arguments: arguments,
                                      title: "添加 \(provider.displayTitle) 账号", completion: completion)
                }
            }
        }
    }

    @MainActor private func launchCursor(accountID: String, completion: @escaping (String?) -> Void) {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.todesktop.230313mzl4w4u92") else {
            completion("未找到 Cursor。安装后再打开并登录。")
            return
        }
        if accountID == "cursor" {
            completion(NSWorkspace.shared.open(app) ? nil : "无法打开 Cursor。")
            return
        }
        let directory = cacheURL.deletingLastPathComponent().appendingPathComponent("Profiles/Cursor")
            .appendingPathComponent(String(accountID.dropFirst("cursor-profile-".count)))
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            completion("无法创建 Cursor 登录配置。")
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.arguments = ["--user-data-dir", directory.path]
        NSWorkspace.shared.openApplication(at: app, configuration: config) { _, error in
            DispatchQueue.main.async { completion(error == nil ? nil : "无法打开此 Cursor 账号。") }
        }
    }

    @MainActor private static func openTerminal(worker: String, arguments: [String], title: String, completion: @escaping (String?) -> Void) {
        guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else {
            completion("无法找到 macOS 终端。")
            return
        }
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let command = (["/usr/bin/python3", worker] + arguments)
            .map(quote).joined(separator: " ")
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("QuotaBoard-\(UUID().uuidString).command")
            let script = """
            #!/bin/sh
            /bin/rm -f -- \(quote(url.path))
            printf '%s\\n' \(quote(title))
            \(command)
            """
            try Data(script.utf8).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
            NSWorkspace.shared.open([url], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                DispatchQueue.main.async {
                    if error != nil { try? FileManager.default.removeItem(at: url) }
                    completion(error == nil ? nil : "无法打开终端，请重试。")
                }
            }
        } catch {
            completion("无法创建登录窗口，请重试。")
        }
    }

    @MainActor func switchLogin(_ card: QuotaCard) async {
        guard let provider = QuotaProvider(rawValue: card.provider), let identity = card.identityKey,
              !switchingAccount else { return }
        switchingAccount = true
        switchMessage = nil
        defer { switchingAccount = false }

        let codexApp = provider == .codex
            ? NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") : nil
        if provider == .codex {
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
            guard running.allSatisfy({ $0.terminate() }) else {
                switchMessage = "请退出 Codex 后再切换。"
                return
            }
            for _ in 0..<32 where running.contains(where: { !$0.isTerminated }) {
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard running.allSatisfy(\.isTerminated) else {
                switchMessage = "请退出 Codex 后再切换。"
                return
            }
        }

        let script = resources.appendingPathComponent("worker.py").path
        let result = await Task.detached(priority: .userInitiated) {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            task.arguments = [script, "--switch", card.id, identity]
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = FileHandle.nullDevice
            guard (try? task.run()) != nil else { return nil as SwitchResult? }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            return try? JSONDecoder().decode(SwitchResult.self, from: data)
        }.value
        if let codexApp { NSWorkspace.shared.open(codexApp) }
        guard let result, result.switched == true else {
            switchMessage = result?.message ?? "切换未完成，请重试。"
            return
        }

        if let previousID = result.previousID, let previousIdentity = result.previousIdentity,
           let index = imported.firstIndex(where: { $0.id == "codex-default" && $0.identityKey == previousIdentity }) {
            let old = imported[index]
            var updated = imported
            if updated.contains(where: { $0.id == previousID && $0.identityKey == previousIdentity }) {
                updated.remove(at: index)
            } else {
                updated[index] = ImportAccount(id: previousID, provider: old.provider, label: old.label,
                                               email: old.email, identityKey: old.identityKey)
            }
            if let name = aliases["codex-default:" + previousIdentity] {
                aliases[previousID + ":" + previousIdentity] = name
                UserDefaults.standard.set(aliases, forKey: "AccountAliases")
            }
            saveImports(updated)
        }
        if provider == .cursor {
            let error = await withCheckedContinuation { continuation in
                launchCursor(accountID: card.id) { continuation.resume(returning: $0) }
            }
            if let error {
                switchMessage = error
                return
            }
        }
        if result.launch == true {
            let error = await withCheckedContinuation { continuation in
                Self.openTerminal(worker: script, arguments: ["--launch", card.id], title: "打开 \(provider.displayTitle)") {
                    continuation.resume(returning: $0)
                }
            }
            if let error {
                switchMessage = error
                return
            }
        }
        activeAccounts[card.provider] = card.id
        if refreshing { refreshAfterChange = true } else { refresh() }
        switchMessage = "已切换到 \(displayName(for: card))"
        updateActiveAccounts()
    }

    func updateActiveAccounts() {
        activeLookupGeneration += 1
        let generation = activeLookupGeneration
        let worker = resources.appendingPathComponent("worker.py").path
        let providers = Set(imported.map(\.provider)).sorted()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let probe = Process()
            probe.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            probe.arguments = [worker, "--active"] + providers
            let output = Pipe()
            probe.standardOutput = output
            probe.standardError = FileHandle.nullDevice
            guard (try? probe.run()) != nil else { return }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            probe.waitUntilExit()
            guard probe.terminationStatus == 0,
                  let accounts = try? JSONDecoder().decode([String: String].self, from: data) else { return }
            DispatchQueue.main.async {
                guard let self, self.activeLookupGeneration == generation else { return }
                if self.activeAccounts != accounts { self.activeAccounts = accounts }
            }
        }
    }

    func refresh(account: String? = nil, interactive: Bool = false) {
        let requested = imported.filter { selection in
            account == nil || selection.id == account
        }
        guard !refreshing, !requested.isEmpty else { return }
        let selected = Dictionary(requested.map { ($0.id, $0.identityKey) }, uniquingKeysWith: { _, newest in newest })
        guard let selectedJSON = try? JSONEncoder().encode(selected) else { return }
        refreshing = true
        refreshingIDs = Set(requested.map(\.id))
        processMessage = nil
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        task.arguments = [resources.appendingPathComponent("worker.py").path,
                          "--selected", String(decoding: selectedJSON, as: UTF8.self)]
        if let account = account { task.arguments! += ["--account", account] }
        if interactive { task.arguments! += ["--interactive"] }
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        task.environment = environment
        let output = Pipe()
        task.standardOutput = output
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            process = task
        } catch {
            refreshing = false
            refreshingIDs = []
            processMessage = "读取组件未能启动，请重新打开额度看板。"
            return
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var pending = Data()
            while true {
                let chunk = output.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<newline])
                    pending.removeSubrange(...newline)
                    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    if let raw = object["card"],
                       let bytes = try? JSONSerialization.data(withJSONObject: raw),
                       let card = try? JSONDecoder().decode(QuotaCard.self, from: bytes) {
                        DispatchQueue.main.async {
                            guard self?.imported.contains(where: {
                                $0.id == card.id && $0.identityKey == selected[card.id]
                            }) == true else { return }
                            self?.accept(card)
                        }
                    }
                }
            }
            task.waitUntilExit()
            DispatchQueue.main.async {
                guard let self = self else { return }
                if !self.refreshingIDs.isEmpty {
                    self.processMessage = "部分账号读取未完成，可以再次刷新。"
                }
                self.refreshing = false
                self.refreshingIDs = []
                self.process = nil
                self.lastRefresh = Date()
                self.persist()
                self.updateActiveAccounts()
                if self.refreshAfterChange {
                    self.refreshAfterChange = false
                    self.refresh()
                }
            }
        }
    }

    private func accept(_ incoming: QuotaCard) {
        guard let index = cards.firstIndex(where: { $0.id == incoming.id }) else { return }
        var card = incoming
        let previous = cards[index]
        if card.errorCode == "account_changed" {
            card.email = previous.email
            card.identityKey = previous.identityKey
        }
        let sameIdentity = incoming.identityKey.map { $0 == previous.identityKey } ?? false
        if sameIdentity, card.emailPrefix == nil {
            card.email = previous.email
        }
        if incoming.status == "error", !previous.windows.isEmpty, sameIdentity {
            card.windows = previous.windows
            card.updatedAt = previous.updatedAt
            card.plan = previous.plan
            card.source = previous.source
            card.details = previous.details
            card.status = "stale"
        }
        cards[index] = card
        refreshingIDs.remove(card.id)
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(cards) else { return }
        do {
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try data.write(to: cacheURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cacheURL.path)
        } catch {
            processMessage = "无法保存上次读取结果，实时额度仍可查看。"
        }
    }

    func stop() { process?.terminate() }
}

func parseDate(_ value: String?) -> Date? {
    guard let value = value else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

func refreshDescription(_ value: String?, now: Date) -> String {
    guard let date = parseDate(value) else { return "重置时间未提供" }
    let seconds = Int(date.timeIntervalSince(now))
    if seconds <= 0 { return "已到重置时间，等待刷新" }
    let days = seconds / 86400
    let hours = seconds % 86400 / 3600
    let minutes = max(1, seconds % 3600 / 60)
    if days > 0 { return "\(days)天\(hours)小时后重置" }
    if hours > 0 { return "\(hours)小时\(minutes)分后重置" }
    return "\(minutes)分钟后重置"
}

enum QuotaProvider: String, CaseIterable, Identifiable {
    case codex = "Codex", kiro = "Kiro", cursor = "Cursor", claude = "Claude", copilot = "GitHub Copilot"

    var id: String { rawValue }
    var asset: String { self == .codex ? "openai" : self == .copilot ? "githubcopilot" : rawValue.lowercased() }
    var displayTitle: String { self == .copilot ? "Copilot" : rawValue }
    var installURL: URL {
        switch self {
        case .codex: return URL(string: "https://developers.openai.com/codex/cli/")!
        case .kiro: return URL(string: "https://kiro.dev/docs/cli/installation/")!
        case .cursor: return URL(string: "https://cursor.com/download")!
        case .claude: return URL(string: "https://code.claude.com/docs/en/setup")!
        case .copilot: return URL(string: "https://cli.github.com/")!
        }
    }

    var website: URL {
        switch self {
        case .codex: return URL(string: "https://openai.com/codex/")!
        case .kiro: return URL(string: "https://kiro.dev/")!
        case .cursor: return URL(string: "https://cursor.com/")!
        case .claude: return URL(string: "https://claude.ai/")!
        case .copilot: return URL(string: "https://github.com/features/copilot")!
        }
    }
    var accessibilityName: String { self == .codex ? "OpenAI Codex" : rawValue }
    var fallbackSymbol: String {
        switch self {
        case .codex: return "terminal"
        case .kiro: return "bolt"
        case .cursor: return "cursorarrow"
        case .claude: return "asterisk"
        case .copilot: return "chevron.left.forwardslash.chevron.right"
        }
    }

    func tint(for scheme: ColorScheme) -> Color {
        switch self {
        case .codex: return scheme == .dark ? .mint : Color(red: 0.06, green: 0.49, blue: 0.37)
        case .kiro: return scheme == .dark ? Color(red: 0.72, green: 0.60, blue: 1) : Color(red: 0.47, green: 0.30, blue: 0.80)
        case .cursor: return .primary
        case .claude: return Color(red: 0.83, green: 0.37, blue: 0.23)
        case .copilot: return scheme == .dark ? .cyan : .blue
        }
    }

    var loginInstructions: String {
        switch self {
        case .codex: return "通过 Codex CLI 登录 ChatGPT 账号。"
        case .kiro: return "通过 Kiro CLI 登录账号。"
        case .cursor: return "在单独的 Cursor 窗口登录新账号，原有账号可以继续使用。"
        case .claude: return "通过 Claude Code 登录 Claude 订阅账号。"
        case .copilot: return "使用 GitHub CLI 授权有 Copilot 权限的 GitHub 账号。"
        }
    }

    var switchInstructions: String {
        switch self {
        case .codex: return "Codex 会退出并重新打开。"
        case .kiro: return "将在终端打开此账号的 Kiro CLI 会话。"
        case .cursor: return "将打开此账号对应的 Cursor 窗口。"
        case .claude: return "将在终端打开此账号的 Claude Code 会话。"
        case .copilot: return "将此账号设为 GitHub CLI 的当前账号。"
        }
    }

    func shortestWindow(for card: QuotaCard?) -> QuotaWindow? {
        return card?.windows.min { left, right in
            left.durationForDisplay < right.durationForDisplay
        }
    }
}

struct BrandMark: View {
    let provider: QuotaProvider
    var size: CGFloat = 20
    private static let icons: [QuotaProvider: NSImage] = Dictionary(
        uniqueKeysWithValues: QuotaProvider.allCases.compactMap { provider in
            guard let url = Bundle.main.url(forResource: provider.asset, withExtension: "svg", subdirectory: "BrandIcons"),
                  let image = NSImage(contentsOf: url) else { return nil }
            image.isTemplate = true
            return (provider, image)
        }
    )

    var body: some View {
        Group {
            if let image = Self.icons[provider] {
                Image(nsImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: provider.fallbackSymbol).font(.system(size: size - 2, weight: .medium))
            }
        }.frame(width: size, height: size)
            .foregroundStyle(.primary)
            .accessibilityHidden(true)
    }
}

private struct QuotaRing: View {
    let remaining: Double?
    let tint: Color
    var size: CGFloat = 46
    var cached = false

    private var fraction: Double { min(1, max(0, (remaining ?? 0) / 100)) }
    private var indicator: Color {
        guard let remaining else { return .secondary }
        if remaining <= 5 { return .red }
        if remaining <= 20 { return .orange }
        return tint
    }

    static func percentage(_ remaining: Double?) -> String {
        guard let remaining else { return "–" }
        if remaining > 0 && remaining < 1 { return "<1%" }
        if remaining < 100 && remaining >= 99.5 { return ">99%" }
        return "\(Int(min(100, max(0, remaining)).rounded()))%"
    }

    var body: some View {
        let stroke = StrokeStyle(lineWidth: size >= 50 ? 4 : 3.5, lineCap: .round)
        ZStack {
            Circle().trim(from: 0, to: 0.75)
                .stroke(.primary.opacity(0.12), style: stroke)
                .rotationEffect(.degrees(135))
            if fraction > 0 {
                Circle().trim(from: 0, to: fraction * 0.75)
                    .stroke(indicator.opacity(cached ? 0.52 : 1), style: stroke)
                    .rotationEffect(.degrees(135))
            }
            Text(Self.percentage(remaining))
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .monospacedDigit().foregroundStyle(remaining == nil ? .secondary : .primary)
                .lineLimit(1).minimumScaleFactor(0.75)
                .frame(width: size - 9)
            if cached {
                Image(systemName: "clock").font(.system(size: 7, weight: .medium))
                    .foregroundStyle(.secondary).offset(y: size * 0.43)
            }
        }.frame(width: size, height: size)
    }
}

private struct ProviderRings: View {
    let provider: QuotaProvider
    let card: QuotaCard?
    let accountName: String?
    let ringSize: CGFloat
    let select: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovered = false

    private var summary: String {
        guard let card else { return "未识别当前账号" }
        let name = accountName ?? card.label
        guard let window = provider.shortestWindow(for: card) else { return "\(name)，暂无额度" }
        return "\(name)，\(window.englishTitle)，剩余 \(QuotaRing.percentage(window.remaining))"
    }

    var body: some View {
        Button(action: select) {
            VStack(spacing: 8) {
                HStack(spacing: 4) {
                    BrandMark(provider: provider, size: 15)
                    Text(provider.displayTitle).font(.system(size: 11, weight: .semibold))
                }
                Text(accountName ?? "待导入").font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                overviewRing(provider.shortestWindow(for: card))
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 8).padding(.vertical, 10)
            .background(.primary.opacity(hovered ? 0.065 : 0), in: RoundedRectangle(cornerRadius: 13))
            .contentShape(RoundedRectangle(cornerRadius: 13))
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .accessibilityLabel(provider.accessibilityName)
        .accessibilityValue(summary)
        .help(accountName.map { "\($0) · 查看所有账号" } ?? "未识别当前账号 · 查看所有账号")
    }

    private func overviewRing(_ window: QuotaWindow?) -> some View {
        let title = window?.englishTitle
        return VStack(spacing: 7) {
            QuotaRing(remaining: window?.remaining, tint: provider.tint(for: scheme),
                      size: ringSize, cached: window != nil && card?.status != "ok")
            Text(title ?? "暂无额度")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
                .frame(minWidth: ringSize + 4)
        }
    }
}

private struct AccountRings: View {
    let provider: QuotaProvider
    let card: QuotaCard
    let title: String
    let isActive: Bool
    let canSwitch: Bool
    let requestSwitch: () -> Void
    let reservesDetailLine: Bool
    let now: Date
    @Environment(\.colorScheme) private var scheme
    @State private var hovered = false

    private var accountTitle: some View {
        HStack(spacing: 5) {
            if isActive {
                Circle().fill(provider.tint(for: scheme)).frame(width: 4, height: 4)
                    .help("总览账号").accessibilityLabel("总览账号")
            }
            Text(title).font(.system(size: 11, weight: .semibold))
                .lineLimit(1).truncationMode(.middle)
        }.frame(height: 17)
    }

    var body: some View {
        VStack(spacing: 8) {
            VStack(spacing: 4) {
                accountTitle.help(canSwitch ? "\(title) · 双击切换账号" : title)
                Text(card.email).font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle).help(card.email)
                    .frame(height: 15)
                    .opacity(card.email == title ? 0 : 1)
                    .accessibilityHidden(card.email.isEmpty || card.email == title)
            }
            if card.windows.isEmpty {
                Text(card.errorCode == "keychain_required" ? "点刷新以授权读取" : card.message ?? "等待读取")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 60)
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(card.windows.count == 1 ? 132 : 67), spacing: 6),
                                        count: min(2, card.windows.count)), spacing: 12) {
                    ForEach(Array(card.windows.sorted { $0.durationForDisplay < $1.durationForDisplay }.enumerated()),
                            id: \.offset) { _, window in
                        metric(window)
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .top)
            .padding(.vertical, 6)
            .background(.primary.opacity(hovered && canSwitch ? 0.055 : 0),
                        in: RoundedRectangle(cornerRadius: 12))
            .background(AccountHitRegion(accountID: card.id).accessibilityHidden(true))
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture(count: 2).onEnded {
                if canSwitch { requestSwitch() }
            })
            .onHover { hovered = $0 }
    }

    private func metric(_ window: QuotaWindow) -> some View {
        let reset = refreshDescription(window.resetsAt, now: now)
        let resetShort = reset == "已到重置时间，等待刷新" ? "待重置" :
            window.resetsAt == nil ? "–" : reset.replacingOccurrences(of: "后重置", with: "")
        return VStack(spacing: 3) {
            QuotaRing(remaining: window.remaining, tint: provider.tint(for: scheme), size: 54,
                      cached: card.status != "ok")
            Text(window.englishTitle).font(.system(size: 11, weight: .medium))
                .lineLimit(1).minimumScaleFactor(0.8).frame(height: 15)
            if reservesDetailLine {
                Text(window.detail ?? "").font(.system(size: 11, weight: .medium))
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .frame(height: 15)
            }
            Text(window.resetsAt == nil ? "" : resetShort)
                .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                .frame(height: 15)
        }.accessibilityElement(children: .ignore)
            .accessibilityLabel("\(window.englishTitle)，剩余 \(QuotaRing.percentage(window.remaining))，\(window.detail.map { $0 + "，" } ?? "")\(reset)\(card.status == "ok" ? "" : "，上次结果")")
            .help("\(reset)\(card.status == "ok" ? "" : " · 上次结果")")
    }
}

struct RenameAccountView: View {
    let store: BoardStore
    let card: QuotaCard
    @State private var draft: String
    @FocusState private var focused: Bool

    init(store: BoardStore, card: QuotaCard) {
        self.store = store
        self.card = card
        _draft = State(initialValue: store.displayName(for: card))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("编辑账号").font(.headline)
            LabeledContent("登录邮箱", value: card.email.isEmpty ? "暂未读取" : card.email)
                .font(.subheadline)
                .textSelection(.enabled)
            TextField("显示名称", text: $draft).focused($focused).onSubmit(save)
            Text("留空恢复默认名称").font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("取消") { store.renamingAccount = nil }.keyboardShortcut(.cancelAction)
                Button("保存", action: save).keyboardShortcut(.defaultAction)
            }
        }.padding(16).frame(width: 252)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            .shadow(color: .black.opacity(0.2), radius: 12, y: 4)
            .onAppear { focused = true }
    }

    private func save() {
        store.saveName(draft, for: card)
        store.renamingAccount = nil
    }
}

private struct MenuBoardView: View {
    @ObservedObject var store: BoardStore
    let provider: QuotaProvider?
    let showSettings: (QuotaProvider?) -> Void
    let navigate: (QuotaProvider?) -> Void
    let requestSwitch: (QuotaCard) -> Void
    let confirmSwitch: (QuotaCard) -> Void

    private var lastUpdate: Date? { store.lastRefresh ?? store.cards.compactMap { parseDate($0.updatedAt) }.max() }
    private var allReady: Bool { store.readyCount == store.cards.count }
    private var status: String {
        if store.switchingAccount { return "正在切换账号…" }
        if let message = store.switchMessage { return message }
        if store.refreshing { return "正在更新" }
        if let message = store.processMessage { return message }
        return allReady ? "全部已更新" : "部分账号待更新"
    }

    var body: some View {
        VStack(spacing: 0) {
            if let provider {
                detail(provider)
            } else {
                overview
            }
            footer
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .disabled(store.switchConfirmation != nil)
            .accessibilityHidden(store.switchConfirmation != nil)
            .overlay {
                if let card = store.switchConfirmation {
                    Color.black.opacity(0.28).accessibilityHidden(true)
                    switchPrompt(card)
                } else if let card = store.renamingAccount {
                    Color.black.opacity(0.16)
                    RenameAccountView(store: store, card: card).id(card.id)
                }
            }
    }

    private var overview: some View {
        let providers = store.visibleOverviewProviders
        return VStack(spacing: 9) {
            HStack {
                Text("额度总览").fontWeight(.semibold)
                Spacer()
            }.padding(.horizontal, 3)
            if providers.isEmpty {
                Spacer()
                Button("在设置中选择显示的平台") { showSettings(nil) }
                Spacer()
            } else {
                HStack(spacing: 9) {
                    ForEach(Array(providers.enumerated()), id: \.element) { index, provider in
                        if index > 0 {
                            Divider().frame(height: 108)
                        }
                        let card = store.overviewCard(for: provider.rawValue)
                        ProviderRings(provider: provider, card: card,
                                      accountName: card.map(store.displayName(for:)), ringSize: 40) {
                            navigate(provider)
                        }
                    }
                }
                .frame(maxHeight: .infinity)
            }
            Divider()
        }
        .font(.system(size: 11)).padding(.horizontal, 18).padding(.top, 15)
    }

    private func switchPrompt(_ card: QuotaCard) -> some View {
        let name = store.displayName(for: card)
        let target = card.email.isEmpty || card.email == name ? name : "\(name)（\(card.email)）"
        return VStack(alignment: .leading, spacing: 10) {
            Text("切换 \(card.provider) 账号？")
                .font(.headline).accessibilityAddTraits(.isHeader)
            Text("将切换到 \(target)。")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if let provider = QuotaProvider(rawValue: card.provider) {
                Text(provider.switchInstructions)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("取消") { store.switchConfirmation = nil }
                    .keyboardShortcut(.cancelAction)
                Button("确认切换") { confirmSwitch(card) }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(maxWidth: 350)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding(12)
    }

    private func cards(for provider: QuotaProvider) -> [QuotaCard] {
        store.cards.filter { $0.provider == provider.rawValue }
    }

    private func detail(_ provider: QuotaProvider) -> some View {
        let accounts = cards(for: provider)
        let activeID = store.overviewCard(for: provider.rawValue)?.id
        let reservesDetailLine = accounts.contains { account in
            account.windows.contains { $0.detail?.isEmpty == false }
        }
        return VStack(spacing: 6) {
            ZStack {
                HStack(spacing: 6) {
                    BrandMark(provider: provider, size: 17)
                    Text(provider.rawValue).font(.system(size: 11, weight: .semibold))
                }
                HStack {
                    Button { navigate(nil) } label: {
                        Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                            .frame(width: 29, height: 27).contentShape(Rectangle())
                            .background(.primary.opacity(0.055), in: Circle())
                    }.buttonStyle(.plain)
                        .help("返回服务列表").accessibilityLabel("返回服务列表")
                    Spacer()
                    Button { showSettings(provider) } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 12))
                            .frame(width: 27, height: 27)
                            .background(.primary.opacity(0.055), in: Circle())
                    }.buttonStyle(.plain).help("设置").accessibilityLabel("设置")
                }
            }.padding(.horizontal, 12).padding(.top, 10)
            Divider().padding(.horizontal, 12)
            ScrollView {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    VStack(spacing: 18) {
                        ForEach(Array(stride(from: 0, to: accounts.count, by: 3)), id: \.self) { start in
                            HStack(alignment: .top, spacing: 7) {
                                ForEach(Array(accounts.dropFirst(start).prefix(3).enumerated()), id: \.element.id) { index, card in
                                    if index > 0 {
                                        Rectangle().fill(.primary.opacity(0.10)).frame(width: 1, height: 112)
                                    }
                                    AccountRings(provider: provider, card: card, title: store.displayName(for: card),
                                                 isActive: card.id == activeID,
                                                 canSwitch: store.canSwitch(to: card),
                                                 requestSwitch: { requestSwitch(card) },
                                                 reservesDetailLine: reservesDetailLine,
                                                 now: context.date)
                                        .background(card.id == activeID ? provider.tint(for: .light).opacity(0.08) : .clear,
                                                    in: RoundedRectangle(cornerRadius: 12))
                                }
                            }
                        }
                    }.padding(.horizontal, 10).padding(.vertical, 6)
                }
            }.id(provider)
        }
    }

    private var footer: some View {
        HStack(spacing: 5) {
            Circle().fill(allReady ? Color.green : Color.secondary.opacity(0.50)).frame(width: 4, height: 4)
            if let lastUpdate {
                Text(lastUpdate, style: .time).monospacedDigit()
            }
            if store.switchingAccount { Text("正在切换账号…") }
            else if let message = store.switchMessage ?? store.processMessage { Text(message).lineLimit(1).help(message) }
            else if !allReady && !store.refreshing { Text("待更新") }
            Spacer()
            if provider == nil {
                Button { showSettings(nil) } label: {
                    Image(systemName: "gearshape").font(.system(size: 12))
                        .frame(width: 26, height: 26)
                }.buttonStyle(.plain).help("设置").accessibilityLabel("设置")
            }
            Button(action: refresh) {
                Group {
                    if store.refreshing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .medium))
                    }
                }.frame(width: 26, height: 26).contentShape(Circle())
            }.buttonStyle(.plain).disabled(store.refreshing)
                .keyboardShortcut("r").help("刷新").accessibilityLabel("刷新")
        }.font(.system(size: 11)).foregroundStyle(.secondary)
            .padding(.horizontal, provider == nil ? 19 : 13).padding(.bottom, provider == nil ? 11 : 8)
            .help(status)
    }

    private func refresh() {
        store.updateActiveAccounts()
        if let provider, let card = cards(for: provider).first(where: { $0.errorCode == "keychain_required" }) {
            store.refresh(account: card.id, interactive: true)
        } else {
            store.refresh()
        }
    }
}

private struct AccountHitRegion: NSViewRepresentable {
    let accountID: String

    final class Region: NSView {
        var accountID = ""
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> Region { Region() }
    func updateNSView(_ view: Region, context: Context) { view.accountID = accountID }
}

private final class QuotaPanel: NSPanel {
    var dismiss: (() -> Void)?
    var detailMenu: ((String?) -> NSMenu?)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { dismiss?() }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .rightMouseDown, let detailMenu, let contentView,
           let menu = detailMenu(account(at: event.locationInWindow, in: contentView)) {
            NSMenu.popUpContextMenu(menu, with: event, for: contentView)
        } else {
            super.sendEvent(event)
        }
    }

    private func account(at point: NSPoint, in view: NSView) -> String? {
        if view.isHidden { return nil }
        if let region = view as? AccountHitRegion.Region,
           region.visibleRect.contains(region.convert(point, from: nil)) {
            return region.accountID
        }
        for child in view.subviews.reversed() {
            if let accountID = account(at: point, in: child) { return accountID }
        }
        return nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private var panel: QuotaPanel?
    private var setupWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var store: BoardStore!

    func applicationDidFinishLaunching(_ notification: Notification) {
        store = BoardStore()

        let image = NSImage(systemSymbolName: "chart.bar.fill", accessibilityDescription: "额度看板")
        image?.isTemplate = true
        let itemName = "QuotaBoardMain"
        let positionKey = "NSStatusItem Preferred Position \(itemName)"
        // AppKit otherwise appends new items at the left, which can fall behind
        // the camera housing. Seed a right-edge position once; autosave then
        // preserves any position the user chooses with Command-drag.
        if UserDefaults.standard.object(forKey: positionKey) == nil {
            UserDefaults.standard.set(0, forKey: positionKey)
        }
        statusItem = NSStatusBar.system.statusItem(withLength: 0)
        statusItem.autosaveName = itemName
        statusItem.length = NSStatusItem.squareLength
        statusItem.button?.image = image
        statusItem.button?.setAccessibilityLabel("额度看板")
        statusItem.button?.toolTip = "额度看板"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp])

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            if self.panel == nil && self.setupWindow == nil && self.settingsWindow == nil {
                self.openInitialView()
            }
        }
    }

    private func openInitialView() {
        if setupWindow != nil || !store.isConfigured {
            showSetup()
        } else if let settingsWindow {
            NSApp.activate(ignoringOtherApps: true)
            settingsWindow.makeKeyAndOrderFront(nil)
        } else {
            store.startRefreshing()
            showPanel()
        }
    }

    private func switchAccount(_ card: QuotaCard) {
        Task { @MainActor [weak self] in await self?.store.switchLogin(card) }
    }

    private func requestAccountSwitch(_ id: String, for provider: QuotaProvider) -> Bool {
        guard store.renamingAccount == nil, store.switchConfirmation == nil, !store.switchingAccount,
              let card = store.cards.first(where: { $0.id == id && $0.provider == provider.rawValue }),
              store.canSwitch(to: card) else { return false }
        store.switchConfirmation = card
        return true
    }

    private func showSetup(provider: QuotaProvider? = nil) {
        hidePanel()
        if let setupWindow {
            NSApp.activate(ignoringOtherApps: true)
            setupWindow.makeKeyAndOrderFront(nil)
            return
        }
        let setup = AccountSetupView(store: store, initialProvider: provider, firstRun: !store.isConfigured,
                                     cancel: { [weak self] in self?.setupWindow?.close() }) { [weak self] selected in
            guard let self else { return }
            self.store.saveImports(selected)
            self.setupWindow?.close()
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 556, height: 478),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "额度看板 · 导入账号"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = NSHostingView(rootView: setup)
        window.center()
        setupWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func showSettings(_ provider: QuotaProvider?) {
        hidePanel()
        if let settingsWindow {
            settingsWindow.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 432),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "额度看板 · 设置"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = NSHostingView(rootView: BoardSettingsView(
            store: store, provider: provider ?? .codex,
            addAccounts: { [weak self] in self?.showSetup(provider: $0) },
            switchAccount: { [weak self] in self?.switchAccount($0) }
        ))
        window.center()
        settingsWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func frame(for provider: QuotaProvider?) -> NSRect? {
        guard let button = statusItem?.button, let anchorWindow = button.window,
              let screen = anchorWindow.screen ?? NSScreen.main else { return nil }
        let visible = screen.visibleFrame.insetBy(dx: 8, dy: 5)
        let width: CGFloat
        if let provider { width = store.cards.filter { $0.provider == provider.rawValue }.count > 1 ? 510 : 300 }
        else {
            let count = store.visibleOverviewProviders.count
            width = count == 0 ? 248 : max(196, 36 + CGFloat(count) * 128)
        }
        let panelWidth = min(width, visible.width)
        let height: CGFloat
        if let provider {
            let accounts = store.cards.filter { $0.provider == provider.rawValue }
            let windows = accounts.map { $0.windows.count }.max() ?? 0
            let additionalRows = max(0, (windows - 1) / 2)
            let accountRows = max(0, (accounts.count - 1) / 3)
            height = 270 + CGFloat(additionalRows + accountRows) * 104 + CGFloat(accountRows) * 55
        } else {
            height = 215
        }
        let panelHeight = min(height, visible.height)
        let anchor = anchorWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let x = max(visible.minX, min(anchor.midX - panelWidth / 2, visible.maxX - panelWidth))
        let y = max(visible.minY, min(anchor.minY - 5, visible.maxY) - panelHeight)
        return NSRect(x: x, y: y, width: panelWidth, height: panelHeight)
    }

    private func presentPanel(for provider: QuotaProvider?) {
        guard let frame = frame(for: provider) else { return }
        let next = QuotaPanel(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        next.title = "额度看板"
        next.isOpaque = false
        next.backgroundColor = .clear
        next.hasShadow = false
        next.isFloatingPanel = true
        next.level = .popUpMenu
        next.hidesOnDeactivate = true
        next.isReleasedWhenClosed = false
        next.animationBehavior = .none
        next.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        next.delegate = self
        next.dismiss = { [weak self] in
            guard let self else { return }
            if self.store.switchConfirmation != nil { self.store.switchConfirmation = nil }
            else if self.store.renamingAccount != nil { self.store.renamingAccount = nil }
            else { self.hidePanel() }
        }
        if let provider {
            next.detailMenu = { [weak self] accountID in
                guard let self, self.store.renamingAccount == nil, self.store.switchConfirmation == nil else { return nil }
                return self.detailMenu(for: provider, accountID: accountID)
            }
        }

        let bounds = NSRect(origin: .zero, size: frame.size)
        let backdrop = NSGlassEffectView(frame: bounds)
        backdrop.style = .regular
        backdrop.cornerRadius = 22
        let host = NSHostingView(rootView: MenuBoardView(
            store: store,
            provider: provider,
            showSettings: { [weak self] in self?.showSettings($0) },
            navigate: { [weak self] page in self?.navigate(to: page) },
            requestSwitch: { [weak self] card in
                guard let provider else { return }
                _ = self?.requestAccountSwitch(card.id, for: provider)
            },
            confirmSwitch: { [weak self] card in
                self?.store.switchConfirmation = nil
                self?.switchAccount(card)
            }
        ))
        host.sizingOptions = []
        host.frame = bounds
        host.autoresizingMask = [.width, .height]
        backdrop.contentView = host
        next.contentView = backdrop
        backdrop.layoutSubtreeIfNeeded()

        // Swapping complete windows avoids reusing a backdrop while its geometry is changing.
        hidePanel()
        panel = next
        NSApp.activate(ignoringOtherApps: true)
        next.makeKeyAndOrderFront(nil)
    }

    private func detailMenu(for provider: QuotaProvider, accountID: String?) -> NSMenu {
        let menu = NSMenu()
        let accounts = store.cards.filter { $0.provider == provider.rawValue }
        let clicked = accounts.first { $0.id == accountID } ?? (accounts.count == 1 ? accounts.first : nil)
        let linkAccount = clicked ?? accounts.first { $0.id == store.activeAccounts[provider.rawValue] } ?? accounts.first
        func makeItem(_ title: String, action: Selector, value: Any, symbol: String? = nil) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            item.representedObject = value
            if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
            return item
        }
        if let clicked {
            if store.canSwitch(to: clicked) {
                menu.addItem(makeItem("切换到此账号…", action: #selector(confirmDetailAccountSwitch(_:)),
                                      value: clicked.id, symbol: "arrow.left.arrow.right"))
            }
            menu.addItem(makeItem("修改显示名称…", action: #selector(renameDetailAccount(_:)),
                                  value: clicked.id, symbol: "pencil"))
        } else if !accounts.isEmpty {
            let rename = NSMenuItem(title: "修改显示名称", action: nil, keyEquivalent: "")
            rename.image = NSImage(systemSymbolName: "pencil", accessibilityDescription: nil)
            let names = NSMenu()
            for card in accounts {
                names.addItem(makeItem(store.displayName(for: card), action: #selector(renameDetailAccount(_:)),
                                       value: card.id))
            }
            rename.submenu = names
            menu.addItem(rename)
        }
        if let card = linkAccount, let usage = URL(string: card.url) {
            menu.addItem(makeItem("查看官方用量", action: #selector(openDetailLink(_:)),
                                  value: usage, symbol: "chart.bar"))
        }
        menu.addItem(makeItem("打开服务官网", action: #selector(openDetailLink(_:)),
                              value: provider.website, symbol: "arrow.up.right"))
        return menu
    }

    private func account(from item: NSMenuItem) -> QuotaCard? {
        guard let id = item.representedObject as? String else { return nil }
        return store.cards.first { $0.id == id }
    }

    @objc private func renameDetailAccount(_ item: NSMenuItem) {
        store.renamingAccount = account(from: item)
    }

    @objc private func confirmDetailAccountSwitch(_ item: NSMenuItem) {
        guard let card = account(from: item), let provider = QuotaProvider(rawValue: card.provider) else { return }
        _ = requestAccountSwitch(card.id, for: provider)
    }

    @objc private func openDetailLink(_ item: NSMenuItem) {
        if let url = item.representedObject as? URL { NSWorkspace.shared.open(url) }
    }

    private func navigate(to provider: QuotaProvider?) {
        guard let source = panel else { return }
        DispatchQueue.main.async { [weak self, weak source] in
            guard let self, let source, self.panel === source, source.isVisible else { return }
            self.presentPanel(for: provider)
        }
    }

    private func showPanel() {
        store.updateActiveAccounts()
        if let panel, panel.isVisible {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        } else {
            presentPanel(for: nil)
        }
    }

    private func hidePanel() {
        guard let panel else { return }
        self.panel = nil
        store.renamingAccount = nil
        store.switchConfirmation = nil
        panel.delegate = nil
        panel.orderOut(nil)
        panel.close()
    }

    @objc private func statusClicked() {
        if panel?.isVisible == true { hidePanel() } else { openInitialView() }
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if window === setupWindow {
            setupWindow = nil
            if store.isConfigured { DispatchQueue.main.async { [weak self] in self?.openInitialView() } }
        } else if window === settingsWindow {
            settingsWindow = nil
            DispatchQueue.main.async { [weak self] in self?.openInitialView() }
        }
    }

    func windowDidResignKey(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window === panel { hidePanel() }
    }
    func applicationDidChangeScreenParameters(_ notification: Notification) { hidePanel() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openInitialView()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) { store.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
enum QuotaBoardMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
