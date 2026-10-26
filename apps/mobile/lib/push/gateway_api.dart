import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import '../core/errors.dart';
import '../transport/host_link.dart';
import '../transport/iroh_pipe.dart';

final _handle = RegExp(r'^[A-Za-z0-9_-]{22}$');

/// The push gateway's API over its iroh pipe. Unsigned: the gateway knows this
/// phone by its iroh key, which QUIC proves, and binds each handle to it and to
/// one host. Only the device token goes there, never a host's key.
class GatewayApi {
  GatewayApi(this.link)
      : _dio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 20), sendTimeout: const Duration(seconds: 15), receiveTimeout: const Duration(seconds: 20)))
          ..httpClientAdapter = IOHttpClientAdapter(createHttpClient: () => link.client);

  final HostLink link;
  final Dio _dio;

  /// Deliver pushes from [hostId] to this device token; the same phone and host keep their handle.
  Future<String> register({required String platform, required String token, String? apnsEnvironment, required String hostId}) async {
    final json = await _request('POST', '/v1/handles', {'platform': platform, 'token': token, if (apnsEnvironment != null) 'apnsEnvironment': apnsEnvironment, 'host': hostId});
    final handle = (json as Map)['handle'];
    if (handle is! String || !_handle.hasMatch(handle)) throw const ApiException(status: 0, code: 'INTERNAL', message: 'the push gateway sent no handle');
    return handle;
  }

  Future<void> unregister(String handle) async {
    if (_handle.hasMatch(handle)) await _request('DELETE', '/v1/handles/$handle', null);
  }

  void close() => link.close();

  Future<dynamic> _request(String method, String target, Object? body) async {
    final bytes = body == null ? null : utf8.encode(jsonEncode(body));
    final Response<String> response;
    try {
      response = await _dio.requestUri<String>(
        link.uri(target),
        data: bytes == null ? null : Stream<List<int>>.value(bytes),
        options: Options(
          method: method,
          headers: {'accept': 'application/json', if (bytes != null) 'content-type': 'application/json', if (bytes != null) 'content-length': '${bytes.length}'},
          responseType: ResponseType.plain,
          validateStatus: (_) => true,
        ),
      );
    } on DioException catch (error) {
      if (error.error is PipeException) throw ApiException(status: 0, code: 'UNREACHABLE', message: (error.error as PipeException).message, retryable: true);
      throw const ApiException(status: 0, code: 'NETWORK', message: 'push gateway unreachable', retryable: true);
    }
    final status = response.statusCode ?? 0;
    final text = response.data ?? '';
    final json = text.isEmpty ? null : jsonDecode(text);
    if (status >= 200 && status < 300) return json;
    final envelope = json is Map ? json['error'] : null;
    throw ApiException(
      status: status,
      code: envelope is Map ? envelope['code'] as String? ?? 'INTERNAL' : 'UNAVAILABLE',
      message: envelope is Map ? envelope['message'] as String? ?? 'request failed' : 'push gateway unavailable',
      retryable: envelope is Map && envelope['retryable'] == true,
    );
  }
}
