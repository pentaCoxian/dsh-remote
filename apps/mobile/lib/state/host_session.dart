import '../device_keys/device_keys.dart';
import '../storage/host_store.dart';
import '../transport/api_client.dart';
import '../transport/events_client.dart';
import '../transport/host_link.dart';
import '../transport/signer.dart';

/// Everything needed to talk to one paired host, plus frame routing to the
/// screens that are currently interested in a session or in host-wide events.
class HostSession {
  HostSession({required this.host, required this.link, required DeviceKeys keys, required void Function(LinkState) onLink}) {
    signer = RequestSigner(keys: keys, keyAlias: host.keyAlias, deviceId: host.deviceId);
    api = HostApi(link: link, signer: signer);
    events = EventsConnection(link: link, signer: signer, api: api, onFrame: _route, onState: onLink);
  }

  final PairedHost host;
  final HostLink link;
  late final RequestSigner signer;
  late final HostApi api;
  late final EventsConnection events;

  final Map<String, Set<FrameHandler>> _sessionListeners = {};
  final Set<FrameHandler> _hostListeners = {};

  /// Frames for one session (events and session-scoped control frames).
  void Function() listenSession(String sessionId, FrameHandler handler) {
    (_sessionListeners[sessionId] ??= {}).add(handler);
    return () => _sessionListeners[sessionId]?.remove(handler);
  }

  /// Host-wide control frames (approvals, lease, host status).
  void Function() listenHost(FrameHandler handler) {
    _hostListeners.add(handler);
    return () => _hostListeners.remove(handler);
  }

  void _route(Map<String, dynamic> frame) {
    final sessionId = frame['sessionId'] as String?;
    if (sessionId != null) {
      for (final handler in [...?_sessionListeners[sessionId]]) {
        handler(frame);
      }
    }
    if (frame['type'] == 'control') {
      for (final handler in [..._hostListeners]) {
        handler(frame);
      }
    }
  }

  void dispose() {
    events.dispose();
    link.close();
  }
}
