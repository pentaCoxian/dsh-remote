import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/protocol.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';

/// In-app scanner for the `dshremote://pair?…` code from `dsh-remote pair`.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  final _paste = TextEditingController();
  bool _handled = false;
  String? _error;

  void _accept(String text) {
    if (_handled) return;
    final payload = PairingPayload.parse(text);
    if (payload == null) {
      setState(() => _error = 'That is not a DSH Remote pairing code.');
      return;
    }
    _handled = true;
    context.pushReplacement(Uri(path: '/pair', queryParameters: {'u': text.trim()}).toString());
  }

  @override
  void dispose() {
    _controller.dispose();
    _paste.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Tokens.of(context);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: shellBar(context, title: const Text('Connect host')),
      body: SafeArea(
        top: false,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
            child: AspectRatio(
              aspectRatio: 1,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(Radii.sheet),
                child: Stack(fit: StackFit.expand, children: [
                  Semantics(
                    label: 'Camera viewfinder for the pairing code',
                    child: MobileScanner(
                      controller: _controller,
                      onDetect: (capture) {
                        final value = capture.barcodes.firstOrNull?.rawValue;
                        if (value != null) _accept(value);
                      },
                    ),
                  ),
                  // A quiet frame: where to put the code.
                  Center(
                    child: FractionallySizedBox(
                      widthFactor: 0.62,
                      heightFactor: 0.62,
                      child: DecoratedBox(decoration: BoxDecoration(borderRadius: BorderRadius.circular(Radii.card), border: Border.all(color: Colors.white.withValues(alpha: 0.85), width: 2))),
                    ),
                  ),
                ]),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 16, 28, 0),
            child: CodeText('Scan the code from `dsh-remote pair` on the machine running DSH.', textAlign: TextAlign.center, style: theme.textTheme.bodySmall),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.fromLTRB(28, 10, 28, 0), child: Text(_error!, textAlign: TextAlign.center, style: theme.textTheme.bodySmall?.copyWith(color: t.danger))),
          const Spacer(),
          Padding(
            padding: EdgeInsets.fromLTRB(16, 8, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
            child: Row(children: [
              Expanded(
                child: TextField(
                  controller: _paste,
                  decoration: const InputDecoration(hintText: 'Or paste the pairing code', isDense: true),
                  keyboardType: TextInputType.url,
                  onSubmitted: _accept,
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                tooltip: 'Use pasted code',
                style: IconButton.styleFrom(backgroundColor: t.text, foregroundColor: t.background, minimumSize: const Size(46, 46)),
                icon: const Icon(LucideIcons.arrowRight, size: 20),
                onPressed: () => _accept(_paste.text),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}
