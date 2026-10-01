import Foundation

// Hand-written conveniences on the generated contract types (GarderobeContracts.swift is never
// edited). Only identity and read-only accessors live here; no behaviour.

extension BoardOption: Identifiable { public var id: String { optionId } }
extension BoardGarmentLine: Identifiable { public var id: String { garmentId + ":" + role.rawValue } }
extension Garment: Identifiable { public var id: String { garmentId } }
extension InventoryItem: Identifiable { public var id: String { garment.garmentId } }
extension Restriction: Identifiable { public var id: String { restrictionId } }
extension StockMovement: Identifiable { public var id: String { eventId } }
extension GarmentFact: Identifiable { public var id: String { factId } }
extension StyleAmendment: Identifiable { public var id: String { amendmentId } }
extension StandingDirection: Identifiable { public var id: String { directionId } }
extension TemporaryBrief: Identifiable { public var id: String { briefId } }
extension Measurement: Identifiable { public var id: String { measurementId } }
extension SizeExperience: Identifiable { public var id: String { sizeExperienceId } }
extension Trip: Identifiable { public var id: String { tripId } }
extension ReturnCase: Identifiable { public var id: String { caseId } }
extension ComfortFeedback: Identifiable { public var id: String { feedbackId } }
extension StudioCombination: Identifiable { public var id: String { combinationId } }
extension StudioDayPlan: Identifiable { public var id: String { planId } }
extension ApiConnection: Identifiable { public var id: String { connectionId } }
extension AssistantGrant: Identifiable { public var id: String { grantId } }
extension LinkedIdentity: Identifiable { public var id: String { identityId } }
extension ExportJob: Identifiable { public var id: String { exportId } }
extension CommandReceipt: Identifiable { public var id: String { commandId } }
extension LaundryStateResponse.BatchesItem: Identifiable { public var id: String { batchId } }
extension LaundryStateResponse.BatchesItem.ItemsItem: Identifiable { public var id: String { garmentId } }
extension LaundryStateResponse.AwaitingServiceItem: Identifiable { public var id: String { garmentId } }
extension LaundryStateResponse.AwaitingHandwashItem: Identifiable { public var id: String { garmentId } }
extension WeatherHour: Identifiable { public var id: String { at } }

extension InventoryItem {
    /// Units of this garment in a bucket, summed across batches and trips.
    public func quantity(in bucket: Bucket) -> Int { balances.filter { $0.bucket == bucket }.reduce(0) { $0 + $1.quantity } }
}

extension GarmentDetail {
    public func quantity(in bucket: Bucket) -> Int { balances.filter { $0.bucket == bucket }.reduce(0) { $0 + $1.quantity } }
}

extension BoardDocument {
    /// The expected-version key for edits to this board (`board:<boardId>` = `revision`).
    public var versionKey: String { "board:\(boardId)" }
    public func option(_ optionId: String) -> BoardOption? { options.first { $0.optionId == optionId } }
}

extension OwnerSettings {
    public var timeZoneValue: TimeZone? { TimeZone(identifier: timezone) }
}
