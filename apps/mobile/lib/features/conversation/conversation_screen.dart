import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models.dart';
import '../../state/providers.dart';
import '../../state/timeline.dart';
import '../../transport/events_client.dart';
import '../../widgets/status.dart';
import '../approvals/approval_card.dart';

class ConversationScreen extends ConsumerStatefulWidget {
  const ConversationScreen({super.key, required this.hostId, required this.sessionId});
  final String hostId;
  final String sessionId;

  @override
  ConsumerState<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends ConsumerState<ConversationScreen> {
  final _composer = TextEditingController();

  SessionRef get _ref => (hostId: widget.hostId, sessionId: widget.sessionId);

  @override
  void dispose() {
    _composer.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _composer.text;
    if (text.trim().isEmpty) return;
    _composer.clear();
    await ref.read(timelineProvider(_ref).notifier).send(text);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(timelineProvider(_ref));
    final controller = ref.read(timelineProvider(_ref).notifier);
    final link = ref.watch(linkStateProvider(widget.hostId));
    final blockedByOther = state.controller != null && !controller.iControl;
    final canWrite = !state.unpublished && link != LinkState.revoked;
    // Newest last in time, but laid out bottom-up so the latest stays in view.
    final entries = <Widget>[
      for (final item in state.items) _Event(item: item),
      for (final approval in state.pendingApprovals) ApprovalCard(hostId: widget.hostId, approval: approval),
      if (state.partial.isNotEmpty) _Bubble(mine: false, child: MarkdownBody(data: state.partial)),
      if (state.activeTurn != null && state.partial.isEmpty) const _Thinking(),
      for (final prompt in state.outgoing) _Outgoing(prompt: prompt, onRetry: () => controller.retry(prompt), onDiscard: () => controller.discard(prompt), onTakeControl: controller.takeControl),
    ];
    return Scaffold(
      appBar: AppBar(
        title: Text(state.session?.title ?? 'Session', maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (state.activeTurn != null) IconButton(tooltip: 'Stop this turn', icon: const Icon(Icons.stop_circle_outlined), onPressed: controller.cancelTurn),
        ],
      ),
      body: Column(children: [
        LinkBanner(link),
        if (blockedByOther)
          MaterialBanner(
            content: Text('${state.controller!.label} is controlling this session.'),
            actions: [TextButton(onPressed: controller.takeControl, child: const Text('Take control'))],
          ),
        if (state.error != null)
          MaterialBanner(
            content: Text(state.error!),
            actions: [TextButton(onPressed: controller.clearError, child: const Text('Dismiss'))],
          ),
        Expanded(
          child: state.loading
              ? const Center(child: CircularProgressIndicator())
              : entries.isEmpty
                  ? const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('Nothing here yet. Send a message to continue this session.', textAlign: TextAlign.center)))
                  : ListView.builder(
                      reverse: true,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: entries.length,
                      itemBuilder: (_, index) => entries[entries.length - 1 - index],
                    ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 8, 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Expanded(
                child: TextField(
                  controller: _composer,
                  enabled: canWrite,
                  minLines: 1,
                  maxLines: 6,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(hintText: canWrite ? 'Message DSH' : 'This session is not shared', border: const OutlineInputBorder()),
                ),
              ),
              const SizedBox(width: 4),
              IconButton.filled(tooltip: 'Send', onPressed: canWrite ? _send : null, icon: const Icon(Icons.arrow_upward)),
            ]),
          ),
        ),
      ]),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.mine, required this.child, this.footer});
  final bool mine;
  final Widget child;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.86),
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: mine ? scheme.primaryContainer : scheme.surfaceContainerHigh, borderRadius: BorderRadius.circular(14)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [child, if (footer != null) ...[const SizedBox(height: 6), footer!]]),
        ),
      ),
    );
  }
}

/// One durable timeline event (packages/dsh-plugin src/core/translate.ts kinds).
class _Event extends StatelessWidget {
  const _Event({required this.item});
  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    final payload = item.payload;
    final small = Theme.of(context).textTheme.labelSmall;
    String text(String key) => payload[key] as String? ?? '';
    String clipped(String key) => text(key) + (payload['truncated'] == true ? '\n…' : '');
    switch (item.kind) {
      case 'user.message':
        final origin = payload['origin'] == 'local' ? 'Typed on the host' : 'From a phone';
        return _Bubble(mine: true, footer: Text(origin, style: small), child: SelectableText(clipped('text')));
      case 'assistant.message':
        return _Bubble(mine: false, child: MarkdownBody(data: clipped('text'), selectable: true));
      case 'tool.started':
        return _ToolLine(icon: Icons.build_outlined, title: 'Ran ${text('name')}', detail: clipped('argsPreview'));
      case 'tool.finished':
        final failed = payload['isError'] == true;
        return _ToolLine(icon: failed ? Icons.error_outline : Icons.check, title: failed ? 'Tool failed' : 'Tool finished', detail: clipped('resultPreview'));
      case 'approval.requested':
        return _Note('Approval asked for ${text('toolName')}');
      case 'approval.resolved':
        return _Note(switch (payload['outcome']) { 'allowed_once' => 'Allowed once', 'denied' => 'Denied', 'cancelled' => 'Approval cancelled', _ => 'Approval closed' });
      case 'turn.finished':
        final reason = text('reason');
        return reason == 'completed' || reason.isEmpty ? const SizedBox(height: 4) : _Note('Turn ended: $reason');
      default:
        return const SizedBox.shrink();
    }
  }
}

class _ToolLine extends StatelessWidget {
  const _ToolLine({required this.icon, required this.title, required this.detail});
  final IconData icon;
  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final mono = Theme.of(context).textTheme.bodySmall?.copyWith(fontFamily: 'monospace');
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: ExpansionTile(
        dense: true,
        leading: Icon(icon, size: 18),
        title: Text(title, style: Theme.of(context).textTheme.bodyMedium),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        expandedAlignment: Alignment.centerLeft,
        children: [if (detail.isNotEmpty) SelectableText(detail, style: mono)],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 4),
        child: Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: Theme.of(context).colorScheme.outline)),
      );
}

class _Thinking extends StatelessWidget {
  const _Thinking();

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'DSH is working',
        child: const _Bubble(mine: false, child: SizedBox(width: 24, height: 12, child: LinearProgressIndicator())),
      );
}

/// A prompt sent from this phone that the timeline has not shown yet.
class _Outgoing extends StatelessWidget {
  const _Outgoing({required this.prompt, required this.onRetry, required this.onDiscard, required this.onTakeControl});
  final OutgoingPrompt prompt;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;
  final Future<void> Function() onTakeControl;

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.labelSmall;
    final footer = switch (prompt.status) {
      OutgoingStatus.sending => Text('Sending…', style: small),
      OutgoingStatus.accepted => Text('Delivered', style: small),
      OutgoingStatus.unknown => Row(mainAxisSize: MainAxisSize.min, children: [
          Flexible(child: Text('May not have arrived', style: small)),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ]),
      OutgoingStatus.failed => Row(mainAxisSize: MainAxisSize.min, children: [
          Flexible(child: Text(prompt.error ?? 'Not delivered', style: small)),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
          TextButton(onPressed: onDiscard, child: const Text('Discard')),
        ]),
      OutgoingStatus.blocked => Row(mainAxisSize: MainAxisSize.min, children: [
          Flexible(child: Text('Another device is in control', style: small)),
          TextButton(
            onPressed: () async {
              await onTakeControl();
              onRetry();
            },
            child: const Text('Take control and send'),
          ),
        ]),
    };
    return Semantics(liveRegion: true, child: _Bubble(mine: true, footer: footer, child: SelectableText(prompt.text)));
  }
}
