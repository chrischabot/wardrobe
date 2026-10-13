import Testing
import Foundation
@testable import GarderobeKit

@Suite("Dates, hashing, wording")
struct SupportTests {
    @Test("Instants round-trip in the contract's UTC form, with and without milliseconds")
    func instants() throws {
        let date = try #require(Dates.parseInstant("2026-09-15T06:50:00Z"))
        #expect(Dates.instant(date) == "2026-09-15T06:50:00Z")
        let millis = try #require(Dates.parseInstant("2026-09-15T06:50:00.250Z"))
        #expect(abs(millis.timeIntervalSince(date) - 0.25) < 0.001)
        #expect(Dates.parseInstant("2026-09-15 06:50") == nil)
        #expect(Dates.parseInstant("2026-09-15T06:50:00+01:00") == nil)
    }

    @Test("The civil date follows the owner's timezone, not UTC or the phone")
    func localDates() throws {
        let london = try #require(TimeZone(identifier: "Europe/London"))
        let tokyo = try #require(TimeZone(identifier: "Asia/Tokyo"))
        // 23:30 UTC on 14 September is already the 15th in London (BST) and in Tokyo.
        let late = try #require(Dates.parseInstant("2026-09-14T23:30:00Z"))
        #expect(Dates.localDate(of: late, in: london) == "2026-09-15")
        #expect(Dates.localDate(of: late, in: tokyo) == "2026-09-15")
        #expect(Dates.localDate(of: late, in: TimeZone(identifier: "America/New_York")!) == "2026-09-14")
        #expect(Dates.adding(days: 1, to: "2026-02-28") == "2026-03-01")
        #expect(Dates.adding(days: -1, to: "2026-10-25") == "2026-10-24") // across the end of summer time
        #expect(Dates.days(from: "2026-09-10", to: "2026-09-15") == 5)
    }

    @Test("SHA-256 matches the published test vectors")
    func sha256Vectors() {
        #expect(SHA256.hex(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(SHA256.hex(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(SHA256.hex(Data("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8)) == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
        #expect(SHA256.hex(Data(repeating: 0x61, count: 1_000_000)) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")
    }

    @Test("PKCE S256 reproduces the RFC 7636 appendix B example")
    func pkceVector() {
        let bytes: [UInt8] = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]
        let pkce = PKCE(randomBytes: bytes)
        #expect(pkce.verifier == "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test("A zero wear count is worded as unlogged, never as unworn")
    func zeroWearsWording() {
        let line = Phrases.wearCount(0, last: nil, loggingSince: "2026-06-03", today: "2026-09-15")
        #expect(line == "No wears logged since logging began on 3 June. Not a sign it is unworn.")
        #expect(!Phrases.wearCount(0, last: nil, loggingSince: nil, today: "2026-09-15").lowercased().hasPrefix("unworn"))
        #expect(Phrases.wearCount(3, last: "2026-09-13", loggingSince: nil, today: "2026-09-15") == "3 logged wears, last 2 days ago")
    }

    @Test("Freshness never calls cached data current")
    func freshnessStatements() throws {
        let zone = try #require(TimeZone(identifier: "Europe/London"))
        let now = try #require(Dates.parseInstant("2026-09-15T06:30:00Z"))
        let checked = try #require(Dates.parseInstant("2026-09-14T20:40:00Z"))
        let cached = Freshness(origin: .cache, checkedAt: checked, isRefreshing: false, failure: nil)
        #expect(!cached.isCurrent)
        #expect(cached.statement(subject: "board", now: now, timeZone: zone) == "Saved board from yesterday at 21:40. Not checked yet.")
        let offline = Freshness(origin: .cache, checkedAt: checked, isRefreshing: false, failure: .transport("x"))
        #expect(offline.statement(subject: "board", now: now, timeZone: zone) == "Offline. Board last checked yesterday at 21:40.")
        let never = Freshness(origin: .none, checkedAt: nil, isRefreshing: false, failure: .transport("x"))
        #expect(never.statement(subject: "board", now: now, timeZone: zone) == "Offline. Board has not been saved on this phone yet.")
        let live = Freshness(origin: .live, checkedAt: now, isRefreshing: false, failure: nil)
        #expect(live.isCurrent)
        // A live value whose later refresh failed is no longer called current.
        #expect(!Freshness(origin: .live, checkedAt: checked, isRefreshing: false, failure: .status(500)).isCurrent)
    }

    @Test("Unknown enum members from a newer backend decode instead of failing the whole response")
    func unknownEnumTolerated() throws {
        let json = Data(#"{"garmentId":"g","role":"cape","name":"Test cape","colour":null,"futureField":42}"#.utf8)
        let line = try GarderobeJSON.decode(BoardGarmentLine.self, from: json)
        #expect(line.role == .unknown)
        #expect(Phrases.role(line.role) == "Other")
    }
}

@Suite("Server-sent events parser")
struct SSETests {
    @Test("Events split across chunks, mid-line and mid-character, are reassembled")
    func splitChunks() {
        var parser = SSEParser()
        let bytes = Array("id: 7\nevent: text_delta\ndata: {\"t\":\"café ☕\"}\n\n".utf8)
        var events: [ServerSentEvent] = []
        for byte in bytes { events += parser.feed(Data([byte])) } // one byte at a time splits the multi-byte characters
        #expect(events == [ServerSentEvent(id: "7", event: "text_delta", data: "{\"t\":\"café ☕\"}")])
        #expect(parser.lastEventId == "7")
    }

    @Test("CRLF line endings, comments, multi-line data and a missing event name are handled")
    func framing() {
        var parser = SSEParser()
        let events = parser.feed(Data(": keep-alive\r\nid: 1\r\ndata: first\r\ndata: second\r\n\r\nretry: 3000\r\ndata:no-space\r\n\r\n".utf8))
        #expect(events.count == 2)
        #expect(events[0] == ServerSentEvent(id: "1", event: "message", data: "first\nsecond"))
        #expect(events[1].data == "no-space")
        #expect(events[1].id == "1") // the last event ID persists until replaced
        #expect(parser.retryMilliseconds == 3000)
    }

    @Test("A block without data dispatches nothing but still advances the last event ID")
    func idWithoutData() {
        var parser = SSEParser()
        #expect(parser.feed(Data("id: 9\n\n".utf8)).isEmpty)
        #expect(parser.lastEventId == "9")
        #expect(parser.feed(Data("data: x".utf8)).isEmpty) // incomplete: nothing until the blank line
        #expect(parser.feed(Data("\n\n".utf8)).map(\.data) == ["x"])
    }
}
