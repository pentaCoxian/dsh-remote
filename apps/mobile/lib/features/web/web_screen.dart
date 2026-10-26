import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/errors.dart';
import '../../state/link.dart';
import '../../state/providers.dart';
import '../../transport/iroh_pipe.dart';
import '../../widgets/status.dart';

/// DSH Web itself, full screen, through the host's end-to-end encrypted tunnel.
///
/// Opening it sends a request signed by this phone's hardware key, which opens
/// the phone's web window on the host and returns DSH's launch token; the
/// WebView then loads `http://127.0.0.1:<port>/?token=…`, where the pipe
/// forwards to DSH Web, and DSH sets its own owner cookie.
class WebScreen extends ConsumerStatefulWidget {
  const WebScreen({super.key, required this.hostId});
  final String hostId;

  @override
  ConsumerState<WebScreen> createState() => _WebScreenState();
}

class _WebScreenState extends ConsumerState<WebScreen> {
  WebViewController? _controller;
  late final AppLifecycleListener _lifecycle;
  int? _port;
  String? _error;
  bool _loading = true;
  bool _connecting = false;

  String get _hostId => widget.hostId;

  @override
  void initState() {
    super.initState();
    // The app closes the tunnel when backgrounded (app.dart); reopen it on return.
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(_connect()));
    unawaited(_connect());
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    unawaited(ref.read(pipeManagerProvider).closeWeb(_hostId));
    super.dispose();
  }

  void _link(LinkState state) => ref.read(linkStateProvider(_hostId).notifier).state = state;

  Future<void> _connect() async {
    if (_connecting) return;
    _connecting = true;
    setState(() => _error = null);
    _link(LinkState.connecting);
    try {
      final session = ref.read(hostSessionProvider(_hostId));
      if (session == null) throw const ApiException(status: 403, code: 'DEVICE_REVOKED', message: 'not paired');
      final web = await session.api.webSession();
      final host = ref.read(hostsProvider).valueOrNull?.where((h) => h.hostId == _hostId).firstOrNull;
      final port = await ref.read(pipeManagerProvider).openWeb(_hostId, () => host?.ticket ?? session.host.ticket);
      if (!mounted) return;
      _link(LinkState.online);
      // A new port is a new origin: DSH needs a fresh login there. The same port keeps the page.
      if (_controller == null || port != _port) {
        _port = port;
        final controller = _controller ?? _createController();
        setState(() {
          _controller = controller;
          _loading = true;
        });
        await controller.loadRequest(Uri.parse('http://127.0.0.1:$port/?${web.tokenQuery}'));
      }
      unawaited(refreshTicket(ref, _hostId));
    } on ApiException catch (error) {
      if (error.deviceGone) {
        _link(LinkState.revoked);
        unawaited(ref.read(hostsProvider.notifier).edit(_hostId, (h) => h.copyWith(revoked: true)));
      } else {
        _link(error.code == 'PROTOCOL_UNSUPPORTED' ? LinkState.outdated : LinkState.offline);
      }
      if (mounted) setState(() => _error = describeError(error));
    } on PipeException catch (error) {
      _link(LinkState.offline);
      if (mounted) setState(() => _error = 'Cannot reach the home lab: ${error.message}');
    } catch (error) {
      // Never leave the screen spinning on an unexpected failure.
      _link(LinkState.offline);
      if (mounted) setState(() => _error = 'Could not open DSH Web: $error');
    } finally {
      _connecting = false;
    }
  }

  WebViewController _createController() {
    final controller = WebViewController();
    unawaited(controller.setJavaScriptMode(JavaScriptMode.unrestricted));
    unawaited(controller.setNavigationDelegate(NavigationDelegate(
      onNavigationRequest: (request) {
        final uri = Uri.tryParse(request.url);
        if (uri == null) return NavigationDecision.prevent;
        // DSH Web itself, and blank frames it creates.
        if ((uri.host == '127.0.0.1' && uri.port == _port) || uri.scheme == 'about') return NavigationDecision.navigate;
        // Anything else leaves the tunnel: hand top-level links to the system browser.
        if (request.isMainFrame && (uri.scheme == 'https' || uri.scheme == 'http' || uri.scheme == 'mailto')) {
          unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));
        }
        return NavigationDecision.prevent;
      },
      onPageStarted: (_) => mounted ? setState(() => _loading = true) : null,
      onPageFinished: (_) => mounted ? setState(() => _loading = false) : null,
      onWebResourceError: (error) {
        if (error.isForMainFrame != false && mounted) {
          setState(() => _error = 'Lost the connection to DSH Web.');
          _link(LinkState.offline);
        }
      },
    )));
    return controller;
  }

  Future<void> _back() async {
    final controller = _controller;
    if (controller != null && await controller.canGoBack()) {
      await controller.goBack();
    } else if (mounted) {
      context.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final host = ref.watch(hostsProvider).valueOrNull?.where((h) => h.hostId == _hostId).firstOrNull;
    final link = ref.watch(linkStateProvider(_hostId));
    final controller = _controller;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_back());
      },
      child: Scaffold(
        appBar: AppBar(
          toolbarHeight: 44,
          title: Row(children: [
            LinkDot(link),
            const SizedBox(width: 8),
            Flexible(child: Text(host?.name ?? 'DSH', overflow: TextOverflow.ellipsis)),
          ]),
          actions: [
            IconButton(tooltip: 'Reload', icon: const Icon(Icons.refresh), onPressed: controller == null ? _connect : () => controller.reload()),
            IconButton(tooltip: 'Connection and host settings', icon: const Icon(Icons.settings_outlined), onPressed: () => context.push('/host/$_hostId/settings')),
          ],
        ),
        body: Column(children: [
          if (_loading && _error == null) const LinearProgressIndicator(minHeight: 2),
          if (_error != null)
            MaterialBanner(
              content: Text(_error!),
              actions: [TextButton(onPressed: link == LinkState.revoked ? () => context.go('/') : _connect, child: Text(link == LinkState.revoked ? 'Back' : 'Try again'))],
            ),
          Expanded(
            child: controller == null
                ? Center(child: _error == null ? const Text('Opening DSH Web…') : const SizedBox.shrink())
                : WebViewWidget(controller: controller),
          ),
        ]),
      ),
    );
  }
}
