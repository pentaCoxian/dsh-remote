import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/protocol.dart';

/// In-app QR scanner for the `dshremote://pair?…` code from `/rc` or `dsh-remote pair`.
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
    return Scaffold(
      appBar: AppBar(title: const Text('Scan pairing code')),
      body: Column(children: [
        Expanded(
          child: Semantics(
            label: 'Camera viewfinder for the pairing QR code',
            child: MobileScanner(
              controller: _controller,
              onDetect: (capture) {
                final value = capture.barcodes.firstOrNull?.rawValue;
                if (value != null) _accept(value);
              },
            ),
          ),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        Padding(
          padding: EdgeInsets.fromLTRB(16, 8, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
          child: Row(children: [
            Expanded(child: TextField(controller: _paste, decoration: const InputDecoration(labelText: 'Or paste the pairing code'), keyboardType: TextInputType.url)),
            IconButton(tooltip: 'Use pasted code', icon: const Icon(Icons.arrow_forward), onPressed: () => _accept(_paste.text)),
          ]),
        ),
      ]),
    );
  }
}
