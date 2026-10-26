// The phone's iroh transport: apps/mobile/native/dshr_pipe through dart:ffi.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

import 'package:ffi/ffi.dart';

/// A failure reported by the native pipe (bad ticket, unreachable host, …).
class PipeException implements Exception {
  const PipeException(this.message);
  final String message;

  @override
  String toString() => 'PipeException: $message';
}

class PipeHandle {
  const PipeHandle({required this.hostId, required this.socketPath});

  /// The host's EndpointId, which QUIC authenticated.
  final String hostId;
  final String socketPath;
}

class PipePath {
  const PipePath({required this.relay, required this.selected, required this.rttMs});
  final bool relay;
  final bool selected;
  final int rttMs;
}

/// Connection details for the connection sheet.
class PipeStatus {
  const PipeStatus({required this.connected, required this.paths, this.remoteId, this.homeRelay, this.webPort});
  final bool connected;
  final List<PipePath> paths;
  final String? remoteId;

  /// The DSH Web tunnel's local port while it is open.
  final int? webPort;

  /// This phone's own home relay.
  final String? homeRelay;

  PipePath? get selected => paths.where((p) => p.selected).firstOrNull;

  factory PipeStatus.fromJson(Map<String, dynamic> json) => PipeStatus(
        connected: json['connected'] == true,
        remoteId: json['remoteId'] as String?,
        homeRelay: json['homeRelay'] as String?,
        webPort: (json['webPort'] as num?)?.toInt(),
        paths: [
          for (final p in (json['paths'] as List? ?? const []).cast<Map<String, dynamic>>())
            PipePath(relay: p['relay'] == true, selected: p['selected'] == true, rttMs: (p['rttMs'] as num?)?.toInt() ?? 0),
        ],
      );
}

/// One iroh endpoint for the app; one pipe (a Unix socket) per paired host.
abstract interface class IrohPipe {
  /// Start the endpoint with the app's 32-byte iroh key; returns this phone's EndpointId.
  Future<String> start(List<int> secretKey, List<String> relays);

  /// Dial the host a ticket names and serve it on [socketPath]. Opening an open host refreshes its address.
  Future<PipeHandle> open(String ticket, String socketPath);

  Future<void> close(String hostId);

  /// Serve the host's DSH Web tunnel on a 127.0.0.1 port ([preferredPort] when free); the host must be open.
  Future<int> openWeb(String hostId, int preferredPort);

  Future<void> closeWeb(String hostId);
  Future<PipeStatus> status(String hostId);

  /// The EndpointId a ticket names, without dialing.
  Future<String> ticketHostId(String ticket);

  Future<void> networkChanged();

  /// Close every pipe and the endpoint.
  Future<void> stop();
}

typedef _StartC = Pointer<Utf8> Function(Pointer<Uint8>, Size, Pointer<Utf8>);
typedef _StartD = Pointer<Utf8> Function(Pointer<Uint8>, int, Pointer<Utf8>);
typedef _TwoC = Pointer<Utf8> Function(Pointer<Utf8>, Pointer<Utf8>);
typedef _OneC = Pointer<Utf8> Function(Pointer<Utf8>);
typedef _NoneC = Pointer<Utf8> Function();
typedef _WebC = Pointer<Utf8> Function(Pointer<Utf8>, Uint16);
typedef _WebD = Pointer<Utf8> Function(Pointer<Utf8>, int);
typedef _FreeC = Void Function(Pointer<Utf8>);
typedef _FreeD = void Function(Pointer<Utf8>);

DynamicLibrary _library() {
  if (Platform.isAndroid) return DynamicLibrary.open('libdshr_pipe.so');
  if (Platform.isIOS) return DynamicLibrary.open('DshrPipe.framework/DshrPipe');
  // Host-side tests: the cargo build output (native/dshr_pipe/target/…/libdshr_pipe.dylib).
  final path = Platform.environment['DSHR_PIPE_LIB'];
  if (path != null) return DynamicLibrary.open(path);
  throw UnsupportedError('dshr_pipe is built for Android and iOS only (set DSHR_PIPE_LIB for host tests)');
}

/// Runs one native call. The pipe blocks while it dials, so calls never run on the UI isolate.
Map<String, dynamic> _invoke(String name, List<Object> args) {
  final lib = _library();
  final free = lib.lookupFunction<_FreeC, _FreeD>('dshr_string_free');
  return using((arena) {
    Pointer<Utf8> text(Object value) => (value as String).toNativeUtf8(allocator: arena);
    final Pointer<Utf8> reply;
    switch (name) {
      case 'start':
        final key = args[0] as List<int>;
        final bytes = arena<Uint8>(key.length)..asTypedList(key.length).setAll(0, key);
        reply = lib.lookupFunction<_StartC, _StartD>('dshr_start')(bytes, key.length, text(args[1]));
      case 'open':
        reply = lib.lookupFunction<_TwoC, _TwoC>('dshr_open')(text(args[0]), text(args[1]));
      case 'open_web':
        reply = lib.lookupFunction<_WebC, _WebD>('dshr_open_web')(text(args[0]), args[1] as int);
      case 'close' || 'close_web' || 'status' || 'ticket_info':
        reply = lib.lookupFunction<_OneC, _OneC>('dshr_$name')(text(args[0]));
      case 'network_changed' || 'stop':
        reply = lib.lookupFunction<_NoneC, _NoneC>('dshr_$name')();
      default:
        throw ArgumentError(name);
    }
    try {
      return jsonDecode(reply.toDartString()) as Map<String, dynamic>;
    } finally {
      free(reply);
    }
  });
}

class NativeIrohPipe implements IrohPipe {
  const NativeIrohPipe();

  Future<Map<String, dynamic>> _call(String name, [List<Object> args = const []]) async {
    final reply = await Isolate.run(() => _invoke(name, args));
    if (reply['ok'] != true) throw PipeException(reply['error'] as String? ?? 'transport error');
    return reply;
  }

  @override
  Future<String> start(List<int> secretKey, List<String> relays) async => (await _call('start', [secretKey, jsonEncode(relays)]))['endpointId'] as String;

  @override
  Future<PipeHandle> open(String ticket, String socketPath) async {
    final reply = await _call('open', [ticket, socketPath]);
    return PipeHandle(hostId: reply['hostId'] as String, socketPath: reply['socketPath'] as String);
  }

  @override
  Future<void> close(String hostId) => _call('close', [hostId]);

  @override
  Future<int> openWeb(String hostId, int preferredPort) async => ((await _call('open_web', [hostId, preferredPort]))['port'] as num).toInt();

  @override
  Future<void> closeWeb(String hostId) => _call('close_web', [hostId]);

  @override
  Future<PipeStatus> status(String hostId) async => PipeStatus.fromJson(await _call('status', [hostId]));

  @override
  Future<String> ticketHostId(String ticket) async => (await _call('ticket_info', [ticket]))['endpointId'] as String;

  @override
  Future<void> networkChanged() => _call('network_changed');

  @override
  Future<void> stop() => _call('stop');
}
