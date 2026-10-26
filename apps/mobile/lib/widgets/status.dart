import 'package:flutter/material.dart';

import '../state/link.dart';
import '../ui/theme.dart';

({String label, Color Function(Tokens) color}) describeLink(LinkState state) => switch (state) {
      LinkState.online => (label: 'Connected', color: (t) => t.success),
      LinkState.connecting => (label: 'Connecting…', color: (t) => t.textTertiary),
      LinkState.offline => (label: 'Home lab offline', color: (t) => t.danger),
      LinkState.revoked => (label: 'Access removed by the host', color: (t) => t.danger),
      LinkState.outdated => (label: 'Update DSH Remote', color: (t) => t.danger),
    };

class LinkDot extends StatelessWidget {
  const LinkDot(this.state, {super.key, this.size = 8});
  final LinkState state;
  final double size;

  @override
  Widget build(BuildContext context) {
    final info = describeLink(state);
    return Semantics(
      label: info.label,
      child: Container(width: size, height: size, decoration: BoxDecoration(color: info.color(Tokens.of(context)), shape: BoxShape.circle)),
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
