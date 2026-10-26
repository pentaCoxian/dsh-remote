import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/protocol.dart';
import '../../state/pairing.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';

class PairingScreen extends ConsumerStatefulWidget {
  const PairingScreen({super.key, required this.payload});
  final PairingPayload payload;

  @override
  ConsumerState<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends ConsumerState<PairingScreen> {
  late final _label = TextEditingController(text: Platform.isIOS ? 'iPhone' : 'Android phone');

  @override
  void dispose() {
    _label.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final provider = pairingProvider(widget.payload);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    ref.listen(provider, (_, next) {
      if (next.step == PairingStep.done && next.hostId != null) context.go('/host/${next.hostId}');
    });
    final theme = Theme.of(context);
    final t = Tokens.of(context);
    final busy = const {PairingStep.connecting, PairingStep.redeeming, PairingStep.waiting}.contains(state.step);
    final ended = const {PairingStep.failed, PairingStep.denied, PairingStep.expired}.contains(state.step);
    return Scaffold(
      appBar: shellBar(context, title: const Text('Connect host')),
      body: ListView(padding: const EdgeInsets.fromLTRB(20, 28, 20, 32), children: [
        Text(widget.payload.hostName ?? 'DSH host', style: theme.textTheme.headlineSmall),
        const SizedBox(height: 8),
        Row(children: [
          Icon(LucideIcons.lock, size: 14, color: t.textTertiary),
          const SizedBox(width: 6),
          Flexible(child: Text(state.hostId == null ? 'End-to-end encrypted' : 'Host ${shortHostId(state.hostId!)} · end-to-end encrypted', style: theme.textTheme.bodySmall)),
        ]),
        const SizedBox(height: 32),
        if (state.step == PairingStep.ready) ...[
          Text('Name this phone', style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          TextField(controller: _label, maxLength: 64, textInputAction: TextInputAction.done, decoration: const InputDecoration(counterText: '')),
          const SizedBox(height: 8),
          Text('Shown on the host when you approve it.', style: theme.textTheme.bodySmall?.copyWith(color: t.textTertiary)),
          const SizedBox(height: 24),
          FilledButton(onPressed: () => controller.start(_label.text.trim().isEmpty ? 'Phone' : _label.text.trim()), child: const Text('Pair')),
          const SizedBox(height: 14),
          Text('Approving this phone on the host gives it full DSH Web access.', textAlign: TextAlign.center, style: theme.textTheme.bodySmall?.copyWith(color: t.textTertiary)),
        ] else
          _Progress(state: state),
        const SizedBox(height: 28),
        if (busy)
          OutlinedButton(
            onPressed: () {
              controller.cancel();
              leave(context);
            },
            child: const Text('Cancel'),
          ),
        if (ended) FilledButton(onPressed: () => context.go('/'), child: const Text('Back')),
      ]),
    );
  }
}

class _Progress extends StatelessWidget {
  const _Progress({required this.state});
  final PairingState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = Tokens.of(context);
    final (title, detail, busy) = switch (state.step) {
      PairingStep.connecting => ('Connecting to the host', 'Directly when possible, otherwise through an encrypted relay.', true),
      PairingStep.redeeming => ('Creating this phone’s key', 'The private key stays in this phone’s secure hardware.', true),
      PairingStep.waiting => ('Waiting for approval', 'Approve this phone at the host, in DSH Web or `dsh-remote pair`. The fingerprints must match.', true),
      PairingStep.done => ('Paired', '', false),
      PairingStep.denied => ('Not approved', state.message ?? '', false),
      PairingStep.expired => ('Expired', state.message ?? '', false),
      PairingStep.failed => ('Could not pair', state.message ?? '', false),
      PairingStep.ready => ('', '', false),
    };
    final failed = const {PairingStep.failed, PairingStep.denied, PairingStep.expired}.contains(state.step);
    return Semantics(
      liveRegion: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (busy) const Padding(padding: EdgeInsets.only(right: 12), child: SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))),
          if (failed) Padding(padding: const EdgeInsets.only(right: 10), child: Icon(LucideIcons.circleAlert, size: 18, color: t.danger)),
          Expanded(child: Text(title, style: theme.textTheme.titleMedium)),
        ]),
        if (detail.isNotEmpty) ...[const SizedBox(height: 8), CodeText(detail, style: theme.textTheme.bodySmall)],
        if (state.phoneFingerprint != null) ...[
          const SizedBox(height: 20),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: t.muted, borderRadius: BorderRadius.circular(Radii.card), border: Border.all(color: t.border)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('This phone’s key', style: theme.textTheme.labelSmall),
              const SizedBox(height: 6),
              SelectableText(shortFingerprint(state.phoneFingerprint!), style: theme.textTheme.titleLarge?.copyWith(fontFamily: 'monospace', letterSpacing: 1)),
            ]),
          ),
        ],
      ]),
    );
  }
}
