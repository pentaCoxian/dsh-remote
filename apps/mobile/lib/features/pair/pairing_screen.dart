import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/protocol.dart';
import '../../state/pairing.dart';

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
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Connect host')),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Text(widget.payload.hostName ?? 'DSH host', style: text.titleLarge),
        const SizedBox(height: 4),
        if (state.hostId != null) Text('Host ${shortHostId(state.hostId!)} · end-to-end encrypted', style: text.bodySmall),
        const SizedBox(height: 24),
        if (state.step == PairingStep.ready) ...[
          TextField(controller: _label, maxLength: 64, decoration: const InputDecoration(labelText: 'Name this phone', helperText: 'Shown on the host when you approve it')),
          const SizedBox(height: 16),
          FilledButton(onPressed: () => controller.start(_label.text.trim().isEmpty ? 'Phone' : _label.text.trim()), child: const Text('Pair')),
        ] else
          _Progress(state: state),
        const SizedBox(height: 24),
        if (state.step == PairingStep.waiting || state.step == PairingStep.connecting || state.step == PairingStep.redeeming)
          OutlinedButton(
            onPressed: () {
              controller.cancel();
              context.pop();
            },
            child: const Text('Cancel pairing'),
          ),
        if (const {PairingStep.failed, PairingStep.denied, PairingStep.expired}.contains(state.step))
          FilledButton.tonal(onPressed: () => context.go('/'), child: const Text('Back')),
      ]),
    );
  }
}

class _Progress extends StatelessWidget {
  const _Progress({required this.state});
  final PairingState state;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final (title, detail, busy) = switch (state.step) {
      PairingStep.connecting => ('Connecting to the host…', 'Directly when possible, otherwise through an encrypted relay.', true),
      PairingStep.redeeming => ('Creating this phone’s key…', 'The private key stays in this phone’s secure hardware.', true),
      PairingStep.waiting => ('Waiting for host approval', 'Approve this phone at the host (`dsh-remote pair`). The fingerprints must match. Approving gives this phone full DSH Web access.', true),
      PairingStep.done => ('Paired', '', false),
      PairingStep.denied => ('Not approved', state.message ?? '', false),
      PairingStep.expired => ('Expired', state.message ?? '', false),
      PairingStep.failed => ('Could not pair', state.message ?? '', false),
      PairingStep.ready => ('', '', false),
    };
    return Semantics(
      liveRegion: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (busy) const Padding(padding: EdgeInsets.only(right: 12), child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
          Expanded(child: Text(title, style: text.titleMedium)),
        ]),
        const SizedBox(height: 8),
        Text(detail),
        if (state.phoneFingerprint != null) ...[
          const SizedBox(height: 16),
          Text('This phone’s key', style: text.labelLarge),
          SelectableText(shortFingerprint(state.phoneFingerprint!), style: text.headlineSmall?.copyWith(fontFamily: 'monospace')),
        ],
      ]),
    );
  }
}
