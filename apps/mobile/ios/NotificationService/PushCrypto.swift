import CryptoKit
import Foundation

/// Opens a host's sealed notification (protocol/vectors/push.json): base64url of
/// nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16), with AAD binding it to the
/// host and the gateway handle.
enum PushCrypto {
  static func aad(hostId: String, handle: String) -> Data {
    Data("dsh-remote/push/1\n\(hostId)\n\(handle)".utf8)
  }

  static func base64URL(_ text: String) -> Data? {
    var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while standard.count % 4 != 0 { standard += "=" }
    return Data(base64Encoded: standard)
  }

  /// The notification's JSON (padding removed), or nil when the envelope is not authentic.
  static func open(key: Data, hostId: String, handle: String, envelope: String) -> Data? {
    guard key.count == 32, let sealed = base64URL(envelope), sealed.count >= 28 else { return nil }
    let bytes = [UInt8](sealed)
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: Data(bytes[0..<12])),
        ciphertext: Data(bytes[12..<(bytes.count - 16)]),
        tag: Data(bytes[(bytes.count - 16)...]))
      var plain = [UInt8](try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(hostId: hostId, handle: handle)))
      while plain.last == 0x20 { plain.removeLast() }
      return Data(plain)
    } catch {
      return nil
    }
  }
}
