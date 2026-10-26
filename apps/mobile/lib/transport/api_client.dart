import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import '../core/errors.dart';
import '../core/models.dart';
import 'host_link.dart';
import 'iroh_pipe.dart';
import 'signer.dart';

final _pathId = RegExp(r'^[A-Za-z0-9_.~-]{1,200}$');

String _segment(String id) {
  if (!_pathId.hasMatch(id)) throw const ApiException(status: 0, code: 'BAD_REQUEST', message: 'invalid identifier');
  return id;
}

/// Signed REST client for one paired host over its iroh pipe: pairing, host
/// facts, and opening the DSH Web tunnel. DSH itself runs in the WebView.
class HostApi {
  HostApi({required this.link, required this.signer})
      : _dio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 20), sendTimeout: const Duration(seconds: 15), receiveTimeout: const Duration(seconds: 20)))
          ..httpClientAdapter = IOHttpClientAdapter(createHttpClient: () => link.client);

  final HostLink link;
  final RequestSigner signer;
  final Dio _dio;

  /// One signed request. Exact body bytes are signed and sent; never re-serialized.
  Future<dynamic> request(String method, String target, {Object? body}) async {
    final bytes = body == null ? const <int>[] : utf8.encode(jsonEncode(body));
    var skewRetried = false;
    while (true) {
      final headers = {
        ...await signer.headers(method, target, bytes),
        'accept': 'application/json',
        if (bytes.isNotEmpty) 'content-type': 'application/json',
        if (bytes.isNotEmpty) 'content-length': '${bytes.length}',
      };
      final Response<String> response;
      try {
        response = await _dio.requestUri<String>(
          link.uri(target),
          data: bytes.isEmpty ? null : Stream<List<int>>.value(bytes),
          options: Options(method: method, headers: headers, responseType: ResponseType.plain, validateStatus: (_) => true, followRedirects: false),
        );
      } on DioException catch (error) {
        // The pipe could not dial the host: the request never left the phone.
        if (error.error is PipeException) throw ApiException(status: 0, code: 'UNREACHABLE', message: (error.error as PipeException).message, retryable: true);
        final timeout = error.type == DioExceptionType.receiveTimeout || error.type == DioExceptionType.sendTimeout;
        throw ApiException(status: 0, code: timeout ? 'TIMEOUT' : 'NETWORK', message: 'host unreachable', retryable: true);
      }
      final status = response.statusCode ?? 0;
      final text = response.data ?? '';
      dynamic json;
      try {
        json = text.isEmpty ? null : jsonDecode(text);
      } catch (_) {
        json = null;
      }
      if (status >= 200 && status < 300) return json;
      final envelope = json is Map ? json['error'] : null;
      if (envelope is Map) {
        final error = ApiException(
          status: status,
          code: envelope['code'] as String? ?? 'INTERNAL',
          message: envelope['message'] as String? ?? 'request failed',
          retryable: envelope['retryable'] as bool? ?? false,
          serverTime: envelope['serverTime'] as int?,
        );
        if (error.code == 'TIMESTAMP_SKEW' && error.serverTime != null && !skewRetried) {
          signer.learnServerTime(error.serverTime!);
          skewRetried = true;
          continue;
        }
        throw error;
      }
      throw ApiException(status: status, code: 'UNAVAILABLE', message: 'home lab unavailable', retryable: true);
    }
  }

  Future<HostMeta> meta() async => HostMeta.fromJson(await request('GET', '/v1/meta') as Json);

  /// Where the host is reachable now: a fresher ticket than the one stored at pairing.
  Future<({String ticket, String? relayUrl})> hostAddress() async {
    final json = await request('GET', '/v1/host/address') as Json;
    return (ticket: json['ticket'] as String, relayUrl: json['relayUrl'] as String?);
  }

  /// Open this phone's DSH Web window (signed by the hardware key); returns DSH's launch-token query,
  /// and whether the host's DSH Web has its phone layout (dsh-mobile-maxxing; null from older hosts).
  Future<({String tokenQuery, DateTime expiresAt, bool? phoneLayout})> webSession() async {
    final json = await request('POST', '/v1/web/session') as Json;
    final layout = json['mobileUi'];
    return (
      tokenQuery: json['tokenQuery'] as String,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(json['expiresAt'] as int),
      phoneLayout: layout is Map ? layout['ok'] == true : null,
    );
  }

  // Notifications: the phone tells the host where and how to reach it.

  Future<PushStatus> pushStatus() async => PushStatus.fromJson(await request('GET', '/v1/push') as Json);

  /// [gateway] is the gateway's EndpointId, [key] the base64url 32-byte key only this phone and the host hold.
  Future<PushStatus> registerPush({required String gateway, required String handle, required String key, required String platform, required PushEvents events}) async =>
      PushStatus.fromJson(await request('PUT', '/v1/push', body: {'gateway': gateway, 'handle': handle, 'key': key, 'platform': platform, 'events': events.toJson()}) as Json);

  Future<PushStatus> unregisterPush() async => PushStatus.fromJson(await request('DELETE', '/v1/push') as Json);

  /// Ask the host to send a test notification through its gateway.
  Future<void> testPush() => request('POST', '/v1/push/test');

  // Pairing: signed with the new key and device id `pending`.

  Future<Json> redeem({required String challengeId, required String publicKey, required String label, required String platform, required bool hardwareBacked}) async =>
      await request('POST', '/v1/pair/redeem', body: {'challengeId': challengeId, 'publicKey': publicKey, 'deviceLabel': label, 'platform': platform, 'hardwareBacked': hardwareBacked}) as Json;

  Future<Json> pairStatus(String pairingRequestId) async => await request('GET', '/v1/pair/requests/${_segment(pairingRequestId)}') as Json;
}
