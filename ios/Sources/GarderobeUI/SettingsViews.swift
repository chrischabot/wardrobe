#if os(iOS)
import SwiftUI
import GarderobeKit

/// Settings behind the account control.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var deliveryTime = Date()
    @State private var optionCount = 5
    @State private var message: String?
    @State private var signedIn = false
    @State private var accountMessage: String?
    @State private var showAccountRequest = false
    @State private var confirmNewCode = false
    let account: AccountActions?

    var body: some View {
        let s = app.settings
        NavigationStack {
            List {
                if app.isDemo { Section { DemoBadge() } footer: { Text("This copy of the app runs on bundled demo data built from your real profile and May 2026 inventory.") } }
                Section {
                    NavigationLink { MyStyleView() } label: {
                        VStack(alignment: .leading) {
                            Text("My style")
                            if let line = app.myStyle.versionLine { Text(line).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .accessibilityIdentifier("settings.myStyle")
                }
                Section("Connected assistants") {
                    if s.assistants.isEmpty { Text("Claude and ChatGPT can reach the same assistant once you grant them access.").foregroundStyle(.secondary) }
                    ForEach(s.assistants) { g in AssistantGrantRow(grant: g) }
                }
                Section("Connections") {
                    ForEach(s.services) { c in ConnectionRow(connection: c) }
                }
                Section("Morning delivery") {
                    DatePicker("Board ready by", selection: $deliveryTime, displayedComponents: .hourAndMinute)
                    Stepper("\(optionCount) outfits", value: $optionCount, in: 3...5)
                    Button("Save delivery settings") {
                        Task {
                            let f = DateFormatter(); f.dateFormat = "HH:mm"; f.timeZone = app.env.timeZone
                            switch await s.updateDelivery(time: f.string(from: deliveryTime), optionCount: optionCount) {
                            case .done: message = "Saved."
                            case .queued: message = "Saved on this phone; it will send when online."
                            case .refused(let why): message = why
                            case .needsFootwear: break
                            }
                        }
                    }
                    if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
                    if let calendar = s.calendarId {
                        LabeledContent("Calendar event", value: calendar)
                        Button("Stop publishing to the calendar", role: .destructive) {
                            Task {
                                switch await s.updateDelivery(time: nil, optionCount: nil, calendar: .clear) {
                                case .done: message = "The morning board will no longer be added to your calendar."
                                case .queued: message = "Saved on this phone; it will send when online."
                                case .refused(let why): message = why
                                case .needsFootwear: break
                                }
                            }
                        }
                        .minimumTarget()
                    }
                    if let settings = s.settings { LabeledContent("Location", value: settings.homeLocationLabel); LabeledContent("Time zone", value: settings.timezone) }
                }
                Section {
                    NavigationLink("Receipts") { ReceiptsListView() }
                }
                Section {
                    if let line = s.recoveryLine {
                        Label(line, systemImage: s.recovery?.hasActiveKit == true ? "key" : "key.slash").accessibilityIdentifier("settings.recovery")
                    }
                    ForEach(s.recoveryNotes, id: \.self) { Text(verbatim: $0).font(.caption).foregroundStyle(.secondary) }
                    if let code = s.newRecoveryCode {
                        Text(verbatim: code.credential).font(.title3.monospaced()).textSelection(.enabled).privacySensitive()
                            .accessibilityLabel("New recovery code").accessibilityIdentifier("settings.newRecoveryCode")
                        Text(verbatim: code.instructions).font(.caption).foregroundStyle(.secondary)
                        Button("I've saved it") { s.forgetNewRecoveryCode() }.minimumTarget()
                    } else {
                        Button { confirmNewCode = true } label: { Label("Create a new recovery code", systemImage: "key.badge.plus").minimumTarget() }
                            .disabled(s.isCreatingRecoveryCode).accessibilityIdentifier("settings.createRecoveryCode")
                    }
                    if let error = s.accountError { Text(verbatim: error).font(.caption).foregroundStyle(.secondary) }
                    Button { app.accountRequest.reset(); showAccountRequest = true } label: { Label("Confirm an assistant's request", systemImage: "checkmark.shield").minimumTarget() }
                        .accessibilityIdentifier("settings.confirmRequest")
                    if !s.transferRows.isEmpty {
                        DisclosureGroup("Recent exports, imports and recovery codes") {
                            ForEach(s.transferRows) { row in
                                VStack(alignment: .leading, spacing: Spacing.xs) {
                                    Label(row.title, systemImage: row.systemImage)
                                    Text(verbatim: row.detail).font(.caption).foregroundStyle(.secondary)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                        .accessibilityIdentifier("settings.transfers")
                    }
                } header: { Text("Recovery and transfers") } footer: { Text("Garderobe never shows a recovery code here; only whether one exists and when it was issued.") }
                if let account {
                    Section("Account") {
                        LabeledContent("Server", value: account.serverLabel)
                        if let who = s.session?.displayName, signedIn { LabeledContent("Signed in as", value: who) }
                        if signedIn {
                            Button("Sign out", role: .destructive) { Task { await account.signOut(); signedIn = account.isSignedIn() } }
                                .accessibilityIdentifier("account.signOut")
                        } else {
                            Button("Sign in with Google") {
                                Task {
                                    accountMessage = await account.signIn()
                                    signedIn = account.isSignedIn()
                                    if signedIn { await s.refresh() }
                                }
                            }
                            .accessibilityIdentifier("account.signIn")
                        }
                        if let accountMessage { Text(accountMessage).font(.caption).foregroundStyle(.orange) }
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await s.refresh() }
            .sheet(isPresented: $showAccountRequest, onDismiss: { Task { await app.settings.refreshAccount() } }) { AccountRequestView() }
            .confirmationDialog("Create a new recovery code?", isPresented: $confirmNewCode, titleVisibility: .visible) {
                Button("Create and replace the current code") { Task { await app.settings.createRecoveryCode() } }
            } message: { Text("The new code is shown once and the current one stops working. Do this if a code was pasted into a chat.") }
            .onDisappear { app.settings.forgetNewRecoveryCode() }
            .task {
                signedIn = account?.isSignedIn() ?? false
                await s.refresh()
                optionCount = s.optionCount
                let parts = s.deliveryTime.split(separator: ":").compactMap { Int($0) }
                if parts.count == 2 { deliveryTime = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()) ?? Date() }
                if app.myStyle.document == nil { await app.myStyle.load() }
            }
        }
    }
}

/// Sign-in hooks supplied by the app target (native PKCE sign-in, Keychain, server-side revoke).
public struct AccountActions {
    public var serverLabel: String
    public var isSignedIn: () -> Bool
    /// Returns nil on success (or when the owner cancelled), otherwise a sentence to show.
    public var signIn: () async -> String?
    public var signOut: () async -> Void
    public init(serverLabel: String, isSignedIn: @escaping () -> Bool, signIn: @escaping () async -> String?, signOut: @escaping () async -> Void) {
        self.serverLabel = serverLabel; self.isSignedIn = isSignedIn; self.signIn = signIn; self.signOut = signOut
    }
}

/// Last successful operation and a reconnect action; a missing permission names the capability.
struct ConnectionRow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let connection: Connection
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text(verbatim: connection.displayName).font(.body)
                Spacer()
                Text(connection.isHealthy ? "Connected" : connection.status == "disconnected" ? "Off" : "Needs attention")
                    .font(.caption).foregroundStyle(connection.isHealthy ? Color.secondary : Color.orange)
            }
            Text(app.settings.summary(connection)).font(.caption).foregroundStyle(.secondary)
            if let endpoint = connection.endpoint {
                Text(verbatim: [endpoint, connection.protocolVersion.map { "MCP \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            HStack {
                if let url = app.settings.reconnectURL(connection), !connection.isHealthy {
                    Button(connection.status == "disconnected" ? "Connect" : "Reconnect") { openURL(url) }.buttonStyle(.bordered).minimumTarget()
                }
                if connection.isHealthy {
                    Button("Disconnect", role: .destructive) { Task { await app.settings.disconnect(connection) } }
                        .buttonStyle(.borderless).minimumTarget().disabled(app.settings.busyConnectionId == connection.connectionId)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connection.\(connection.kind).\(connection.client ?? "")")
    }
}

/// A consumer assistant's MCP grant: who holds it, what it can do, when it was last used; revocation is immediate.
struct AssistantGrantRow: View {
    @Environment(AppModel.self) private var app
    let grant: AssistantGrant
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text(verbatim: grant.displayName).font(.body)
                Spacer()
                Text(grant.isActive ? "Connected" : "Revoked").font(.caption).foregroundStyle(.secondary)
            }
            Text(app.settings.summary(grant)).font(.caption).foregroundStyle(.secondary)
            Text(verbatim: "Tokens go to \(grant.redirectHost)").font(.caption2).foregroundStyle(.secondary)
            if grant.isActive {
                Button("Disconnect \(grant.displayName)", role: .destructive) { Task { await app.settings.disconnect(grant) } }
                    .buttonStyle(.borderless).minimumTarget().disabled(app.settings.busyConnectionId == grant.grantId)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.\(grant.client)")
    }
}

/// Settings > My style: the full profile text as supplied, its version, and verbatim editing.
struct MyStyleView: View {
    @Environment(AppModel.self) private var app
    @State private var showDiscard = false

    var body: some View {
        let m = app.myStyle
        Group {
            if m.isEditing { editor } else { reader }
        }
        .navigationTitle("My style")
        .navigationBarTitleDisplayMode(.inline)
        .task { if m.document == nil { await m.load() } }
    }

    private var reader: some View {
        let m = app.myStyle
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.l) {
                    if let d = m.document {
                        VStack(alignment: .leading, spacing: Spacing.xs) {
                            if let line = m.versionLine { Text(line).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("myStyle.version") }
                            if let rules = m.ruleLine { Text(rules).font(.caption).foregroundStyle(.secondary) }
                            if m.isVerbatim == true { Label("Shown exactly as stored (SHA-256 \(d.contentSha256.prefix(8))…)", systemImage: "checkmark.shield").font(.caption).foregroundStyle(.secondary) }
                            if m.isVerbatim == false { Label("This text does not match its recorded hash", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
                        }
                        DisclosureGroup("Sections") {
                            ForEach(m.sections) { s in Button(s.title) { proxy.scrollTo(s.id, anchor: .top) }.minimumTarget() }
                        }
                        ForEach(m.sections) { s in
                            VStack(alignment: .leading, spacing: Spacing.s) {
                                if s.title != "Introduction" { Text(verbatim: s.title).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader) }
                                Text(markdown(s.body)).textSelection(.enabled)
                            }
                            .id(s.id)
                        }
                    } else if m.isLoading {
                        ProgressView()
                    } else {
                        ContentUnavailableView("Profile not loaded", systemImage: "text.book.closed", description: Text("Connect to load My style."))
                    }
                }
                .padding(Spacing.l)
            }
            .toolbar { ToolbarItem(placement: .primaryAction) { Button("Edit") { m.beginEditing() }.disabled(m.document == nil).accessibilityIdentifier("myStyle.edit") } }
        }
    }

    private var editor: some View {
        @Bindable var m = app.myStyle
        return VStack(alignment: .leading, spacing: Spacing.s) {
            if case .conflict(let why) = m.saveState { Text(why).font(.callout).foregroundStyle(.orange).padding(.horizontal) }
            if case .failed(let why) = m.saveState { Text(why).font(.callout).foregroundStyle(.orange).padding(.horizontal) }
            if m.saveState == .queued { Text("Saved on this phone; it will send when online.").font(.callout).padding(.horizontal) }
            TextEditor(text: $m.draft)
                .font(.body.monospaced())
                .padding(.horizontal, Spacing.s)
                .accessibilityLabel("Profile text")
                .accessibilityIdentifier("myStyle.editor")
            TextField("What changed (optional, kept with this version)", text: $m.amendment)
                .textFieldStyle(.roundedBorder).padding(.horizontal)
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if m.hasUnsavedChanges { showDiscard = true } else { m.cancelEditing() } } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await m.save() } }.disabled(!m.hasUnsavedChanges || m.saveState == .saving).accessibilityIdentifier("myStyle.save")
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $showDiscard) { Button("Discard", role: .destructive) { m.cancelEditing() } }
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}
#endif
