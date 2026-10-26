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

/// Signed REST client for one paired host (spec §6), over the host's iroh pipe.
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

  Future<List<Workspace>> workspaces() async => [for (final item in ((await request('GET', '/v1/workspaces')) as Json)['items'] as List) Workspace.fromJson(item as Json)];

  Future<List<SessionSummary>> sessions() async => [for (final item in ((await request('GET', '/v1/sessions')) as Json)['items'] as List) SessionSummary.fromJson(item as Json)];

  Future<SessionSnapshot> snapshot(String sessionId) async => SessionSnapshot.fromJson(await request('GET', '/v1/sessions/${_segment(sessionId)}') as Json);

  Future<PromptReceipt> sendPrompt(String sessionId, String clientRequestId, String text) async =>
      PromptReceipt.fromJson(await request('POST', '/v1/sessions/${_segment(sessionId)}/prompts', body: {'clientRequestId': clientRequestId, 'text': text}) as Json);

  Future<PromptReceipt> receipt(String sessionId, String clientRequestId) async =>
      PromptReceipt.fromJson(await request('GET', '/v1/sessions/${_segment(sessionId)}/prompts/${_segment(clientRequestId)}') as Json);

  Future<void> cancel(String sessionId, String turnId) => request('POST', '/v1/sessions/${_segment(sessionId)}/cancel', body: {'turnId': turnId});

  Future<List<Approval>> approvals() async => [for (final item in ((await request('GET', '/v1/approvals')) as Json)['items'] as List) Approval.fromJson(item as Json)];

  Future<Approval> respond(String approvalId, {required bool allow, required int expectedRevision}) async => Approval.fromJson(
      await request('POST', '/v1/approvals/${_segment(approvalId)}/responses', body: {'decision': allow ? 'allow_once' : 'deny', 'expectedRevision': expectedRevision}) as Json);

  Future<Controller?> acquireLease(String sessionId, {bool takeover = false}) async =>
      Controller.fromJson(((await request('POST', '/v1/sessions/${_segment(sessionId)}/control-lease', body: {'takeover': takeover})) as Json)['holder']);

  Future<void> releaseLease(String sessionId) => request('DELETE', '/v1/sessions/${_segment(sessionId)}/control-lease');

  // Pairing: signed with the new key and device id `pending`.

  Future<Json> redeem({required String challengeId, required String publicKey, required String label, required String platform, required bool hardwareBacked}) async =>
      await request('POST', '/v1/pair/redeem', body: {'challengeId': challengeId, 'publicKey': publicKey, 'deviceLabel': label, 'platform': platform, 'hardwareBacked': hardwareBacked}) as Json;

  Future<Json> pairStatus(String pairingRequestId) async => await request('GET', '/v1/pair/requests/${_segment(pairingRequestId)}') as Json;
}
