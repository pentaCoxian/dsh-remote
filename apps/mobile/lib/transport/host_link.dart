import 'dart:io';

/// The way to one host: an `HttpClient` whose every connection is a new socket
/// on that host's pipe, so dio and `WebSocket` run over iroh unchanged. Each
/// socket becomes one QUIC bi-stream to the host.
class HostLink {
  HostLink(this._socketPath) {
    client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 20)
      // Under the host's 5 s keep-alive, so an idle socket is never reused just as the host closes it.
      ..idleTimeout = const Duration(seconds: 4)
      ..connectionFactory = (_, __, ___) async => Socket.startConnect(InternetAddress(await _socketPath(), type: InternetAddressType.unix), 0);
  }

  /// Placeholder origin: the socket already leads to one host, authenticated
  /// by its key, and QUIC encrypts the traffic end to end.
  static final origin = Uri.parse('http://dsh.pipe');

  /// Opens the pipe on first use (and after the app returns from the background).
  final Future<String> Function() _socketPath;

  late final HttpClient client;

  Uri uri(String target) => Uri.parse('$origin$target');

  void close() => client.close(force: true);
}
