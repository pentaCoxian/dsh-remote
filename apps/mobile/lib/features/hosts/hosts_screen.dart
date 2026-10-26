import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../state/providers.dart';
import '../../storage/host_store.dart';
import '../../transport/events_client.dart';
import '../../widgets/status.dart';

class HostsScreen extends ConsumerWidget {
  const HostsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hosts = ref.watch(hostsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('DSH Remote')),
      floatingActionButton: FloatingActionButton.extended(onPressed: () => context.push('/scan'), icon: const Icon(Icons.qr_code_scanner), label: const Text('Connect host')),
      body: hosts.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(child: Text('Could not read paired hosts: $error')),
        data: (hosts) => hosts.isEmpty
            ? const _Empty()
            : ListView(padding: const EdgeInsets.only(bottom: 96), children: [for (final host in hosts) _HostTile(host: host)]),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty();

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.dns_outlined, size: 56, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: 16),
            Text('Connect your home lab', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            const Text('On the host, run /rc in a DSH session or `dsh-remote pair`, then tap Connect host and scan the code.', textAlign: TextAlign.center),
          ]),
        ),
      );
}

class _HostTile extends ConsumerWidget {
  const _HostTile({required this.host});
  final PairedHost host;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!host.revoked) ref.watch(hostSessionProvider(host.hostId));
    final link = host.revoked ? LinkState.revoked : ref.watch(linkStateProvider(host.hostId));
    final last = host.lastSessionId;
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        ListTile(
          leading: LinkDot(link),
          title: Text(host.name),
          subtitle: Text(describeLink(link).label),
          trailing: IconButton(tooltip: 'Host settings', icon: const Icon(Icons.settings_outlined), onPressed: () => context.push('/host/${host.hostId}/settings')),
          onTap: host.revoked ? null : () => context.push('/host/${host.hostId}'),
        ),
        if (!host.revoked && last != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: FilledButton.tonalIcon(
              onPressed: () => context.push('/host/${host.hostId}/session/$last'),
              icon: const Icon(Icons.play_arrow),
              label: const Text('Continue last session'),
            ),
          ),
      ]),
    );
  }
}
