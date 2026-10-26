import 'dart:convert';
import 'dart:typed_data';

import '../core/protocol.dart';
import '../device_keys/device_keys.dart';

/// Signs requests with this phone's keystore key (spec §5 request proof).
class RequestSigner {
  RequestSigner({required this.keys, required this.keyAlias, required this.deviceId});

  final DeviceKeys keys;
  final String keyAlias;

  /// `pending` until the host grants a device id.
  String deviceId;

  /// Host time minus local time, learned from TIMESTAMP_SKEW and hello frames.
  int clockOffsetMs = 0;

  Future<Map<String, String>> headers(String method, String target, List<int> body) async {
    final timestampMs = DateTime.now().millisecondsSinceEpoch + clockOffsetMs;
    final nonce = randomToken(16);
    final canonical = canonicalRequestString(method: method, target: target, bodySha256Hex: sha256Hex(body), timestampMs: timestampMs, nonce: nonce);
    final signature = await keys.sign(keyAlias, Uint8List.fromList(utf8.encode(canonical)));
    return {
      DshHeaders.protocol: '$protocolVersion',
      DshHeaders.deviceId: deviceId,
      DshHeaders.timestamp: '$timestampMs',
      DshHeaders.nonce: nonce,
      DshHeaders.signature: base64UrlNoPad(signature),
    };
  }

  void learnServerTime(int serverTime) => clockOffsetMs = serverTime - DateTime.now().millisecondsSinceEpoch;
}
