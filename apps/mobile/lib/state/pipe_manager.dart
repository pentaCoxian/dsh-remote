import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../config.dart';
import '../storage/secure_store.dart';
import '../transport/host_link.dart';
import '../transport/iroh_pipe.dart';

/// The phone's one iroh endpoint and a pipe per host, opened on first use.
///
/// The iroh key is per install: hosts bind grants to it (and to the hardware
/// request key), so it never leaves secure storage. It is a software key
/// because Secure Enclave / StrongBox keys cannot be Ed25519.
class PipeManager {
  PipeManager({required this.pipe, required this.store, List<String>? relays, String? socketDir})
      : relays = relays ?? AppConfig.relays,
        socketDir = socketDir ?? Directory.systemTemp.path;

  final IrohPipe pipe;
  final SecureStore store;
  final List<String> relays;

  /// Inside the app sandbox: no other app can reach the sockets.
  final String socketDir;

  static const _keyName = 'dsh_remote.iroh_key.v1';

  Future<String>? _started;
  final Map<String, Future<String>> _open = {};

  /// This phone's EndpointId, starting the endpoint on first use.
  Future<String> start() => _shared(() => _started, (f) => _started = f, _start);

  Future<String> _start() async {
    var encoded = await store.read(_keyName);
    if (encoded == null) {
      final random = Random.secure();
      encoded = base64Encode(List<int>.generate(32, (_) => random.nextInt(256)));
      await store.write(_keyName, encoded);
    }
    return pipe.start(base64Decode(encoded), relays);
  }

  /// Short, because Unix socket paths are limited to ~104 bytes and iOS sandbox paths are long.
  String _path(String hostId) => '$socketDir/h${hostId.substring(0, 8)}';

  /// The socket for [hostId], dialing [ticket] first when the pipe is not open.
  Future<String> socketFor(String hostId, String Function() ticket) => _shared(() => _open[hostId], (f) => f == null ? _open.remove(hostId) : _open[hostId] = f, () async {
        await start();
        return (await pipe.open(ticket(), _path(hostId))).socketPath;
      });

  HostLink link(String hostId, String Function() ticket) => HostLink(() => socketFor(hostId, ticket));

  /// Point an open pipe at a newer ticket; a closed one picks it up when it next opens.
  Future<void> refresh(String hostId, String ticket) async {
    if (_open.containsKey(hostId)) await pipe.open(ticket, _path(hostId));
  }

  /// The host a pairing ticket names (no dialing).
  Future<String> hostIdOf(String ticket) => pipe.ticketHostId(ticket);

  Future<PipeStatus> status(String hostId) async {
    if (_started == null) return const PipeStatus(connected: false, paths: []);
    return pipe.status(hostId);
  }

  Future<void> close(String hostId) async {
    if (_open.remove(hostId) != null) await pipe.close(hostId).catchError((_) {});
  }

  /// The app is going to the background: close the endpoint (sockets die there
  /// anyway). The next request starts it again and reopens its pipe.
  Future<void> pause() async {
    final started = _started;
    _started = null;
    _open.clear();
    if (started != null) await pipe.stop().catchError((_) {});
  }

  Future<void> networkChanged() async {
    if (_started != null) await pipe.networkChanged().catchError((_) {});
  }

  /// One in-flight future per slot, shared by concurrent callers and cleared on failure so the next call retries.
  static Future<String> _shared(Future<String>? Function() get, void Function(Future<String>?) set, Future<String> Function() run) async {
    final existing = get();
    if (existing != null) return existing;
    final future = run();
    set(future);
    try {
      return await future;
    } catch (_) {
      if (identical(get(), future)) set(null);
      rethrow;
    }
  }
}
