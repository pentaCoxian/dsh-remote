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
