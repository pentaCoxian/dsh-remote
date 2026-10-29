import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/protocol.dart';
import '../../state/link.dart';
import '../../state/providers.dart';
import '../../storage/host_store.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
import '../../widgets/status.dart';

class HostsScreen extends ConsumerWidget {
  const HostsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hosts = ref.watch(hostsProvider);
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 20, 16, 32), children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 20),
            child: Row(children: [
              Text('DSH Remote', style: theme.textTheme.headlineSmall),
              const SizedBox(width: 8),
              const Pill('E2E'),
            ]),
          ),
          OutlinedButton.icon(
            onPressed: () => context.push('/scan'),
            icon: const Icon(LucideIcons.circlePlus, size: 18),
            label: const Text('Connect host'),
          ),
          ...hosts.when(
            loading: () => [const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))],
            error: (error, _) => [Notice(text: 'Could not read paired hosts: $error', danger: true)],
            data: (hosts) => hosts.isEmpty
                ? [const _Empty()]
                : [
                    Padding(padding: const EdgeInsets.fromLTRB(4, 28, 4, 8), child: Text('Hosts', style: theme.textTheme.titleSmall)),
                    for (final host in hosts) _HostRow(host: host),
                  ],
          ),
        ]),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = Tokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 72, 24, 0),
      child: Column(children: [
        Icon(LucideIcons.monitorSmartphone, size: 36, color: t.textTertiary),
        const SizedBox(height: 16),
        Text('No hosts yet', style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        CodeText(
          'Send `/rc` in DSH Web on the machine running DSH (or run `dsh-remote pair` there), then scan its code. DSH Web opens here over an end-to-end encrypted connection.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodySmall,
        ),
      ]),
    );
  }
}

/// A host, shaped like a DSH Web session row: muted pill, dot, name, quiet detail.
class _HostRow extends ConsumerWidget {
  const _HostRow({required this.host});
  final PairedHost host;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Tokens.of(context);
    final theme = Theme.of(context);
    final link = host.revoked ? LinkState.revoked : ref.watch(linkStateProvider(host.hostId));
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: t.muted,
        borderRadius: BorderRadius.circular(Radii.control),
        child: InkWell(
          borderRadius: BorderRadius.circular(Radii.control),
          // A host marked revoked is asked again when opened.
          onTap: () => context.push('/host/${host.hostId}'),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 4, 12),
            child: Row(children: [
              LinkDot(link),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(host.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text(host.revoked ? describeLink(link).label : shortHostId(host.hostId), style: theme.textTheme.bodySmall?.copyWith(color: host.revoked ? t.danger : t.textTertiary, fontFamily: host.revoked ? null : 'monospace')),
                ]),
              ),
              IconButton(tooltip: 'Host settings', icon: const Icon(LucideIcons.settings2, size: 18), onPressed: () => context.push('/host/${host.hostId}/settings')),
            ]),
          ),
        ),
      ),
    );
  }
}
