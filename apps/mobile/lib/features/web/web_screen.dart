import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../../core/errors.dart';
import '../../push/push_registration.dart';
import '../../state/host_session.dart';
import '../../state/link.dart';
import '../../state/providers.dart';
import '../../transport/iroh_pipe.dart';
import '../../ui/widgets.dart';
import '../../widgets/status.dart';

/// dsh-mobile-maxxing's browser-only pieces (the "Add to Home Screen" card, the
/// install button in the drawer and the PWA settings section) do not apply here:
/// DSH Web runs inside this app, not in a browser tab, and a home-screen copy
/// would point at this app's private tunnel port. Its Update tab (1.0.0) shares
/// the section's class and stays: it updates the plugin on the host. Class names
/// as of 0.6.0 to 1.0.0.
const _embeddedStyle = '''
(() => {
  if (document.getElementById('dsh-remote-embedded')) return;
  const style = document.createElement('style');
  style.id = 'dsh-remote-embedded';
  style.textContent = '.dsh-mobile-maxxing-install, .dsh-mobile-maxxing-foot, .dsh-mobile-maxxing-section:not(:has(.rdsh-update-launch)) { display: none !important; }';
  document.head.append(style);
})();
''';

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
  Timer? _watch;
  int? _port;
  String? _error;
  bool _loading = true;

  /// The host's DSH Web lacks dsh-mobile-maxxing, and the user has not hidden the note.
  bool _noPhoneLayout = false;
  bool _connecting = false;

  String get _hostId => widget.hostId;

  @override
  void initState() {
    super.initState();
    // The app closes the tunnel when backgrounded (app.dart); reopen it on return.
    _lifecycle = AppLifecycleListener(onHide: () => _signalPage(online: false), onResume: () => unawaited(_connect()));
    unawaited(_connect());
    _watch = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_checkLink()));
    ref.listenManual(networkChangesProvider, (_, __) => unawaited(_checkLink()));
  }

  /// Keeps the tunnel up while DSH Web is open. DSH Web retries on its own, but
  /// its retries cannot reopen this phone's window or redial a host that was
  /// down, so when the tunnel's connection is gone (or the first open failed)
  /// this reopens it quietly, and DSH Web reconnects as soon as it is back.
  Future<void> _checkLink() async {
    if (_connecting) return;
    final link = ref.read(linkStateProvider(_hostId));
    if (link == LinkState.revoked || link == LinkState.outdated) return;
    if (_port == null) {
      if (_error != null) await _connect(quiet: true);
      return;
    }
    final status = await ref.read(pipeManagerProvider).status(_hostId).catchError((_) => const PipeStatus(connected: false, paths: []));
    if (!mounted || _connecting) return;
    if (status.webConnected == true) {
      _link(LinkState.online);
    } else {
      await _connect(quiet: true);
    }
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _watch?.cancel();
    unawaited(ref.read(pipeManagerProvider).closeWeb(_hostId));
    super.dispose();
  }

  void _link(LinkState state) => ref.read(linkStateProvider(_hostId).notifier).state = state;

  /// Opens (or reopens) this phone's DSH Web window and its tunnel. A [quiet]
  /// retry leaves the page and any notice as they are unless it succeeds.
  Future<void> _connect({bool quiet = false}) async {
    if (_connecting) return;
    _connecting = true;
    if (!quiet) {
      setState(() => _error = null);
      _link(LinkState.connecting);
    }
    try {
      final session = ref.read(hostSessionProvider(_hostId));
      if (session == null) throw const ApiException(status: 403, code: 'DEVICE_REVOKED', message: 'not paired');
      final web = await _openWindow(session);
      if (mounted) setState(() => _noPhoneLayout = web.phoneLayout == false);
      final host = ref.read(hostsProvider).valueOrNull?.where((h) => h.hostId == _hostId).firstOrNull;
      final port = await ref.read(pipeManagerProvider).openWeb(_hostId, () => host?.ticket ?? session.host.ticket);
      if (!mounted) return;
      _link(LinkState.online);
      if (_error != null) setState(() => _error = null);
      // A new port is a new origin: DSH needs a fresh login there. The same port keeps the page.
      if (_controller == null || port != _port) {
        _port = port;
        final controller = _controller ?? _createController();
        setState(() {
          _controller = controller;
          _loading = true;
        });
        await controller.loadRequest(Uri.parse('http://127.0.0.1:$port/?${web.tokenQuery}'));
      } else {
        // The same page, and the tunnel answers again: DSH Web reconnects now, not after its backoff.
        _signalPage(online: true);
      }
      unawaited(refreshTicket(ref, _hostId));
      // Keep this host able to notify the phone (asks for the OS permission the first time).
      if (!quiet) unawaited(ref.read(pushRegistrarProvider).sync(session, ask: true).then((_) {}, onError: (_) {}));
    } on ApiException catch (error) {
      if (error.deviceGone) {
        _link(LinkState.revoked);
        unawaited(ref.read(hostsProvider.notifier).edit(_hostId, (h) => h.copyWith(revoked: true)));
      } else {
        _link(error.code == 'PROTOCOL_UNSUPPORTED' ? LinkState.outdated : LinkState.offline);
      }
      if (mounted && (!quiet || error.deviceGone)) setState(() => _error = describeError(error));
    } on PipeException catch (error) {
      _link(LinkState.offline);
      if (mounted && !quiet) setState(() => _error = error.describe);
    } catch (error) {
      // Never leave the screen spinning on an unexpected failure.
      _link(LinkState.offline);
      if (mounted && !quiet) setState(() => _error = 'Could not open DSH Web: $error');
    } finally {
      _connecting = false;
    }
  }

  /// Opens the window (`POST /v1/web/session`). A connection that looks open but
  /// carries nothing (a path the network change broke) would hold this for the
  /// client's 20 s timeout, and every retry on it after that: past 8 s the app
  /// hangs up and asks again on a new connection.
  Future<({String tokenQuery, DateTime expiresAt, bool? phoneLayout})> _openWindow(HostSession session) async {
    try {
      return await session.api.webSession().timeout(const Duration(seconds: 8));
    } on TimeoutException {
      await ref.read(pipeManagerProvider).reconnect(_hostId);
      return session.api.webSession();
    }
  }

  /// DSH Web's connection client stops retrying while the page is offline and
  /// reconnects at once, with a fresh backoff, when it comes back online. The
  /// tunnel closes in the background, so the page hears about it as the network.
  void _signalPage({required bool online}) {
    final controller = _controller;
    if (controller == null) return;
    unawaited(controller.runJavaScript("dispatchEvent(new Event('${online ? 'online' : 'offline'}'))").catchError((_) {}));
  }

  WebViewController _createController() {
    final controller = WebViewController();
    // Android gives the WebView insets for the whole screen; DSH Web sits below this app's bar (WebViewInsets.kt).
    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      unawaited(const MethodChannel('dev.dshremote/webview').invokeMethod<void>('fitToPosition', {'id': platform.webViewIdentifier}).catchError((_) {}));
    }
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
      onPageFinished: (_) {
        unawaited(controller.runJavaScript(_embeddedStyle).catchError((_) {}));
        if (mounted) setState(() => _loading = false);
      },
      onWebResourceError: (error) {
        if (error.isForMainFrame != false && mounted) {
          setState(() => _error = 'Lost the connection to DSH Web.');
          _link(LinkState.offline);
        }
      },
    )));
    return controller;
  }

  /// Reload the page, reopening the window first: a host that lost it would refuse the reload.
  Future<void> _reload() async {
    await _connect(quiet: true);
    await _controller?.reload();
  }

  Future<void> _back() async {
    final controller = _controller;
    if (controller != null && await controller.canGoBack()) {
      await controller.goBack();
    } else if (mounted) {
      leave(context);
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
        // A thin strip: DSH Web brings its own chrome.
        appBar: shellBar(
          context,
          height: 46,
          title: Row(children: [
            LinkDot(link),
            const SizedBox(width: 10),
            Flexible(child: Text(host?.name ?? 'DSH', overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600))),
          ]),
          actions: [
            IconButton(tooltip: 'Reload', icon: const Icon(LucideIcons.rotateCw, size: 18), onPressed: controller == null ? _connect : _reload),
            IconButton(tooltip: 'Connection and host settings', icon: const Icon(LucideIcons.settings2, size: 18), onPressed: () => context.push('/host/$_hostId/settings')),
          ],
        ),
        body: Column(children: [
          SizedBox(height: 2, child: _loading && _error == null ? const LinearProgressIndicator(minHeight: 2) : null),
          if (_noPhoneLayout && _error == null)
            Notice(
              text: 'DSH Web on this host has no phone layout. Install dsh-mobile-maxxing there; `dsh-remote doctor` shows how.',
              action: 'Hide',
              onAction: () => setState(() => _noPhoneLayout = false),
            ),
          if (_error != null)
            Notice(
              text: _error!,
              danger: true,
              action: link == LinkState.revoked ? 'Back' : 'Try again',
              onAction: link == LinkState.revoked ? () => context.go('/') : _connect,
            ),
          Expanded(
            child: controller == null
                ? Center(child: _error == null ? Text('Opening DSH Web…', style: Theme.of(context).textTheme.bodySmall) : const SizedBox.shrink())
                : WebViewWidget(controller: controller),
          ),
        ]),
      ),
    );
  }
}
