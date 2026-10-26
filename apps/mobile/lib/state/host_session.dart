import '../device_keys/device_keys.dart';
import '../storage/host_store.dart';
import '../transport/api_client.dart';
import '../transport/host_link.dart';
import '../transport/signer.dart';

/// The signed API of one paired host, over its pipe.
class HostSession {
  HostSession({required this.host, required this.link, required DeviceKeys keys}) {
    signer = RequestSigner(keys: keys, keyAlias: host.keyAlias, deviceId: host.deviceId);
    api = HostApi(link: link, signer: signer);
  }

  final PairedHost host;
  final HostLink link;
  late final RequestSigner signer;
  late final HostApi api;

  void dispose() => link.close();
}
