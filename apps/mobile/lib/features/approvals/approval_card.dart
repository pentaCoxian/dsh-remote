import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models.dart';
import '../../state/providers.dart';
import '../../widgets/status.dart';

/// One pending tool approval: the exact action, then Allow once or Deny with
/// the revision the user saw (a stale answer is refused by the host).
class ApprovalCard extends ConsumerStatefulWidget {
  const ApprovalCard({super.key, required this.hostId, required this.approval});
  final String hostId;
  final Approval approval;

  @override
  ConsumerState<ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends ConsumerState<ApprovalCard> {
  bool _busy = false;

  Future<void> _answer(bool allow) async {
    setState(() => _busy = true);
    final message = await ref.read(approvalsProvider(widget.hostId).notifier).respond(widget.approval, allow: allow);
    if (!mounted) return;
    setState(() => _busy = false);
    if (message != null) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final approval = widget.approval;
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Card(
      color: scheme.tertiaryContainer,
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(Icons.gpp_maybe_outlined, color: scheme.onTertiaryContainer),
            const SizedBox(width: 8),
            Expanded(child: Text('Approve ${approval.toolName}?', style: text.titleSmall?.copyWith(color: scheme.onTertiaryContainer))),
            Text(relativeTime(approval.requestedAt), style: text.labelSmall),
          ]),
          if (approval.reason != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(approval.reason!)),
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: scheme.surface, borderRadius: BorderRadius.circular(6)),
            child: SelectableText(approval.preview + (approval.previewTruncated ? '\n…(truncated)' : ''), style: text.bodySmall?.copyWith(fontFamily: 'monospace')),
          ),
          const SizedBox(height: 4),
          Text('Allow once applies only to this exact call.', style: text.labelSmall),
          const SizedBox(height: 8),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            TextButton(onPressed: _busy ? null : () => _answer(false), child: const Text('Deny')),
            const SizedBox(width: 8),
            FilledButton(onPressed: _busy ? null : () => _answer(true), child: const Text('Allow once')),
          ]),
        ]),
      ),
    );
  }
}
