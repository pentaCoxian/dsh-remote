import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/errors.dart';
import '../core/models.dart';
import '../state/host_session.dart';
import '../state/pipe_manager.dart';
import '../state/providers.dart';
import '../storage/secure_store.dart';
import 'gateway_api.dart';
import 'push_native.dart';

enum PushAvailability {
  /// Registered: the host notifies this phone through its gateway.
  on,

  /// Turned off on this phone for this host.
  off,

  /// The host has no push gateway configured.
  hostOff,

  /// The OS does not allow this app's notifications.
  notAllowed,

  /// This build has no push service (Android without a Firebase config).
  unavailable,
}

class PushState {
  const PushState(this.availability, {this.events = const PushEvents()});
  final PushAvailability availability;
  final PushEvents events;
}

/// What this phone remembers about one host's notifications.
class _Local {
  const _Local({this.gatewayTicket, this.gatewayId, this.handle, this.token, this.events = const PushEvents(), this.disabled = false, this.asked = false});
  final String? gatewayTicket;
  final String? gatewayId;
  final String? handle;
  final String? token;
  final PushEvents events;
  final bool disabled;

  /// The OS permission prompt was shown once already.
  final bool asked;

  factory _Local.fromJson(Json json) => _Local(
        gatewayTicket: json['gatewayTicket'] as String?,
        gatewayId: json['gatewayId'] as String?,
        handle: json['handle'] as String?,
        token: json['token'] as String?,
        events: PushEvents.fromJson((json['events'] as Map?)?.cast<String, dynamic>() ?? const {}),
        disabled: json['disabled'] == true,
        asked: json['asked'] == true,
      );

  Json toJson() => {'gatewayTicket': gatewayTicket, 'gatewayId': gatewayId, 'handle': handle, 'token': token, 'events': events.toJson(), 'disabled': disabled, 'asked': asked};
}

/// Keeps each paired host able to notify this phone.
///
/// The phone registers its device token with the host's push gateway (the
/// host never sees the token), gets a handle back, makes a fresh key natively,
/// and gives the host the handle and key over the signed tunnel. The host seals
/// every notification with that key; the gateway, Apple and Google see only
/// ciphertext.
class PushRegistrar {
  PushRegistrar({required this.native, required this.pipes, required this.store});

  final PushNative native;
  final PipeManager pipes;
  final SecureStore store;

  /// One registration change per host at a time: the app reconnecting while
  /// the permission prompt closes must not mint a second key that races the first.
  final Map<String, Future<void>> _queues = {};

  Future<T> _serial<T>(String hostId, Future<T> Function() run) {
    final next = (_queues[hostId] ?? Future<void>.value()).then((_) => run());
    _queues[hostId] = next.then((_) {}, onError: (_) {});
    return next;
  }

  static String _name(String hostId) => 'dsh_remote.push.$hostId.v1';

  Future<_Local> _load(String hostId) async {
    final text = await store.read(_name(hostId));
    return text == null ? const _Local() : _Local.fromJson(jsonDecode(text) as Json);
  }

  Future<void> _save(String hostId, _Local local) => store.write(_name(hostId), jsonEncode(local.toJson()));

  /// Bring [session]'s registration up to date and report it. Does nothing
  /// visible unless asked: [enable] turns it back on after [disable], [events]
  /// changes what notifies, and [ask] may show the OS permission prompt (once).
  Future<PushState> sync(HostSession session, {bool enable = false, PushEvents? events, bool ask = false}) =>
      _serial(session.host.hostId, () => _sync(session, enable: enable, events: events, ask: ask));

  Future<PushState> _sync(HostSession session, {required bool enable, required PushEvents? events, required bool ask}) async {
    final hostId = session.host.hostId;
    var local = await _load(hostId);
    if (local.disabled && !enable) return PushState(PushAvailability.off, events: local.events);

    final status = await session.api.pushStatus();
    final gatewayTicket = status.gateway;
    if (gatewayTicket == null) return PushState(PushAvailability.hostOff, events: status.events);
    final platform = await native.platform();
    if (platform == null) return PushState(PushAvailability.unavailable, events: status.events);
    if (!await native.permitted()) {
      if (!(ask || enable) || (local.asked && !enable)) return PushState(PushAvailability.notAllowed, events: status.events);
      local = _Local.fromJson({...local.toJson(), 'asked': true});
      await _save(hostId, local);
      if (!await native.requestPermission()) return PushState(PushAvailability.notAllowed, events: status.events);
    }

    final wanted = events ?? (local.handle == null ? status.events : local.events);
    final token = await native.token();
    final gatewayId = await pipes.hostIdOf(gatewayTicket);
    final current = status.registered && local.gatewayId == gatewayId && local.handle != null && local.token == token.token && local.events == wanted && !local.disabled;
    if (current) return PushState(PushAvailability.on, events: wanted);

    final gateway = GatewayApi(pipes.gatewayLink(gatewayId, gatewayTicket));
    final String handle;
    try {
      handle = await gateway.register(platform: platform, token: token.token, apnsEnvironment: token.environment, hostId: hostId);
    } finally {
      gateway.close();
      await pipes.close(gatewayId);
    }
    final key = await native.newKey(handle: handle, hostId: hostId);
    final result = await session.api.registerPush(gateway: gatewayId, handle: handle, key: key, platform: platform, events: wanted);
    await _save(hostId, _Local(gatewayTicket: gatewayTicket, gatewayId: gatewayId, handle: handle, token: token.token, events: result.events, asked: local.asked));
    return PushState(PushAvailability.on, events: result.events);
  }

  /// Stop this host's notifications to this phone, and remember the choice.
  Future<PushState> disable(HostSession session) => _serial(session.host.hostId, () async {
        final hostId = session.host.hostId;
        final local = await _load(hostId);
        await session.api.unregisterPush();
        await _drop(local);
        await _save(hostId, _Local(events: local.events, disabled: true, asked: local.asked));
        return PushState(PushAvailability.off, events: local.events);
      });

  /// The host was forgotten on this phone: drop its handle and key, best effort.
  Future<void> forget(String hostId) => _serial(hostId, () async {
        await _drop(await _load(hostId)).catchError((_) {});
        await store.delete(_name(hostId));
      });

  Future<void> _drop(_Local local) async {
    final handle = local.handle;
    if (handle == null) return;
    await native.deleteKey(handle).catchError((_) {});
    final ticket = local.gatewayTicket;
    final gatewayId = local.gatewayId;
    if (ticket == null || gatewayId == null) return;
    final gateway = GatewayApi(pipes.gatewayLink(gatewayId, ticket));
    try {
      await gateway.unregister(handle);
    } on ApiException {
      // The gateway forgets idle handles by itself.
    } on PlatformException {
      // Likewise.
    } finally {
      gateway.close();
      await pipes.close(gatewayId);
    }
  }
}

final pushRegistrarProvider = Provider<PushRegistrar>((ref) => PushRegistrar(native: const PushNative(), pipes: ref.watch(pipeManagerProvider), store: ref.watch(secureStoreProvider)));
