import Foundation
import Security

/// Per-host notification keys in the keychain group the app shares with its
/// Notification Service Extension, readable after first unlock and never
/// synced or backed up off this device. The app writes them; the extension,
/// which runs while the app is not, reads them.
enum PushKeyStore {
  struct Entry {
    let key: Data
    let hostId: String
  }

  private static let service = "dev.dshremote.push"

  /// `<team>.dev.dshremote.shared`, from the `AppIdentifierPrefix` both Info.plists carry.
  private static var accessGroup: String? {
    (Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String).map { "\($0)dev.dshremote.shared" }
  }

  private static func query(handle: String) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: handle]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  /// A fresh key for notifications from `hostId` that arrive with `handle`; base64url for the host.
  static func create(handle: String, hostId: String) throws -> String {
    var key = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, key.count, &key) == errSecSuccess else { throw NSError(domain: "push", code: 1, userInfo: [NSLocalizedDescriptionKey: "no randomness"]) }
    defer { key = [UInt8](repeating: 0, count: 32) }
    let stored = try JSONSerialization.data(withJSONObject: ["key": Data(key).base64EncodedString(), "hostId": hostId])
    SecItemDelete(query(handle: handle) as CFDictionary)
    var add = query(handle: handle)
    add[kSecValueData as String] = stored
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "keychain refused the key (\(status))"]) }
    return Data(key).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static func read(handle: String) -> Entry? {
    var find = query(handle: handle)
    find[kSecReturnData as String] = true
    find[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(find as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      let encoded = json["key"], let key = Data(base64Encoded: encoded), let hostId = json["hostId"]
    else { return nil }
    return Entry(key: key, hostId: hostId)
  }

  static func delete(handle: String) {
    SecItemDelete(query(handle: handle) as CFDictionary)
  }
}
