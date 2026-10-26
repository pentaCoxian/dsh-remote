import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/protocol.dart';
import '../../state/link.dart';
import '../../state/providers.dart';
import '../../transport/iroh_pipe.dart';
import '../../widgets/status.dart';

/// Checks the host for real (redialing if the connection dropped) and keeps the
/// host's dot in step: the screen never shows a state it has not just observed.
final _probeProvider = FutureProvider.autoDispose.family<PipeStatus, String>((ref, hostId) async {
  final host = ref.read(hostsProvider).valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;
  if (host == null || host.revoked) return const PipeStatus(connected: false, paths: []);
  final link = ref.read(linkStateProvider(hostId).notifier);
  try {
    final status = await ref.read(pipeManagerProvider).probe(hostId, () => host.ticket);
    link.state = status.connected ? LinkState.online : LinkState.offline;
    return status;
  } catch (_) {
    link.state = LinkState.offline;
    rethrow;
  }
});

/// The first 16 hex digits in groups of four, as `dsh-remote` shows host and key ids.
String _grouped(String hex) => '${shortFingerprint(hex)}…';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key, required this.hostId});
  final String hostId;

  Future<void> _forget(BuildContext context, WidgetRef ref, String name) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Forget $name?'),
        content: const Text('This phone deletes its key for this host. The host keeps listing the phone until you revoke it there (`dsh-remote revoke`).'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Forget')),
        ],
      ),
    );
    if (confirmed != true) return;
    await ref.read(hostsProvider.notifier).remove(hostId);
    if (context.mounted) context.go('/');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final host = ref.watch(hostsProvider).valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;
    if (host == null) return Scaffold(appBar: AppBar(), body: const Center(child: Text('This host is not paired.')));
    final probe = ref.watch(_probeProvider(hostId));
    final scheme = Theme.of(context).colorScheme;
    final mono = Theme.of(context).textTheme.bodyMedium?.copyWith(fontFamily: 'monospace', color: scheme.onSurfaceVariant);
    final refresh = IconButton(tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: () => ref.invalidate(_probeProvider(hostId)));

    final Widget connection;
    if (host.revoked) {
      connection = ListTile(leading: const _Icon(child: LinkDot(LinkState.revoked)), title: Text(describeLink(LinkState.revoked).label));
    } else {
      connection = probe.when(
        loading: () => const ListTile(leading: _Icon(child: SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))), title: Text('Checking the connection…')),
        error: (error, _) => ListTile(
          leading: const _Icon(child: LinkDot(LinkState.offline)),
          title: Text(describeLink(LinkState.offline).label),
          subtitle: Text(error is PipeException ? error.describe : '$error'),
          trailing: refresh,
        ),
        data: (status) {
          final path = status.selected;
          if (!status.connected || path == null) {
            return ListTile(leading: const _Icon(child: LinkDot(LinkState.offline)), title: const Text('Not connected'), trailing: refresh);
          }
          return ListTile(
            leading: const _Icon(child: LinkDot(LinkState.online)),
            title: Text(path.relay ? 'Connected through a relay' : 'Connected directly'),
            subtitle: Text('Round trip ${path.rttMs} ms'),
            trailing: refresh,
          );
        },
      );
    }
    final homeRelay = probe.valueOrNull?.homeRelay;

    return Scaffold(
      appBar: AppBar(title: Text(host.name)),
      body: ListView(children: [
        const _Header('Connection'),
        connection,
        if (homeRelay != null) ListTile(leading: const _Icon(child: Icon(Icons.hub_outlined)), title: const Text('This phone’s relay'), subtitle: Text(Uri.parse(homeRelay).host)),
        const ListTile(
          leading: _Icon(child: Icon(Icons.lock_outline)),
          title: Text('End-to-end encrypted'),
          subtitle: Text('QUIC with TLS 1.3, authenticated by the host’s key. Relays forward encrypted packets only.'),
        ),
        const _Header('Host'),
        ListTile(
          leading: const _Icon(child: Icon(Icons.dns_outlined)),
          title: const Text('Host id'),
          subtitle: Text(_grouped(host.hostId), style: mono),
          trailing: IconButton(tooltip: 'Copy the full host id', icon: const Icon(Icons.copy), onPressed: () => Clipboard.setData(ClipboardData(text: host.hostId))),
        ),
        ListTile(leading: const _Icon(child: Icon(Icons.schedule)), title: const Text('Paired'), subtitle: Text(relativeTime(host.pairedAt))),
        const _Header('This phone'),
        ListTile(leading: const _Icon(child: Icon(Icons.smartphone)), title: const Text('Device id'), subtitle: Text(host.deviceId, style: mono)),
        ListTile(
          leading: const _Icon(child: Icon(Icons.key_outlined)),
          title: const Text('Request key'),
          subtitle: Text.rich(TextSpan(children: [
            TextSpan(text: shortFingerprint(spkiFingerprint(host.devicePublicKey)), style: mono),
            TextSpan(text: host.hardwareBacked ? '\nStored in secure hardware' : '\nSoftware key'),
          ])),
          isThreeLine: true,
        ),
        const SizedBox(height: 24),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: OutlinedButton.icon(
            style: OutlinedButton.styleFrom(foregroundColor: scheme.error, side: BorderSide(color: scheme.error)),
            onPressed: () => _forget(context, ref, host.name),
            icon: const Icon(Icons.link_off),
            label: const Text('Forget this host'),
          ),
        ),
        const SizedBox(height: 32),
      ]),
    );
  }
}

/// Leading slot of fixed width, so dots, spinners and icons line up in one column.
class _Icon extends StatelessWidget {
  const _Icon({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => SizedBox(width: 24, child: Center(child: child));
}

class _Header extends StatelessWidget {
  const _Header(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 4),
        child: Text(text, style: Theme.of(context).textTheme.titleSmall?.copyWith(color: Theme.of(context).colorScheme.primary)),
      );
}
