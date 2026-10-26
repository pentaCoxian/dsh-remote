// The extension's PushCrypto against protocol/vectors/push.json (sealed by the host's code).
// Runs on the Mac: NotificationServiceTests/run.sh
import Foundation

let path = CommandLine.arguments.dropFirst().first ?? "../../../protocol/vectors/push.json"
let vector = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
let key = PushCrypto.base64URL(vector["key"] as! String)!
let hostId = vector["hostId"] as! String
let handle = vector["handle"] as! String
var failures = 0

for case let item as [String: Any] in vector["valid"] as! [Any] {
  let opened = item["opened"] as! NSDictionary
  guard let plain = PushCrypto.open(key: key, hostId: hostId, handle: handle, envelope: item["envelope"] as! String),
    let message = try? JSONSerialization.jsonObject(with: plain) as? NSDictionary, message == opened
  else {
    print("FAIL: could not open \(opened["id"] ?? "?")")
    failures += 1
    continue
  }
  print("ok: opens \(opened["id"]!)")
}
for case let item as [String: Any] in vector["reject"] as! [Any] {
  if PushCrypto.open(key: key, hostId: item["hostId"] as! String, handle: item["handle"] as! String, envelope: item["envelope"] as! String) != nil {
    print("FAIL: opened an envelope with \(item["why"]!)")
    failures += 1
  } else {
    print("ok: refuses \(item["why"]!)")
  }
}
exit(failures == 0 ? 0 : 1)
