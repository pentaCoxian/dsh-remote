/// Build-time configuration (`--dart-define`).
abstract final class AppConfig {
  /// iroh relays for this phone's own endpoint: the DSH Remote relay, then
  /// n0's public relays. A host is dialed through whatever relay its ticket names.
  static const defaultRelays = [
    'https://nrt1.relay.dshremote.pentacoxian.dev/',
    'https://aps1-1.relay.n0.iroh.link./',
    'https://euc1-1.relay.n0.iroh.link./',
    'https://use1-1.relay.n0.iroh.link./',
    'https://usw1-1.relay.n0.iroh.link./',
  ];

  /// Comma-separated override, e.g. `--dart-define=DSH_RELAYS=none` for LAN-only dev builds.
  static const _relays = String.fromEnvironment('DSH_RELAYS');

  static List<String> get relays => _relays.isEmpty ? defaultRelays : (_relays == 'none' ? const [] : _relays.split(','));
}
