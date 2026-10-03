import SwiftUI
import GarderobeKit

/// First use after sign-in. It begins with the imported wardrobe and style profile, not a blank
/// form, and every step can be skipped: none blocks the app or the recommendations.
struct FirstUseFlow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if app.account.visibleKit != nil {
                // A recovery kit issued at the claim (or by a recovery) is read before anything else.
                RecoveryOutcomeView()
            } else {
                steps
            }
        }
        .task {
            await app.settings.open()
            await app.wardrobe.open()
            await app.today.open()
        }
    }

    private var steps: some View {
        let firstUse = app.firstUse
        let all = FirstUseModel.Step.allCases
        let position = (all.firstIndex(of: firstUse.step) ?? 0) + 1
        return NavigationStack {
            List {
                Section {
                    Text("Step \(position) of \(all.count)")
                        .font(.footnote)
                        .foregroundStyle(Color.supporting)
                        .listRowBackground(Color.clear)
                }
                switch firstUse.step {
                case .welcome: FirstUseWelcomeStep()
                case .connectGoogle: FirstUseConnectStep()
                case .calendar: FirstUseCalendarStep()
                case .delivery: FirstUseDeliveryStep()
                case .sampleBoard: FirstUseSampleBoardStep()
                }
            }
            .navigationTitle(firstUse.step.title)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Skip setup") { firstUse.finish() }
                        .accessibilityHint("Opens the app now. Everything here is also in Settings.")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { controls }
        }
    }

    /// Back and Continue. They stack at accessibility text sizes so both stay full-size targets.
    private var controls: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(spacing: Metrics.unit * 2) { continueButton; backButton }
            } else {
                HStack(spacing: Metrics.unit * 3) { backButton; continueButton }
            }
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, Metrics.unit * 3)
        .frame(maxWidth: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    @ViewBuilder
    private var backButton: some View {
        if app.firstUse.step != FirstUseModel.Step.allCases.first {
            Button {
                app.firstUse.back()
            } label: {
                Text("Back").frame(maxWidth: .infinity)
            }
            .secondaryAction()
            .controlSize(.large)
        }
    }

    private var continueButton: some View {
        Button {
            if isLastStep { app.firstUse.finish() } else { app.firstUse.advance() }
        } label: {
            Text(continueTitle).frame(maxWidth: .infinity)
        }
        .primaryAction()
        .controlSize(.large)
    }

    private var isLastStep: Bool { app.firstUse.step == FirstUseModel.Step.allCases.last }

    /// A step whose connection has not been made is still passable; the button says so.
    private var continueTitle: String {
        if isLastStep { return "Finish" }
        switch app.firstUse.step {
        case .connectGoogle where !app.firstUse.googleConnected: return "Skip for now"
        case .calendar where app.settings.calendars?.outfitCalendarId == nil: return "Skip for now"
        default: return "Continue"
        }
    }
}
