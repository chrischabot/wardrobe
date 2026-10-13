import Foundation

/// Which of Apple's two notification services issues this build's tokens. That is fixed by how
/// the build was signed (the `aps-environment` entitlement), not by its build configuration: a
/// release build signed for development still gets development tokens.
public enum PushEnvironment {
    /// The `aps-environment` entitlement in an embedded provisioning profile
    /// (`embedded.mobileprovision`): a signed container whose payload is a property list in
    /// plain XML. Nil when the bytes hold no such list or the list names no service.
    public static func fromProvisioningProfile(_ data: Data) -> DeviceRegistration.Environment? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else { return nil }
        let xml = Data(data[start.lowerBound..<end.upperBound])
        guard let list = (try? PropertyListSerialization.propertyList(from: xml, options: [], format: nil)) as? [String: Any],
              let entitlements = list["Entitlements"] as? [String: Any],
              let value = entitlements["aps-environment"] as? String else { return nil }
        // Only the two services Apple has; anything else decides nothing.
        switch value {
        case DeviceRegistration.Environment.development.rawValue: return .development
        case DeviceRegistration.Environment.production.rawValue: return .production
        default: return nil
        }
    }

    /// The service for this build. A profile that names one decides it. Without that: a build
    /// from the App Store or TestFlight carries no profile and is production; a simulator or a
    /// debug build is development.
    public static func resolve(profile: Data?, isSimulator: Bool, isDebugBuild: Bool) -> DeviceRegistration.Environment {
        if let profile, let named = fromProvisioningProfile(profile) { return named }
        return isSimulator || isDebugBuild ? .development : .production
    }
}
