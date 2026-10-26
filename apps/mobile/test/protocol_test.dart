import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/core/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

/// Vectors shared with packages/protocol (Node); regenerate with `pnpm --filter @dsh-remote/protocol vectors`.
Map<String, dynamic> vector(String name) => jsonDecode(File('../../protocol/vectors/$name.json').readAsStringSync()) as Map<String, dynamic>;

void main() {
  group('canonical request string', () {
    final signing = vector('signing');
    for (final request in (signing['requests'] as List).cast<Map<String, dynamic>>()) {
      test('${request['method']} ${request['target']}', () {
        final body = utf8.encode(request['body'] as String);
        expect(sha256Hex(body), request['bodySha256Hex']);
        final canonical = canonicalRequestString(
          method: request['method'] as String,
          target: request['target'] as String,
          bodySha256Hex: request['bodySha256Hex'] as String,
          timestampMs: request['timestampMs'] as int,
          nonce: request['nonce'] as String,
        );
        expect(canonical, request['canonical']);
        expect(canonical.endsWith('\n'), isFalse);
      });
    }

    test('reproduces the vector key fingerprint', () {
      final key = signing['key'] as Map<String, dynamic>;
      expect(spkiFingerprint(key['spki'] as String), key['fingerprint']);
    });

    test('refuses lowercase methods and absolute targets', () {
      expect(() => canonicalRequestString(method: 'get', target: '/v1/meta', bodySha256Hex: '', timestampMs: 1, nonce: 'n'), throwsArgumentError);
      expect(() => canonicalRequestString(method: 'GET', target: 'https://x/v1', bodySha256Hex: '', timestampMs: 1, nonce: 'n'), throwsArgumentError);
    });
  });

  group('cursor', () {
    final cursors = vector('cursor');
    for (final valid in (cursors['valid'] as List).cast<Map<String, dynamic>>()) {
      test('decodes ${valid['cursor']}', () {
        final cursor = Cursor.decode(valid['cursor'] as String)!;
        expect(cursor.sessionId, valid['sessionId']);
        expect(cursor.seq, valid['seq']);
      });
    }
    for (final invalid in (cursors['invalid'] as List).cast<String>()) {
      test('rejects ${jsonEncode(invalid)}', () => expect(Cursor.decode(invalid), isNull));
    }
  });

  group('pairing QR v2', () {
    final pairing = vector('pairing');
    for (final valid in (pairing['valid'] as List).cast<Map<String, dynamic>>()) {
      test('parses ${(valid['url'] as String).substring(0, 40)}…', () {
        final payload = PairingPayload.parse(valid['url'] as String)!;
        final expected = valid['payload'] as Map<String, dynamic>;
        expect(payload.ticket, expected['ticket']);
        expect(payload.challengeId, expected['challengeId']);
        expect(payload.sessionId, expected['sessionId']);
        expect(payload.hostName, expected['hostName']);
      });
    }
    for (final invalid in (pairing['invalid'] as List).cast<String>()) {
      test('rejects ${invalid.length > 60 ? '${invalid.substring(0, 60)}…' : invalid}', () => expect(PairingPayload.parse(invalid), isNull));
    }
    test('names hosts by their EndpointId', () {
      final id = (pairing['ticket'] as Map<String, dynamic>)['endpointId'] as String;
      expect(isEndpointId(id), isTrue);
      expect(isEndpointId('host_TESTtestTESTtest01'), isFalse);
      expect(shortHostId(id), id.substring(0, 10));
    });
  });

  test('short fingerprint groups the first 16 digits', () {
    expect(shortFingerprint('0123456789abcdef0123'), '0123 4567 89ab cdef');
  });
}
