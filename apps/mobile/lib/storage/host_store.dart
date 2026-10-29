import 'dart:convert';

import 'secure_store.dart';

/// A host this phone paired with. Holds no secret: the request key stays in
/// the keystore under [keyAlias], and the phone's iroh key is stored once per
/// install (see `PipeManager`).
class PairedHost {
  const PairedHost({
    required this.hostId,
    required this.ticket,
    required this.name,
    required this.deviceId,
    required this.keyAlias,
    required this.devicePublicKey,
    required this.hardwareBacked,
    required this.pairedAt,
    this.lastSessionId,
    this.revoked = false,
  });

  /// The host's iroh EndpointId; QUIC proves it on every connection.
  final String hostId;

  /// Latest known EndpointTicket (from the QR, refreshed from `/v1/host/address`).
  final String ticket;
  final String name;
  final String deviceId;
  final String keyAlias;
  final String devicePublicKey;
  final bool hardwareBacked;
  final DateTime pairedAt;
  final String? lastSessionId;

  /// The host refused this phone (revoked or unpaired) when last asked; it
  /// stays listed so the user sees why, and opening it asks the host again.
  final bool revoked;

  PairedHost copyWith({String? name, String? ticket, String? lastSessionId, bool? revoked}) => PairedHost(
        hostId: hostId,
        ticket: ticket ?? this.ticket,
        name: name ?? this.name,
        deviceId: deviceId,
        keyAlias: keyAlias,
        devicePublicKey: devicePublicKey,
        hardwareBacked: hardwareBacked,
        pairedAt: pairedAt,
        lastSessionId: lastSessionId ?? this.lastSessionId,
        revoked: revoked ?? this.revoked,
      );

  Map<String, dynamic> toJson() => {
        'hostId': hostId,
        'ticket': ticket,
        'name': name,
        'deviceId': deviceId,
        'keyAlias': keyAlias,
        'devicePublicKey': devicePublicKey,
        'hardwareBacked': hardwareBacked,
        'pairedAt': pairedAt.millisecondsSinceEpoch,
        if (lastSessionId != null) 'lastSessionId': lastSessionId,
        'revoked': revoked,
      };

  factory PairedHost.fromJson(Map<String, dynamic> json) => PairedHost(
        hostId: json['hostId'] as String,
        ticket: json['ticket'] as String,
        name: json['name'] as String,
        deviceId: json['deviceId'] as String,
        keyAlias: json['keyAlias'] as String,
        devicePublicKey: json['devicePublicKey'] as String,
        hardwareBacked: json['hardwareBacked'] as bool? ?? false,
        pairedAt: DateTime.fromMillisecondsSinceEpoch(json['pairedAt'] as int),
        lastSessionId: json['lastSessionId'] as String?,
        revoked: json['revoked'] as bool? ?? false,
      );
}

/// Paired hosts. Version 1 held Cloudflare-era hosts, which cannot connect over
/// iroh; they are not read (pair again).
class HostStore {
  HostStore(this._store);
  final SecureStore _store;
  static const _key = 'dsh_remote.hosts.v2';

  Future<List<PairedHost>> load() async {
    final text = await _store.read(_key);
    if (text == null) return [];
    return [for (final item in jsonDecode(text) as List) PairedHost.fromJson(item as Map<String, dynamic>)];
  }

  Future<void> save(List<PairedHost> hosts) => _store.write(_key, jsonEncode([for (final host in hosts) host.toJson()]));
}
