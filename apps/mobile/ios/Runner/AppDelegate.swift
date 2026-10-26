import Flutter
import Security
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate {
  private let deviceKeys = DeviceKeys()
  private let push = PushChannel()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    if let registrar = registrar(forPlugin: "DeviceKeys") {
      deviceKeys.register(with: registrar.messenger())
    }
    if let registrar = registrar(forPlugin: "Push") {
      push.register(with: registrar.messenger())
    }
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    push.tokenArrived(deviceToken)
  }

  override func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    push.tokenFailed(error)
  }

  /// In the foreground too: a host only notifies while its DSH Web is not open here.
  override func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
  }

  /// A tap opens that host's DSH Web, through Flutter's deep linking (dshremote://host/<id>).
  override func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    if let host = response.notification.request.content.userInfo["dshr-host"] as? String, let url = URL(string: "dshremote://host/\(host)") {
      _ = application(UIApplication.shared, open: url, options: [:])
    }
    completionHandler()
  }
}

/// `dev.dshremote/push`: the APNs token, notification permission, and per-host
/// keys (see lib/push/push_native.dart and Shared/PushKeyStore.swift).
final class PushChannel {
  private var waiting: [FlutterResult] = []

  func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.dshremote/push", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      let args = call.arguments as? [String: Any] ?? [:]
      switch call.method {
      case "platform":
        result("apns")
      case "permitted":
        UNUserNotificationCenter.current().getNotificationSettings { settings in
          let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
          DispatchQueue.main.async { result(allowed) }
        }
      case "requestPermission":
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
          DispatchQueue.main.async { result(granted) }
        }
      case "token":
        self.waiting.append(result)
        UIApplication.shared.registerForRemoteNotifications()
      case "newKey":
        do {
          result(try PushKeyStore.create(handle: args["handle"] as! String, hostId: args["hostId"] as! String))
        } catch {
          result(FlutterError(code: "push", message: error.localizedDescription, details: nil))
        }
      case "deleteKey":
        PushKeyStore.delete(handle: args["handle"] as! String)
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  /// Which APNs servers issued this build's token: development-signed builds (any
  /// configuration installed from Xcode) say "development" in their embedded
  /// profile; App Store and TestFlight builds carry none and use production.
  private static let apnsEnvironment: String = {
    #if targetEnvironment(simulator)
      return "sandbox"
    #else
      guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
        let data = try? Data(contentsOf: url), let profile = String(data: data, encoding: .isoLatin1)
      else { return "production" }
      return profile.range(of: "<key>aps-environment</key>\\s*<string>development</string>", options: .regularExpression) != nil ? "sandbox" : "production"
    #endif
  }()

  func tokenArrived(_ token: Data) {
    let reply: [String: Any] = ["token": token.map { String(format: "%02x", $0) }.joined(), "environment": PushChannel.apnsEnvironment]
    for result in waiting { result(reply) }
    waiting.removeAll()
  }

  func tokenFailed(_ error: Error) {
    for result in waiting { result(FlutterError(code: "push", message: error.localizedDescription, details: nil)) }
    waiting.removeAll()
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
