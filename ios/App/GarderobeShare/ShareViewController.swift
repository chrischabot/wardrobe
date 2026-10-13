import UIKit
import SwiftUI
import Observation
import UniformTypeIdentifiers
import GarderobeKit

/// What the share sheet shows.
@MainActor
@Observable
final class ShareState {
    var url: String?
    var pageTitle: String?
    var note = ""
    var isReading = true
    var isSending = false
    var outcome: ShareOutcome?
}

/// The Safari share extension. Sharing a product page starts the same product investigation
/// as pasting its address into Conversation: one conversation turn, never a command.
final class ShareViewController: UIViewController {
    private let state = ShareState()
    /// The turn's identity, created once: storing or sending again can never add a second turn.
    private let turnId = "turn-" + UUID().uuidString.lowercased()

    override func viewDidLoad() {
        super.viewDidLoad()
        let root = ShareView(state: state,
                             send: { [weak self] in self?.send() },
                             cancel: { [weak self] in self?.cancel() },
                             finish: { [weak self] in self?.finish() })
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
        Task { await readSharedItem() }
    }

    /// Finds the shared web address, and the page title when the host app supplied one.
    private func readSharedItem() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            let itemTitle = item.attributedContentText?.string ?? item.attributedTitle?.string
            for provider in item.attachments ?? [] {
                var found: (url: String, title: String?)?
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = await Self.loadURL(from: provider) { found = (url, nil) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
                    found = await Self.loadPage(from: provider)
                }
                guard let found else { continue }
                let title = (found.title ?? itemTitle)?.trimmingCharacters(in: .whitespacesAndNewlines)
                state.url = found.url
                state.pageTitle = title?.isEmpty == false ? title : nil
                state.isReading = false
                return
            }
        }
        state.isReading = false
        state.outcome = .notAWebLink
    }

    private static func loadURL(from provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url.absoluteString)
                } else {
                    continuation.resume(returning: item as? String)
                }
            }
        }
    }

    /// Safari's property-list item: the results of the page's preprocessing script.
    private static func loadPage(from provider: NSItemProvider) async -> (url: String, title: String?)? {
        await withCheckedContinuation { (continuation: CheckedContinuation<(url: String, title: String?)?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { item, _ in
                let dictionary = (item as? NSDictionary) as? [String: Any]
                let results = dictionary?[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]
                let url = (results?["URL"] ?? results?["url"]) as? String
                let title = results?["title"] as? String
                continuation.resume(returning: url.map { ($0, title) })
            }
        }
    }

    private func send() {
        guard let url = state.url, !state.isSending, state.outcome == nil else { return }
        state.isSending = true
        let pageTitle = state.pageTitle
        let note = state.note
        let turnId = self.turnId
        Task {
            // Stored in the shared inbox first, then sent if that is possible now.
            let outcome = await ShareDelivery.deliver(url: url, pageTitle: pageTitle, note: note, turnId: turnId)
            state.isSending = false
            state.outcome = outcome
            UIAccessibility.post(notification: .announcement, argument: outcome.sentence)
        }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }
}

/// The link, an optional note, and Send or Cancel; afterwards the one sentence saying what
/// happened, and Done.
struct ShareView: View {
    @Bindable var state: ShareState
    let send: () -> Void
    let cancel: () -> Void
    let finish: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                if let outcome = state.outcome {
                    Section {
                        Label(outcome.sentence, systemImage: outcome == .sent ? "checkmark.circle" : (outcome == .saved ? "tray.and.arrow.down" : "exclamationmark.triangle"))
                    }
                } else if state.isReading {
                    Section { Text("Reading the shared page...").foregroundStyle(.secondary) }
                } else if let url = state.url {
                    Section("Link") {
                        if let title = state.pageTitle { Text(title) }
                        Text(url)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Section("Note") {
                        TextField("What would you like to know? (optional)", text: $state.note, axis: .vertical)
                            .lineLimit(2...5)
                            .disabled(state.isSending)
                    }
                    Section {
                        Text("Garderobe looks into this product and answers in Conversation.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Garderobe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if state.outcome == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: cancel)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(state.isSending ? "Sending..." : "Send", action: send)
                            .disabled(state.url == nil || state.isSending)
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: finish)
                    }
                }
            }
        }
    }
}
