import Foundation

// Account transfers: export, import and recovery reached from an assistant (packages/contracts/src/surface.ts).
// Private material (download links, link tokens, recovery codes) lives only in memory for the moment the
// owner uses it: nothing here is written to the transcript, the client store or logs.

/// `{ name, rows }` in export and import summaries.
public struct TableCount: Codable, Sendable, Hashable {
    public var name: String
    public var rows: Int
    public init(name: String, rows: Int) { self.name = name; self.rows = rows }
}

/// Contract `ExportDownloadResult`: the export is never inline; `downloadUrl` opens only for the signed-in owner.
public struct ExportDownloadResult: Codable, Sendable, Hashable {
    public var exportId: String
    public var transferId: String
    public var exportedAt: Date
    public var expiresAt: Date
    public var delivery: String
    public var downloadUrl: String?
    public var packageSha256: String
    public var complete: Bool
    public var incomplete: [String]
    public var tables: [TableCount]
    public var summary: String

    public init(exportId: String, transferId: String, exportedAt: Date, expiresAt: Date, downloadUrl: String?, packageSha256: String, complete: Bool, incomplete: [String] = [], tables: [TableCount], summary: String) {
        self.exportId = exportId; self.transferId = transferId; self.exportedAt = exportedAt; self.expiresAt = expiresAt; self.delivery = "signed_link"
        self.downloadUrl = downloadUrl; self.packageSha256 = packageSha256; self.complete = complete; self.incomplete = incomplete; self.tables = tables; self.summary = summary
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, exportId, transferId, exportedAt, expiresAt, delivery, downloadUrl, packageSha256, complete, incomplete, tables, summary }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exportId = try c.decode(String.self, forKey: .exportId)
        transferId = try c.decode(String.self, forKey: .transferId)
        exportedAt = try c.decode(Date.self, forKey: .exportedAt)
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
        delivery = c.value(.delivery, default: "signed_link")
        downloadUrl = c.value(.downloadUrl, default: nil)
        packageSha256 = c.value(.packageSha256, default: "")
        complete = c.value(.complete, default: false)
        incomplete = c.value(.incomplete, default: [])
        tables = c.value(.tables, default: [])
        summary = c.value(.summary, default: "")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(exportId, forKey: .exportId); try c.encode(transferId, forKey: .transferId)
        try c.encode(exportedAt, forKey: .exportedAt); try c.encode(expiresAt, forKey: .expiresAt)
        try c.encode(delivery, forKey: .delivery); try c.encodeIfPresent(downloadUrl, forKey: .downloadUrl)
        try c.encode(packageSha256, forKey: .packageSha256); try c.encode(complete, forKey: .complete)
        try c.encode(incomplete, forKey: .incomplete); try c.encode(tables, forKey: .tables); try c.encode(summary, forKey: .summary)
    }
}

/// Contract `StagedImportPackage` (POST/GET /v1/import/packages): a verified export waiting for the owner's confirmation.
public struct StagedImportPackage: Codable, Sendable, Hashable {
    public var packageId: String
    public var exportId: String
    public var exportedAt: String
    public var sourceDisplayName: String?
    public var tables: [TableCount]
    public var status: String
    public var expiresAt: Date

    public init(packageId: String, exportId: String, exportedAt: String, sourceDisplayName: String?, tables: [TableCount], status: String, expiresAt: Date) {
        self.packageId = packageId; self.exportId = exportId; self.exportedAt = exportedAt; self.sourceDisplayName = sourceDisplayName; self.tables = tables; self.status = status; self.expiresAt = expiresAt
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, packageId, exportId, exportedAt, sourceDisplayName, tables, status, expiresAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        packageId = try c.decode(String.self, forKey: .packageId)
        exportId = c.value(.exportId, default: "")
        exportedAt = c.value(.exportedAt, default: "")
        sourceDisplayName = c.value(.sourceDisplayName, default: nil)
        tables = c.value(.tables, default: [])
        status = c.value(.status, default: "staged")
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(packageId, forKey: .packageId); try c.encode(exportId, forKey: .exportId); try c.encode(exportedAt, forKey: .exportedAt)
        try c.encode(sourceDisplayName, forKey: .sourceDisplayName); try c.encode(tables, forKey: .tables)
        try c.encode(status, forKey: .status); try c.encode(expiresAt, forKey: .expiresAt)
    }
}

/// Contract `McpImportResult`: what an import did to the owner's records and connections.
public struct McpImportResult: Codable, Sendable, Hashable {
    public struct ImportedGrants: Codable, Sendable, Hashable { public var count: Int; public var status: String }
    public struct CallingGrant: Codable, Sendable, Hashable {
        public var grantId: String?; public var status: String; public var note: String
        public init(grantId: String?, status: String, note: String) { self.grantId = grantId; self.status = status; self.note = note }
        enum CodingKeys: String, CodingKey { case grantId, status, note }
        /// `grantId` is a required, nullable key: write an explicit null.
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(grantId, forKey: .grantId); try c.encode(status, forKey: .status); try c.encode(note, forKey: .note)
        }
    }
    public var packageId: String
    public var exportId: String
    public var tables: [TableCount]
    public var importedAssistantGrants: ImportedGrants
    public var sessionsRecreated: Int
    public var callingGrant: CallingGrant
    public var summary: String

    public init(packageId: String, exportId: String, tables: [TableCount], importedAssistantGrants: ImportedGrants, callingGrant: CallingGrant, summary: String) {
        self.packageId = packageId; self.exportId = exportId; self.tables = tables; self.importedAssistantGrants = importedAssistantGrants
        self.sessionsRecreated = 0; self.callingGrant = callingGrant; self.summary = summary
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, imported, packageId, exportId, tables, importedAssistantGrants, sessionsRecreated, callingGrant, summary }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        packageId = try c.decode(String.self, forKey: .packageId)
        exportId = c.value(.exportId, default: "")
        tables = c.value(.tables, default: [])
        importedAssistantGrants = c.value(.importedAssistantGrants, default: ImportedGrants(count: 0, status: "revoked"))
        sessionsRecreated = c.value(.sessionsRecreated, default: 0)
        callingGrant = c.value(.callingGrant, default: CallingGrant(grantId: nil, status: "active", note: ""))
        summary = c.value(.summary, default: "")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(true, forKey: .imported)
        try c.encode(packageId, forKey: .packageId); try c.encode(exportId, forKey: .exportId); try c.encode(tables, forKey: .tables)
        try c.encode(importedAssistantGrants, forKey: .importedAssistantGrants); try c.encode(sessionsRecreated, forKey: .sessionsRecreated)
        try c.encode(callingGrant, forKey: .callingGrant); try c.encode(summary, forKey: .summary)
    }
}

/// Contract `RecoveryKitLink`: no code inside; the code is issued only when the signed-in owner collects it.
public struct RecoveryKitLink: Codable, Sendable, Hashable {
    public var transferId: String
    public var expiresAt: Date
    public var delivery: String
    public var collectUrl: String?
    public var codeIncluded: Bool
    public var summary: String

    public init(transferId: String, expiresAt: Date, collectUrl: String?, summary: String) {
        self.transferId = transferId; self.expiresAt = expiresAt; self.delivery = "garderobe_link"; self.collectUrl = collectUrl; self.codeIncluded = false; self.summary = summary
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, transferId, expiresAt, delivery, collectUrl, codeIncluded, summary }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        transferId = try c.decode(String.self, forKey: .transferId)
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
        delivery = c.value(.delivery, default: "garderobe_link")
        collectUrl = c.value(.collectUrl, default: nil)
        codeIncluded = c.value(.codeIncluded, default: false)
        summary = c.value(.summary, default: "")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(transferId, forKey: .transferId); try c.encode(expiresAt, forKey: .expiresAt); try c.encode(delivery, forKey: .delivery)
        try c.encodeIfPresent(collectUrl, forKey: .collectUrl); try c.encode(false, forKey: .codeIncluded); try c.encode(summary, forKey: .summary)
    }
}

/// Contract `RecoveryKitResponse`: the recovery code itself, shown once and never stored by the app.
public struct RecoveryKitResponse: Codable, Sendable, Hashable {
    public var credential: String
    public var credentialId: String
    public var instructions: String
    public var issuedAt: Date
    public init(credential: String, credentialId: String, instructions: String, issuedAt: Date) {
        self.credential = credential; self.credentialId = credentialId; self.instructions = instructions; self.issuedAt = issuedAt
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, credential, credentialId, instructions, issuedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        credential = try c.decode(String.self, forKey: .credential)
        credentialId = c.value(.credentialId, default: "")
        instructions = c.value(.instructions, default: "")
        issuedAt = try c.decode(Date.self, forKey: .issuedAt)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(credential, forKey: .credential); try c.encode(credentialId, forKey: .credentialId)
        try c.encode(instructions, forKey: .instructions); try c.encode(issuedAt, forKey: .issuedAt)
    }
}

/// Contract `RecoveryStatus` (GET /v1/auth/recovery-kit): metadata only, never the code.
public struct RecoveryStatus: Codable, Sendable, Hashable {
    public struct PendingCollection: Codable, Sendable, Hashable { public var transferId: String; public var expiresAt: Date }
    public var hasActiveKit: Bool
    public var activeKitIssuedAt: Date?
    public var lastRecoveredAt: Date?
    public var failedAttemptsLast24h: Int
    public var pendingCollection: PendingCollection?

    public init(hasActiveKit: Bool, activeKitIssuedAt: Date?, lastRecoveredAt: Date? = nil, failedAttemptsLast24h: Int = 0, pendingCollection: PendingCollection? = nil) {
        self.hasActiveKit = hasActiveKit; self.activeKitIssuedAt = activeKitIssuedAt; self.lastRecoveredAt = lastRecoveredAt
        self.failedAttemptsLast24h = failedAttemptsLast24h; self.pendingCollection = pendingCollection
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, hasActiveKit, activeKitIssuedAt, lastRecoveredAt, failedAttemptsLast24h, pendingCollection }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hasActiveKit = c.value(.hasActiveKit, default: false)
        activeKitIssuedAt = c.value(.activeKitIssuedAt, default: nil)
        lastRecoveredAt = c.value(.lastRecoveredAt, default: nil)
        failedAttemptsLast24h = c.value(.failedAttemptsLast24h, default: 0)
        pendingCollection = c.value(.pendingCollection, default: nil)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(hasActiveKit, forKey: .hasActiveKit); try c.encode(activeKitIssuedAt, forKey: .activeKitIssuedAt)
        try c.encode(lastRecoveredAt, forKey: .lastRecoveredAt); try c.encode(failedAttemptsLast24h, forKey: .failedAttemptsLast24h)
        try c.encode(pendingCollection, forKey: .pendingCollection)
    }
}

/// Contract `AccountTransfers` (GET /v1/account/transfers): exports, staged imports, recovery links and the audit trail.
public struct AccountTransfers: Codable, Sendable, Hashable {
    public struct Transfer: Codable, Sendable, Hashable, Identifiable {
        public var id: String { transferId }
        public var transferId: String
        public var kind: String
        public var status: String
        public var surface: String
        public var createdAt: Date
        public var expiresAt: Date
        public var completedAt: Date?
        public var summary: JSONValue
        public init(transferId: String, kind: String, status: String, surface: String, createdAt: Date, expiresAt: Date, completedAt: Date?, summary: JSONValue = .object([:])) {
            self.transferId = transferId; self.kind = kind; self.status = status; self.surface = surface
            self.createdAt = createdAt; self.expiresAt = expiresAt; self.completedAt = completedAt; self.summary = summary
        }
        enum CodingKeys: String, CodingKey { case transferId, kind, status, surface, createdAt, expiresAt, completedAt, summary }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(transferId, forKey: .transferId); try c.encode(kind, forKey: .kind); try c.encode(status, forKey: .status)
            try c.encode(surface, forKey: .surface); try c.encode(createdAt, forKey: .createdAt); try c.encode(expiresAt, forKey: .expiresAt)
            try c.encode(completedAt, forKey: .completedAt); try c.encode(summary, forKey: .summary)
        }
    }
    public struct Audit: Codable, Sendable, Hashable, Identifiable {
        public var id: String { auditId }
        public var auditId: String
        public var action: String
        public var surface: String
        public var grantRef: String?
        public var idempotencyKey: String?
        public var outcome: String
        public var detail: JSONValue
        public var createdAt: Date
        public init(auditId: String, action: String, surface: String, grantRef: String? = nil, idempotencyKey: String? = nil, outcome: String, detail: JSONValue = .object([:]), createdAt: Date) {
            self.auditId = auditId; self.action = action; self.surface = surface; self.grantRef = grantRef; self.idempotencyKey = idempotencyKey
            self.outcome = outcome; self.detail = detail; self.createdAt = createdAt
        }
        enum CodingKeys: String, CodingKey { case auditId, action, surface, grantRef, idempotencyKey, outcome, detail, createdAt }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(auditId, forKey: .auditId); try c.encode(action, forKey: .action); try c.encode(surface, forKey: .surface)
            try c.encode(grantRef, forKey: .grantRef); try c.encode(idempotencyKey, forKey: .idempotencyKey); try c.encode(outcome, forKey: .outcome)
            try c.encode(detail, forKey: .detail); try c.encode(createdAt, forKey: .createdAt)
        }
    }
    public var transfers: [Transfer]
    public var audit: [Audit]

    public init(transfers: [Transfer], audit: [Audit]) { self.transfers = transfers; self.audit = audit }
    enum CodingKeys: String, CodingKey { case schemaVersion, transfers, audit }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // One malformed row must not hide the others.
        transfers = c.value(.transfers, default: [JSONValue]()).compactMap { try? $0.decode(Transfer.self) }
        audit = c.value(.audit, default: [JSONValue]()).compactMap { try? $0.decode(Audit.self) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(transfers, forKey: .transfers); try c.encode(audit, forKey: .audit)
    }
}

/// `RunInputResponse.operation`: a confirmed account operation and its result (with the owner's private link).
public struct AccountOperationReceipt: Codable, Sendable, Hashable {
    public var operation: String
    public var idempotencyKey: String?
    public var replayed: Bool
    public var result: JSONValue
    public init(operation: String, idempotencyKey: String?, replayed: Bool, result: JSONValue) {
        self.operation = operation; self.idempotencyKey = idempotencyKey; self.replayed = replayed; self.result = result
    }
    enum CodingKeys: String, CodingKey { case operation, idempotencyKey, replayed, result }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(operation, forKey: .operation); try c.encode(idempotencyKey, forKey: .idempotencyKey)
        try c.encode(replayed, forKey: .replayed); try c.encode(result, forKey: .result)
    }

    /// The typed outcome; an operation this app version does not know is kept by name only.
    public var outcome: AccountOperationOutcome {
        switch operation {
        case "export_data": (try? result.decode(ExportDownloadResult.self)).map(AccountOperationOutcome.export) ?? .unknown(operation)
        case "import_data": (try? result.decode(McpImportResult.self)).map(AccountOperationOutcome.imported) ?? .unknown(operation)
        case "issue_recovery_kit": (try? result.decode(RecoveryKitLink.self)).map(AccountOperationOutcome.recoveryKit) ?? .unknown(operation)
        default: .unknown(operation)
        }
    }
}

public enum AccountOperationOutcome: Sendable, Hashable {
    case export(ExportDownloadResult)
    case imported(McpImportResult)
    case recoveryKit(RecoveryKitLink)
    case unknown(String)
}
