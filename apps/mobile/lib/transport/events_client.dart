import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../core/errors.dart';
import '../core/protocol.dart';
import 'api_client.dart';
import 'host_link.dart';
import 'signer.dart';

/// Connection state shown in the UI (spec §4 connection states).
enum LinkState { connecting, online, reconnecting, offline, revoked, outdated }

typedef FrameHandler = void Function(Map<String, dynamic> frame);

/// `/v1/events` for one host over its pipe: signed upgrade, per-session subscriptions
/// resumed from their cursors, heartbeat watchdog, backoff with jitter.
/// Read-only by design; every mutation goes through signed REST.
class EventsConnection {
  EventsConnection({required this.link, required this.signer, required this.api, required this.onFrame, required this.onState});

  final HostLink link;
  final RequestSigner signer;
  final HostApi api;
  final FrameHandler onFrame;
  final void Function(LinkState state) onState;

  final Map<String, String?> _cursors = {};
  final Random _random = Random();
  WebSocket? _socket;
  Timer? _retry;
  Timer? _watchdog;
  int _attempt = 0;
  bool _stopped = true;
  bool _connecting = false;
  int _heartbeatMs = 25000;
  LinkState _state = LinkState.offline;

  LinkState get state => _state;

  void _set(LinkState state) {
    _state = state;
    onState(state);
  }

  /// Start (or resume after the app returns to the foreground).
  void start() {
    _stopped = false;
    _retry?.cancel();
    if (_socket == null && !_connecting) unawaited(_connect());
  }

  /// Stop while backgrounded; the OS would suspend the socket anyway.
  void stop() {
    _stopped = true;
    _retry?.cancel();
    _watchdog?.cancel();
    _socket?.close(1000, 'paused');
    _socket = null;
  }

  void subscribe(String sessionId, {String? after}) {
    _cursors[sessionId] = after;
    _send({'op': 'subscribe', 'sessionId': sessionId, if (after != null) 'after': after});
  }

  void unsubscribe(String sessionId) {
    _cursors.remove(sessionId);
    _send({'op': 'unsubscribe', 'sessionId': sessionId});
  }

  /// Remember the last applied cursor so a reconnect resumes exactly there.
  void advance(String sessionId, String cursor) {
    if (_cursors.containsKey(sessionId)) _cursors[sessionId] = cursor;
  }

  void _send(Map<String, dynamic> frame) {
    final socket = _socket;
    if (socket != null && socket.readyState == WebSocket.open) socket.add(jsonEncode(frame));
  }

  Future<void> _connect() async {
    _connecting = true;
    _set(_attempt == 0 ? LinkState.connecting : LinkState.reconnecting);
    try {
      final url = link.uri('/v1/events').replace(scheme: 'ws');
      final headers = await signer.headers('GET', '/v1/events', const []);
      final socket = await WebSocket.connect(url.toString(), headers: headers, customClient: link.client).timeout(const Duration(seconds: 25));
      if (_stopped) {
        await socket.close(1000);
        return;
      }
      socket.pingInterval = const Duration(seconds: 20);
      _socket = socket;
      _kick();
      socket.listen(_receive, onDone: () => _closed(socket.closeCode), onError: (_) => _closed(socket.closeCode), cancelOnError: true);
    } catch (error) {
      await _diagnose(error);
    } finally {
      _connecting = false;
    }
  }

  void _receive(dynamic data) {
    _kick();
    if (data is! String) return;
    final Map<String, dynamic> frame;
    try {
      frame = jsonDecode(data) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    if (frame['type'] == 'control' && frame['kind'] == 'hello') {
      final payload = frame['payload'] as Map<String, dynamic>? ?? const {};
      if (payload['serverTime'] is int) signer.learnServerTime(payload['serverTime'] as int);
      if (payload['heartbeatMs'] is int) _heartbeatMs = payload['heartbeatMs'] as int;
      _attempt = 0;
      _set(LinkState.online);
      for (final entry in _cursors.entries) {
        _send({'op': 'subscribe', 'sessionId': entry.key, if (entry.value != null) 'after': entry.value});
      }
    }
    onFrame(frame);
  }

  /// Two silent heartbeat intervals mean the path is dead even if TCP is not.
  void _kick() {
    _watchdog?.cancel();
    _watchdog = Timer(Duration(milliseconds: _heartbeatMs * 2 + 5000), () => _socket?.close(4000, 'watchdog'));
  }

  Future<void> _closed(int? code) async {
    _watchdog?.cancel();
    _socket = null;
    if (_stopped) return;
    switch (code) {
      case CloseCodes.deviceRevoked:
        _set(LinkState.revoked);
        return;
      case CloseCodes.protocolUnsupported:
        _set(LinkState.outdated);
        return;
    }
    _schedule();
  }

  /// The upgrade failed without a status we can read: ask REST what is wrong.
  Future<void> _diagnose(Object error) async {
    try {
      await api.meta();
    } on ApiException catch (failure) {
      if (failure.deviceGone) return _set(LinkState.revoked);
      if (failure.code == 'PROTOCOL_UNSUPPORTED') return _set(LinkState.outdated);
    } catch (_) {
      // Network still down; keep retrying.
    }
    _schedule();
  }

  void _schedule() {
    if (_stopped) return;
    _attempt += 1;
    _set(_attempt > 6 ? LinkState.offline : LinkState.reconnecting);
    final base = min(30000, 500 * pow(2, min(_attempt, 10)).toInt());
    final delay = Duration(milliseconds: (base * (0.5 + _random.nextDouble())).round());
    _retry?.cancel();
    _retry = Timer(delay, () => unawaited(_connect()));
  }

  void dispose() => stop();
}
