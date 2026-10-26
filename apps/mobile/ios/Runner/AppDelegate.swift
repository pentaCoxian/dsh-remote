import Flutter
import Security
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private let deviceKeys = DeviceKeys()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    if let registrar = registrar(forPlugin: "DeviceKeys") {
      deviceKeys.register(with: registrar.messenger())
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

/// Per-host P-256 signing keys in the Secure Enclave (a flagged software key in
/// the simulator). Signatures are DER ECDSA over SHA-256, exactly what the host verifies.
final class DeviceKeys {
  private let queue = DispatchQueue(label: "dev.dshremote.device_keys")

  /// DER prefix that turns a 65-byte uncompressed P-256 point into SPKI.
  private static let spkiPrefix: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
    0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.dshremote/device_keys", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      let args = call.arguments as? [String: Any] ?? [:]
      self.queue.async {
        let reply: Any?
        do {
          switch call.method {
          case "generate": reply = try self.generate(alias: args["alias"] as! String)
          case "sign": reply = try self.sign(alias: args["alias"] as! String, data: (args["data"] as! FlutterStandardTypedData).data)
          case "verify":
            reply = self.verify(
              spki: args["publicKey"] as! String,
              data: (args["data"] as! FlutterStandardTypedData).data,
              signature: (args["signature"] as! FlutterStandardTypedData).data)
          case "delete": self.delete(alias: args["alias"] as! String); reply = nil
          default: DispatchQueue.main.async { result(FlutterMethodNotImplemented) }; return
          }
          DispatchQueue.main.async { result(reply) }
        } catch {
          DispatchQueue.main.async { result(FlutterError(code: "device-keys", message: "\(error)", details: nil)) }
        }
      }
    }
  }

  private func tag(_ alias: String) -> Data { Data("dev.dshremote.\(alias)".utf8) }

  private func generate(alias: String) throws -> [String: Any] {
    delete(alias: alias)
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, &error) else {
      throw error!.takeRetainedValue() as Error
    }
    var hardware = true
    var key = SecKeyCreateRandomKey(attributes(alias: alias, access: access, enclave: true) as CFDictionary, &error)
    if key == nil {
      // No Secure Enclave (simulator): software key, reported as such.
      hardware = false
      key = SecKeyCreateRandomKey(attributes(alias: alias, access: nil, enclave: false) as CFDictionary, &error)
    }
    guard let privateKey = key, let publicKey = SecKeyCopyPublicKey(privateKey),
      let point = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?
    else { throw error!.takeRetainedValue() as Error }
    let spki = Data(DeviceKeys.spkiPrefix) + point
    return ["publicKey": base64Url(spki), "hardwareBacked": hardware]
  }

  private func attributes(alias: String, access: SecAccessControl?, enclave: Bool) -> [String: Any] {
    var privateAttributes: [String: Any] = [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag(alias)]
    if let access { privateAttributes[kSecAttrAccessControl as String] = access }
    else { privateAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateAttributes,
    ]
    if enclave { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
    return attributes
  }

  private func privateKey(alias: String) throws -> SecKey {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(alias),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let key = item else { throw NSError(domain: "DeviceKeys", code: Int(status)) }
    return key as! SecKey
  }

  private func sign(alias: String, data: Data) throws -> FlutterStandardTypedData {
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(try privateKey(alias: alias), .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data? else {
      throw error!.takeRetainedValue() as Error
    }
    return FlutterStandardTypedData(bytes: signature)
  }

  private func verify(spki: String, data: Data, signature: Data) -> Bool {
    guard let der = base64UrlDecode(spki), der.count == DeviceKeys.spkiPrefix.count + 65,
      der.prefix(DeviceKeys.spkiPrefix.count) == Data(DeviceKeys.spkiPrefix)
    else { return false }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    guard let key = SecKeyCreateWithData(der.suffix(65) as CFData, attributes as CFDictionary, nil) else { return false }
    return SecKeyVerifySignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, signature as CFData, nil)
  }

  private func delete(alias: String) {
    SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag(alias)] as CFDictionary)
  }

  private func base64Url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private func base64UrlDecode(_ text: String) -> Data? {
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64 += "=" }
    return Data(base64Encoded: base64)
  }
}
