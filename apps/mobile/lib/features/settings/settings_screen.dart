import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/protocol.dart';
import '../../state/providers.dart';
import '../../transport/iroh_pipe.dart';
import '../../widgets/status.dart';

final _pipeStatusProvider = FutureProvider.autoDispose.family<PipeStatus, String>((ref, hostId) => ref.read(pipeManagerProvider).status(hostId));

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
    final link = ref.watch(linkStateProvider(hostId));
    final pipe = ref.watch(_pipeStatusProvider(hostId));
    final text = Theme.of(context).textTheme;
    final mono = text.bodySmall?.copyWith(fontFamily: 'monospace');
    return Scaffold(
      appBar: AppBar(title: Text(host.name)),
      body: ListView(children: [
        const _Header('Connection'),
        ListTile(leading: LinkDot(link), title: Text(describeLink(link).label)),
        pipe.when(
          loading: () => const ListTile(title: Text('Reading connection details…')),
          error: (error, _) => ListTile(title: const Text('No connection details'), subtitle: Text('$error')),
          data: (status) {
            final path = status.selected;
            final route = !status.connected || path == null ? 'Not connected' : path.relay ? 'Through an encrypted relay' : 'Direct';
            return Column(children: [
              ListTile(
                leading: Icon(path?.relay == false ? Icons.bolt : Icons.alt_route),
                title: Text(route),
                subtitle: path == null ? null : Text('Round trip ${path.rttMs} ms'),
                trailing: IconButton(tooltip: 'Refresh', icon: const Icon(Icons.refresh), onPressed: () => ref.invalidate(_pipeStatusProvider(hostId))),
              ),
              if (status.homeRelay != null) ListTile(leading: const Icon(Icons.hub_outlined), title: const Text('This phone’s relay'), subtitle: Text(Uri.parse(status.homeRelay!).host)),
            ]);
          },
        ),
        const ListTile(
          leading: Icon(Icons.lock_outline),
          title: Text('End-to-end encrypted'),
          subtitle: Text('QUIC with TLS 1.3, authenticated by the host’s key. Relays forward encrypted packets only.'),
        ),
        const _Header('Host'),
        ListTile(
          title: const Text('Host id'),
          subtitle: Text(host.hostId, style: mono),
          trailing: IconButton(tooltip: 'Copy host id', icon: const Icon(Icons.copy), onPressed: () => Clipboard.setData(ClipboardData(text: host.hostId))),
        ),
        ListTile(title: const Text('Paired'), subtitle: Text(relativeTime(host.pairedAt))),
        const _Header('This phone'),
        ListTile(title: const Text('Device id'), subtitle: Text(host.deviceId, style: mono)),
        ListTile(
          title: const Text('Request key'),
          subtitle: Text('${shortFingerprint(spkiFingerprint(host.devicePublicKey))} · ${host.hardwareBacked ? 'in secure hardware' : 'software key'}', style: mono),
        ),
        const SizedBox(height: 24),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: OutlinedButton.icon(
            style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
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

class _Header extends StatelessWidget {
  const _Header(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 4),
        child: Text(text, style: Theme.of(context).textTheme.titleSmall?.copyWith(color: Theme.of(context).colorScheme.primary)),
      );
}
