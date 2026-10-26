import 'package:flutter/material.dart';

import '../state/link.dart';

({String label, Color Function(ColorScheme) color}) describeLink(LinkState state) => switch (state) {
      LinkState.online => (label: 'Connected', color: (c) => Colors.green.shade600),
      LinkState.connecting => (label: 'Connecting…', color: (c) => c.outline),
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

String relativeTime(DateTime time) {
  final delta = DateTime.now().difference(time);
  if (delta.inSeconds < 60) return 'just now';
  if (delta.inMinutes < 60) return '${delta.inMinutes} min ago';
  if (delta.inHours < 24) return '${delta.inHours} h ago';
  return '${delta.inDays} d ago';
}
