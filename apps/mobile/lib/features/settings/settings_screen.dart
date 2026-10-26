import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/protocol.dart';
import '../../state/link.dart';
import '../../state/providers.dart';
import '../../transport/iroh_pipe.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';
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
        content: const CodeText('This phone deletes its key for this host. The host keeps listing the phone until you revoke it there (`dsh-remote revoke`).'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(context, true), style: TextButton.styleFrom(foregroundColor: Tokens.of(context).danger), child: const Text('Forget')),
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
    if (host == null) return Scaffold(appBar: shellBar(context), body: const Center(child: Text('This host is not paired.')));
    final probe = ref.watch(_probeProvider(hostId));
    final t = Tokens.of(context);
    final refresh = IconButton(tooltip: 'Check again', icon: const Icon(LucideIcons.rotateCw, size: 18), onPressed: () => ref.invalidate(_probeProvider(hostId)));

    final Widget connection;
    if (host.revoked) {
      connection = InfoRow(icon: const Center(child: LinkDot(LinkState.revoked)), label: describeLink(LinkState.revoked).label);
    } else {
      connection = probe.when(
        loading: () => const InfoRow(icon: Center(child: SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2))), label: 'Checking the connection…'),
        error: (error, _) => InfoRow(
          icon: const Center(child: LinkDot(LinkState.offline)),
          label: describeLink(LinkState.offline).label,
          value: error is PipeException ? error.describe : '$error',
          trailing: refresh,
        ),
        data: (status) {
          final path = status.selected;
          if (!status.connected || path == null) return InfoRow(icon: const Center(child: LinkDot(LinkState.offline)), label: 'Not connected', trailing: refresh);
          return InfoRow(
            icon: const Center(child: LinkDot(LinkState.online)),
            label: path.relay ? 'Connected through a relay' : 'Connected directly',
            value: 'Round trip ${path.rttMs} ms',
            trailing: refresh,
          );
        },
      );
    }
    final homeRelay = probe.valueOrNull?.homeRelay;

    return Scaffold(
      appBar: shellBar(context, title: Text(host.name)),
      body: ListView(padding: const EdgeInsets.only(bottom: 32), children: [
        const SectionLabel('Connection'),
        Group(children: [
          connection,
          if (homeRelay != null) InfoRow(icon: const Icon(LucideIcons.radioTower), label: 'This phone’s relay', value: Uri.parse(homeRelay).host),
          const InfoRow(icon: Icon(LucideIcons.shieldCheck), label: 'End-to-end encrypted', value: 'QUIC with TLS 1.3, authenticated by the host’s key. Relays forward encrypted packets only.'),
        ]),
        const SectionLabel('Host'),
        Group(children: [
          InfoRow(
            icon: const Icon(LucideIcons.server),
            label: 'Host id',
            value: _grouped(host.hostId),
            mono: true,
            trailing: IconButton(
              tooltip: 'Copy the full host id',
              icon: const Icon(LucideIcons.copy, size: 18),
              onPressed: () {
                Clipboard.setData(ClipboardData(text: host.hostId));
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Host id copied')));
              },
            ),
          ),
          InfoRow(icon: const Icon(LucideIcons.clock), label: 'Paired', value: relativeTime(host.pairedAt)),
        ]),
        const SectionLabel('This phone'),
        Group(children: [
          InfoRow(icon: const Icon(LucideIcons.smartphone), label: 'Device id', value: host.deviceId, mono: true),
          InfoRow(
            icon: const Icon(LucideIcons.keyRound),
            label: 'Request key',
            valueWidget: Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text(shortFingerprint(spkiFingerprint(host.devicePublicKey)), style: Theme.of(context).textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
              Pill(host.hardwareBacked ? 'Secure hardware' : 'Software key'),
            ]),
          ),
        ]),
        const SizedBox(height: 28),
        Group(children: [
          InkWell(
            onTap: () => _forget(context, ref, host.name),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(LucideIcons.unlink, size: 16, color: t.danger),
                const SizedBox(width: 8),
                Text('Forget this host', style: TextStyle(color: t.danger, fontSize: 15, fontWeight: FontWeight.w500)),
              ]),
            ),
          ),
        ]),
      ]),
    );
  }
}

