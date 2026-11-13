import AppKit
import SwiftUI

struct AccountSetupView: View {
    @ObservedObject var store: BoardStore
    let initialProvider: QuotaProvider?
    let firstRun: Bool
    let cancel: () -> Void
    let finish: ([ImportAccount]) -> Void

    @State private var step = 1
    @State private var services: Set<QuotaProvider> = []
    @State private var candidates: [ImportAccount] = []
    @State private var checked: Set<String> = []
    @State private var scanning: String?
    @State private var message: String?
    @State private var showingEmptyConfirmation = false

    private var selectedServices: [QuotaProvider] { QuotaProvider.allCases.filter(services.contains) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("第 \(step) 步，共 3 步").font(.subheadline).foregroundStyle(.secondary)
            Text(["选择服务", "选择要导入的账号", "确认导入"][step - 1]).font(.title2.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Group {
                switch step {
                case 1: servicePicker
                case 2: accountPicker
                default: confirmation
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            Divider()
            HStack {
                if firstRun {
                    Button("暂不导入") { showingEmptyConfirmation = true }
                } else {
                    Button("取消", action: cancel).keyboardShortcut(.cancelAction)
                }
                Spacer()
                if step > 1 {
                    Button("上一步") { step -= 1 }.disabled(scanning != nil)
                }
                Button(step == 3 ? (firstRun ? "导入并打开总览" : "保存账号") : "下一步", action: advance)
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(scanning != nil || (step == 1 && services.isEmpty) || (step == 2 && firstRun && finalSelection.isEmpty))
            }.disabled(scanning != nil)
        }
        .padding(24)
        .frame(width: 556, height: 478)
        .onAppear {
            services = initialProvider.map { [$0] } ?? Set(QuotaProvider.allCases)
            candidates = store.imported
            checked = Set(store.imported.map(\.selectionKey))
        }
        .confirmationDialog("暂不导入账号？", isPresented: $showingEmptyConfirmation) {
            Button("打开空总览") { finish([]) }
            Button("继续配置", role: .cancel) {}
        } message: {
            Text("之后可以从设置导入账号。")
        }
    }

    private var servicePicker: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text("勾选要在额度看板中管理的服务。").foregroundStyle(.secondary)
            ForEach(QuotaProvider.allCases, id: \.self) { provider in
                Toggle(isOn: Binding(
                    get: { services.contains(provider) },
                    set: { if $0 { services.insert(provider) } else { services.remove(provider) } }
                )) {
                    HStack(spacing: 8) {
                        BrandMark(provider: provider, size: 16)
                        Text(provider.rawValue)
                    }
                }.toggleStyle(.checkbox)
            }
        }
    }

    private var accountPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("只有勾选的账号会加入看板。").foregroundStyle(.secondary)
                Spacer()
                if scanning != nil { ProgressView().controlSize(.small) }
                Button("重新扫描") { scan("local") }.disabled(scanning != nil)
            }
            if let message {
                Text(message).foregroundStyle(.secondary).font(.callout)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(selectedServices, id: \.self) { provider in
                        let rows = candidates.filter { $0.provider == provider.rawValue }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                BrandMark(provider: provider, size: 15)
                                Text(provider.rawValue).fontWeight(.semibold)
                                Spacer()
                                if provider == .gemini {
                                    Button("查找 Gemini 账号") { scan("gemini") }.disabled(scanning != nil)
                                }
                            }
                            if rows.isEmpty {
                                Text(provider.loginInstructions).font(.callout).foregroundStyle(.secondary)
                                Link("打开 \(provider.rawValue)", destination: provider.website).font(.callout)
                            }
                            ForEach(rows, id: \.selectionKey) { account in
                                Toggle(account.email.isEmpty ? account.label : account.email, isOn: Binding(
                                    get: { checked.contains(account.selectionKey) },
                                    set: { if $0 { checked.insert(account.selectionKey) } else { checked.remove(account.selectionKey) } }
                                )).toggleStyle(.checkbox)
                            }
                        }
                        Divider()
                    }
                }.padding(.trailing, 8)
            }
        }
    }

    private var confirmation: some View {
        let accounts = finalSelection
        return VStack(alignment: .leading, spacing: 9) {
            Text(accounts.isEmpty ? "保存后，总览将为空。" : "将读取以下 \(accounts.count) 个账号的额度。")
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(accounts, id: \.selectionKey) { account in
                        HStack(spacing: 8) {
                            if let provider = QuotaProvider(rawValue: account.provider) {
                                BrandMark(provider: provider, size: 15)
                            }
                            Text(account.provider).fontWeight(.medium)
                            Text(account.email.isEmpty ? account.label : account.email).foregroundStyle(.secondary)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var finalSelection: [ImportAccount] {
        candidates.filter { account in
            guard let provider = QuotaProvider(rawValue: account.provider) else { return false }
            if services.contains(provider) { return checked.contains(account.selectionKey) }
            return !firstRun && store.imported.contains { $0.selectionKey == account.selectionKey }
        }
    }

    private func advance() {
        switch step {
        case 1:
            step = 2
            scan("local")
        case 2:
            step = 3
        default:
            finish(finalSelection)
        }
    }

    private func scan(_ source: String) {
        guard scanning == nil else { return }
        scanning = source
        message = nil
        store.discover(source) { found, error in
            if error == nil {
                let provider = source == "gemini" ? "Gemini" : nil
                let retained = candidates.filter {
                    (provider == nil ? $0.provider == "Gemini" : $0.provider != provider)
                }
                let old = store.imported.filter { imported in
                    !found.contains { $0.selectionKey == imported.selectionKey || $0.id == imported.id } &&
                    !retained.contains { $0.selectionKey == imported.selectionKey }
                }
                candidates = (found + retained + old).map { account in
                    guard account.email.isEmpty,
                          let saved = store.cards.first(where: { $0.identityKey == account.identityKey }),
                          !saved.email.isEmpty else { return account }
                    return ImportAccount(id: account.id, provider: account.provider, label: account.label,
                                         email: saved.email, identityKey: account.identityKey,
                                         geminiRoute: account.geminiRoute)
                }
                if found.isEmpty && source == "gemini" { message = "没有找到可导入的 Gemini 账号。" }
            } else {
                message = error
            }
            scanning = nil
        }
    }
}

struct BoardSettingsView: View {
    @ObservedObject var store: BoardStore
    @State var provider: QuotaProvider
    @State private var editing: QuotaCard?
    let addAccounts: (QuotaProvider) -> Void
    let switchGemini: (QuotaCard) -> Void

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text("平台").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 9).padding(.bottom, 6)
                ForEach(QuotaProvider.allCases, id: \.self) { item in
                    Button { provider = item } label: {
                        HStack(spacing: 8) {
                            BrandMark(provider: item, size: 15)
                            Text(item.rawValue)
                            Spacer()
                        }
                        .padding(.horizontal, 9).frame(height: 31)
                        .background(provider == item ? Color.accentColor.opacity(0.14) : .clear,
                                    in: RoundedRectangle(cornerRadius: 7))
                        .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(11).frame(width: 164)
            .background(.regularMaterial)

            VStack(alignment: .leading, spacing: 13) {
                Text(provider.rawValue).font(.title2.weight(.semibold))
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("在总览中显示").fontWeight(.medium)
                        Text("显示所选账号的最短周期额度").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Toggle("在总览中显示", isOn: Binding(
                        get: { !store.hiddenProviders.contains(provider.rawValue) },
                        set: { store.setVisible($0, provider: provider.rawValue) }
                    )).labelsHidden().toggleStyle(.switch).controlSize(.mini)
                }
                .padding(11).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 9))
                HStack {
                    Text("登录账号").fontWeight(.semibold)
                    Spacer()
                    if store.preferredAccounts[provider.rawValue] != nil {
                        Button("跟随当前登录") { store.followLogin(for: provider.rawValue) }.controlSize(.small)
                    }
                    Button("添加账号") { addAccounts(provider) }.controlSize(.small)
                }
                let accounts = store.cards.filter { $0.provider == provider.rawValue }
                if accounts.isEmpty {
                    Text("还没有导入账号。").foregroundStyle(.secondary)
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(accounts) { account in
                                accountRow(account)
                                if account.id != accounts.last?.id { Divider().padding(.leading, 42) }
                            }
                        }
                        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 9))
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(20)
        }
        .frame(width: 700, height: 432)
        .sheet(item: $editing) { account in
            EditSettingsAccount(store: store, account: account)
        }
    }

    private func accountRow(_ account: QuotaCard) -> some View {
        let overview = store.overviewCard(for: account.provider)?.id == account.id
        let signedIn = store.activeAccounts[account.provider] == account.id
        return HStack(spacing: 10) {
            BrandMark(provider: provider, size: 19).frame(width: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(store.displayName(for: account)).fontWeight(.medium)
                Text(account.email.isEmpty ? "暂未读取邮箱" : account.email)
                    .font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled)
                if overview || signedIn {
                    Text([signedIn ? "当前登录" : nil, overview ? "总览账号" : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if account.errorCode == "keychain_required", provider == .cursor || provider == .gemini {
                Button("授权读取") { store.refresh(account: provider == .gemini ? "gemini" : account.id, interactive: true) }
                    .controlSize(.small).disabled(store.refreshing)
            }
            if !overview {
                Button("用于总览") { store.selectOverviewAccount(account) }.controlSize(.small)
            }
            if provider == .gemini, account.geminiRoute != nil, !signedIn {
                Button("切换登录") { switchGemini(account) }.controlSize(.small)
            }
            Button { editing = account } label: { Image(systemName: "pencil").frame(width: 24, height: 24) }
                .buttonStyle(.plain).help("编辑账号").accessibilityLabel("编辑 \(store.displayName(for: account))")
        }.padding(.horizontal, 10).padding(.vertical, 8)
    }
}

private struct EditSettingsAccount: View {
    let store: BoardStore
    let account: QuotaCard
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("编辑账号").font(.headline)
            LabeledContent("登录邮箱", value: account.email.isEmpty ? "暂未读取" : account.email)
                .textSelection(.enabled)
            TextField("显示名称", text: $name).focused($focused)
            Text("留空恢复默认名称。").font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    store.saveName(name, for: account)
                    dismiss()
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 396)
            .onAppear { name = store.displayName(for: account); focused = true }
    }
}
