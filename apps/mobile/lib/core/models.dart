typedef Json = Map<String, dynamic>;

T _as<T>(Object? value, T fallback) => value is T ? value : fallback;

/// `GET /v1/meta`: who the host is and what this device may do there.
class HostMeta {
  const HostMeta({required this.hostId, required this.hostName, required this.deviceId, required this.scopes, required this.serverTime});
  final String hostId;
  final String hostName;
  final String deviceId;
  final List<String> scopes;
  final int serverTime;

  factory HostMeta.fromJson(Json json) {
    final device = _as<Json>(json['device'], const {});
    return HostMeta(
      hostId: _as(json['hostId'], ''),
      hostName: _as(json['hostName'], 'Host'),
      deviceId: _as(device['deviceId'], ''),
      scopes: [for (final scope in _as<List<dynamic>>(device['scopes'], const [])) if (scope is String) scope],
      serverTime: _as(json['serverTime'], 0),
    );
  }
}

/// Which host events notify this phone (`/v1/push`). Approvals by default; turns are opt-in.
class PushEvents {
  const PushEvents({this.approval = true, this.turnFinished = false, this.turnFailed = false});
  final bool approval;
  final bool turnFinished;
  final bool turnFailed;

  factory PushEvents.fromJson(Json json) =>
      PushEvents(approval: _as(json['approval'], true), turnFinished: _as(json['turnFinished'], false), turnFailed: _as(json['turnFailed'], false));

  Json toJson() => {'approval': approval, 'turnFinished': turnFinished, 'turnFailed': turnFailed};

  PushEvents copyWith({bool? approval, bool? turnFinished, bool? turnFailed}) =>
      PushEvents(approval: approval ?? this.approval, turnFinished: turnFinished ?? this.turnFinished, turnFailed: turnFailed ?? this.turnFailed);

  @override
  bool operator ==(Object other) => other is PushEvents && other.approval == approval && other.turnFinished == turnFinished && other.turnFailed == turnFailed;

  @override
  int get hashCode => Object.hash(approval, turnFinished, turnFailed);
}

/// `/v1/push`: the host's push gateway ticket (null: notifications are off on the host) and this phone's registration.
class PushStatus {
  const PushStatus({required this.gateway, required this.registered, required this.events});
  final String? gateway;
  final bool registered;
  final PushEvents events;

  factory PushStatus.fromJson(Json json) =>
      PushStatus(gateway: json['gateway'] as String?, registered: _as(json['registered'], false), events: PushEvents.fromJson(_as<Json>(json['events'], const {})));
}
