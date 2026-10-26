// Dart half of the DSH Remote wire contract (protocol/native-v1.schema.json).
// Mirrors packages/protocol; both are checked against protocol/vectors/.
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

const int protocolVersion = 1;
const String signingPrefix = 'DSH-REMOTE-V1';

/// Device id sent before the host has granted one (pair redeem and pair status).
const String pendingDeviceId = 'pending';

abstract final class DshHeaders {
  static const protocol = 'X-DSH-Protocol';
  static const deviceId = 'X-DSH-Device-Id';
  static const timestamp = 'X-DSH-Timestamp';
  static const nonce = 'X-DSH-Nonce';
  static const signature = 'X-DSH-Signature';
}

/// WebSocket close codes of /v1/events.
abstract final class CloseCodes {
  static const hostRestarting = 1012;
  static const deviceRevoked = 4403;
  static const protocolUnsupported = 4426;
}

const int maxPromptBytes = 16 * 1024;

String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

String base64UrlNoPad(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

List<int> decodeBase64UrlNoPad(String text) => base64Url.decode(base64Url.normalize(text));

final Random _random = Random.secure();

/// [bytes] random bytes as unpadded base64url.
String randomToken([int bytes = 16]) => base64UrlNoPad(List<int>.generate(bytes, (_) => _random.nextInt(256)));

/// The exact string a device signs (spec §5): six lines, LF-joined, no trailing LF.
String canonicalRequestString({
  required String method,
  required String target,
  required String bodySha256Hex,
  required int timestampMs,
  required String nonce,
}) {
  if (!RegExp(r'^[A-Z]{3,7}$').hasMatch(method)) throw ArgumentError('method must be uppercase');
  if (!target.startsWith('/') || RegExp(r'[\s\x00-\x1f\x7f]').hasMatch(target)) throw ArgumentError('target must be origin-form');
  return [signingPrefix, method, target, bodySha256Hex, '$timestampMs', nonce].join('\n');
}

/// Opaque event cursor; the app only needs its session and seq to dedupe.
class Cursor {
  const Cursor(this.sessionId, this.seq);
  final String sessionId;
  final int seq;

  static Cursor? decode(String text) {
    if (!text.startsWith('c1.') || text.length > 603) return null;
    try {
      final value = jsonDecode(utf8.decode(decodeBase64UrlNoPad(text.substring(3))));
      if (value is! Map || value.length != 2) return null;
      final s = value['s'];
      final q = value['q'];
      if (s is! String || q is! int || q < -1 || !RegExp(r'^[\x21-\x7e]{1,200}$').hasMatch(s)) return null;
      return Cursor(s, q);
    } catch (_) {
      return null;
    }
  }
}

final _endpointId = RegExp(r'^[0-9a-f]{64}$');
final _ticket = RegExp(r'^endpoint[a-z2-7]{52,1500}$');

/// An iroh EndpointId (lowercase hex Ed25519 key); host ids are EndpointIds.
bool isEndpointId(String text) => _endpointId.hasMatch(text);

/// The first 10 hex digits, as the host's `dsh-remote pair` prints its id.
String shortHostId(String hostId) => hostId.substring(0, min(10, hostId.length));

/// What a pairing QR carries (none of it is a credential).
class PairingPayload {
  const PairingPayload({required this.ticket, required this.challengeId, this.sessionId, this.hostName});

  /// iroh EndpointTicket: the host's EndpointId plus its relay and addresses.
  final String ticket;
  final String challengeId;
  final String? sessionId;

  /// Display name for the confirm screen; untrusted until the host answers.
  final String? hostName;

  /// Parse `dshremote://pair?v=2&t=…&c=…[&s=…][&n=…]` with the host's rules (packages/protocol `parsePairingUrl`).
  static PairingPayload? parse(String text) {
    final uri = Uri.tryParse(text.trim());
    if (uri == null || uri.scheme != 'dshremote' || uri.host != 'pair' || uri.path.isNotEmpty || uri.hasFragment || uri.userInfo.isNotEmpty || uri.hasPort) return null;
    final all = uri.queryParametersAll;
    if (all.entries.any((e) => e.value.length != 1 || !const {'v', 't', 'c', 's', 'n'}.contains(e.key))) return null;
    final params = uri.queryParameters;
    if (params['v'] != '2') return null;
    final ticket = params['t'] ?? '';
    final challengeId = params['c'] ?? '';
    final sessionId = params['s'];
    final hostName = params['n'];
    if (!_ticket.hasMatch(ticket) || !RegExp(r'^chl_[A-Za-z0-9_-]{22,64}$').hasMatch(challengeId)) return null;
    if (sessionId != null && !RegExp(r'^[\x21-\x7e]{1,200}$').hasMatch(sessionId)) return null;
    if (hostName != null && (hostName.isEmpty || hostName.runes.length > 64 || RegExp(r'[\x00-\x1f\x7f]').hasMatch(hostName))) return null;
    return PairingPayload(ticket: ticket, challengeId: challengeId, sessionId: sessionId, hostName: hostName);
  }
}

/// Lowercase hex SHA-256 of a base64url SPKI key.
String spkiFingerprint(String spkiBase64Url) => sha256Hex(decodeBase64UrlNoPad(spkiBase64Url));

/// First 16 hex digits in groups of four, as both screens show it.
String shortFingerprint(String fingerprint) {
  final head = fingerprint.substring(0, min(16, fingerprint.length));
  return [for (var i = 0; i < head.length; i += 4) head.substring(i, min(i + 4, head.length))].join(' ');
}
