import UserNotifications

/// Wakes for every DSH Remote push (APNs `mutable-content`): opens the sealed
/// notification with the key only this phone and the host hold, and replaces
/// the gateway's generic "New activity" with the session, host and detail.
final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    deliver = contentHandler
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    self.content = content
    let info = request.content.userInfo
    // Keep the ciphertext out of Notification Center either way.
    content.userInfo = [:]
    guard let handle = info["h"] as? String, let envelope = info["e"] as? String, let entry = PushKeyStore.read(handle: handle) else {
      return contentHandler(content)
    }
    content.userInfo = ["dshr-host": entry.hostId]
    content.threadIdentifier = entry.hostId
    if let plain = PushCrypto.open(key: entry.key, hostId: entry.hostId, handle: handle, envelope: envelope),
      let message = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
      message["v"] as? Int == 1, message["hostId"] as? String == entry.hostId
    {
      content.title = (message["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "DSH Remote"
      content.subtitle = message["hostName"] as? String ?? ""
      content.body = (message["body"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "New activity"
    }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let deliver, let content { deliver(content) }
  }
}
