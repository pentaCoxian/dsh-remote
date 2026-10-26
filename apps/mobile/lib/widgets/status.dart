import 'package:flutter/material.dart';

import '../core/models.dart';
import '../transport/events_client.dart';

({String label, Color Function(ColorScheme) color}) describeLink(LinkState state) => switch (state) {
      LinkState.online => (label: 'Online', color: (c) => Colors.green.shade600),
      LinkState.connecting => (label: 'Connecting…', color: (c) => c.outline),
      LinkState.reconnecting => (label: 'Connection lost — trying again', color: (c) => Colors.orange.shade700),
      LinkState.offline => (label: 'Home lab offline', color: (c) => c.error),
      LinkState.revoked => (label: 'Access removed by the host', color: (c) => c.error),
      LinkState.outdated => (label: 'Update DSH Remote', color: (c) => c.error),
    };

class LinkDot extends StatelessWidget {
  const LinkDot(this.state, {super.key});
  final LinkState state;

  @override
  Widget build(BuildContext context) {
    final info = describeLink(state);
    return Semantics(
      label: info.label,
      child: Container(width: 10, height: 10, decoration: BoxDecoration(color: info.color(Theme.of(context).colorScheme), shape: BoxShape.circle)),
    );
  }
}

/// Banner for every non-online link state (spec §4 copy).
class LinkBanner extends StatelessWidget {
  const LinkBanner(this.state, {super.key});
  final LinkState state;

  @override
  Widget build(BuildContext context) {
    if (state == LinkState.online || state == LinkState.connecting) return const SizedBox.shrink();
    final info = describeLink(state);
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: info.color(scheme).withValues(alpha: 0.15),
      child: Semantics(
        liveRegion: true,
        child: ListTile(
          dense: true,
          leading: Icon(state == LinkState.revoked ? Icons.block : Icons.cloud_off, color: info.color(scheme)),
          title: Text(info.label),
        ),
      ),
    );
  }
}

class SessionStatusChip extends StatelessWidget {
  const SessionStatusChip(this.status, {super.key});
  final SessionStatus status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (label, color) = switch (status) {
      SessionStatus.running => ('Running', scheme.primary),
      SessionStatus.needsApproval => ('Needs approval', Colors.orange.shade700),
      SessionStatus.idle => ('Idle', scheme.outline),
      SessionStatus.unavailable => ('Unavailable', scheme.error),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(border: Border.all(color: color), borderRadius: BorderRadius.circular(12)),
      child: Text(label, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color)),
    );
  }
}

String relativeTime(DateTime time) {
  final delta = DateTime.now().difference(time);
  if (delta.inSeconds < 60) return 'just now';
  if (delta.inMinutes < 60) return '${delta.inMinutes} min ago';
  if (delta.inHours < 24) return '${delta.inHours} h ago';
  return '${delta.inDays} d ago';
}
