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

  /// The pipes a pause is still closing: pipes opened after it wait for it.
  Future<void>? _suspending;

  /// Set by a pause, cleared by the first pipe after it.
  bool _paused = false;

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

  /// Unix socket paths are limited to 104 bytes (`sockaddr_un`), and iOS
  /// sandbox paths come close (devices) or go over (simulators). Past the limit
  /// the socket is named relative to [socketDir], made the working directory:
  /// both ends of the socket live in this process, so they resolve it alike.
  String _path(String hostId, {String prefix = 'h'}) {
    final name = '$prefix${hostId.substring(0, 8)}';
    final absolute = '$socketDir/$name';
    if (utf8.encode(absolute).length < 100) return absolute;
    Directory.current = socketDir;
    return name;
  }

  /// The socket for [hostId], dialing [ticket] first when the pipe is not open.
  Future<String> socketFor(String hostId, String Function() ticket) => _shared(() => _open[hostId], (f) => f == null ? _open.remove(hostId) : _open[hostId] = f, () async {
        await start();
        await _resume();
        return (await pipe.open(ticket(), _path(hostId))).socketPath;
      });

  /// Before the first pipe after a pause: wait for its suspend, then have iroh
  /// look at the network again, which may have changed while the app was away.
  Future<void> _resume() async {
    await _suspending;
    if (!_paused) return;
    _paused = false;
    await pipe.networkChanged().catchError((_) {});
  }

  HostLink link(String hostId, String Function() ticket) => HostLink(() => socketFor(hostId, ticket));

  /// A link to the push gateway [ticket] names (its id is [gatewayId]); close it with [close].
  HostLink gatewayLink(String gatewayId, String ticket) => HostLink(() => _shared(() => _open[gatewayId], (f) => f == null ? _open.remove(gatewayId) : _open[gatewayId] = f, () async {
        await start();
        await _resume();
        return (await pipe.openGateway(ticket, _path(gatewayId, prefix: 'g'))).socketPath;
      }));

  /// The local port of [hostId]'s DSH Web tunnel, opening the host's pipe first if needed.
  /// The port is stable per host when free, so DSH Web's browser storage (per origin) survives restarts.
  Future<int> openWeb(String hostId, String Function() ticket) async {
    await socketFor(hostId, ticket);
    return pipe.openWeb(hostId, webPortFor(hostId));
  }

  Future<void> closeWeb(String hostId) async {
    if (_open.containsKey(hostId)) await pipe.closeWeb(hostId).catchError((_) {});
  }

  /// 20000–59999, from the host id.
  static int webPortFor(String hostId) => 20000 + int.parse(hostId.substring(0, 8), radix: 16) % 40000;

  /// Point an open pipe at a newer ticket; a closed one picks it up when it next opens.
  Future<void> refresh(String hostId, String ticket) async {
    if (_open.containsKey(hostId)) await pipe.open(ticket, _path(hostId));
  }

  /// The host a pairing ticket names (no dialing).
  Future<String> hostIdOf(String ticket) => pipe.ticketHostId(ticket);

  /// Whether the host answers now: opens the pipe, or redials it if its
  /// connection dropped (a cached socket alone proves nothing). Throws
  /// [PipeException] when the host cannot be reached.
  Future<PipeStatus> probe(String hostId, String Function() ticket) async {
    final wasOpen = _open.containsKey(hostId);
    await socketFor(hostId, ticket);
    if (wasOpen) await pipe.open(ticket(), _path(hostId));
    return pipe.status(hostId);
  }

  Future<PipeStatus> status(String hostId) async {
    if (_started == null) return const PipeStatus(connected: false, paths: []);
    return pipe.status(hostId);
  }

  Future<void> close(String hostId) async {
    if (_open.remove(hostId) != null) await pipe.close(hostId).catchError((_) {});
  }

  /// Hang up on [hostId] and keep its pipe, for a connection that looks open but
  /// carries nothing: the next request dials a new one.
  Future<void> reconnect(String hostId) async {
    if (_open.containsKey(hostId)) await pipe.reconnect(hostId).catchError((_) {});
  }

  /// The app is going to the background: close every pipe (sockets die there
  /// anyway) and keep the endpoint. The next request reopens its pipe once this
  /// is done; a start still in flight finishes first.
  ///
  /// Not a new endpoint on return: one started while the old one is still
  /// closing (a slow network, a socket the WebView holds) shares its key, the
  /// relay serves the two by turns, and new connections stall for up to a minute.
  Future<void> pause() async {
    _open.clear();
    final started = _started;
    if (started == null) return;
    _paused = true;
    final suspending = started.then((_) {}, onError: (_) {}).then((_) => pipe.suspend()).catchError((_) {});
    _suspending = suspending;
    await suspending;
    if (identical(_suspending, suspending)) _suspending = null;
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
