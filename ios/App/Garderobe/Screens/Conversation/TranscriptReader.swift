import SwiftUI
import GarderobeKit

/// Scroll bookkeeping for `TranscriptView`. A plain reference (not observable) so that rows
/// scrolling in and out never redraw the transcript.
@MainActor
final class TranscriptReader {
    /// Row IDs currently on screen.
    var visible: Set<String> = []
    /// The end of the transcript is on screen.
    var bottomVisible = false
    /// The first placement (reading anchor or bottom) has been made; reporting starts after it.
    var placed = false
    /// The top row may trigger loading on its own (only after a placement has settled).
    var autoLoad = false
    /// The message to keep at the top while an older page is inserted above it.
    var keepTop: String?
    var reportScheduled = false
    /// What the model was last told, so it is told again only when something changed.
    var reported: (atBottom: Bool, anchor: String?)?
}
