import 'dart:async';

import 'package:flutter/foundation.dart';
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
import '../../state/pipe_manager.dart';
import '../../state/providers.dart';
import '../../transport/iroh_pipe.dart';
import '../../ui/theme.dart';
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

/// dsh-mobile-maxxing's "≈ N tok/s" label (up to 1.0.0) asks for the speed every
/// 500 ms without waiting for the last answer. When the tunnel stalls (an app
/// killed and reopened), the requests pile up, take all of the WebView's
/// connections to the host, and DSH Web never connects again. This keeps one
/// such request in flight, gives it 4 s, and hands its answer to the polls
/// that arrive meanwhile.
const _liveSpeedGuard = r'''
(() => {
  if (window.__dshRemoteLiveSpeed) return;
  window.__dshRemoteLiveSpeed = true;
  const original = window.fetch;
  let inFlight = null;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    if (typeof url !== 'string' || !url.includes('/api/rdsh-mobile-ux/live-speed')) return original.apply(this, arguments);
    if (inFlight === null) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      inFlight = original.call(this, input, { ...init, signal: controller.signal }).finally(() => {
        clearTimeout(timer);
        inFlight = null;
      });
    }
    return inFlight.then((response) => response.clone());
  };
})();
''';

/// The colour of DSH Web's bottom edge, for the strip behind Android's navigation bar.
const _bottomColor = r'''
(() => {
  for (let e = document.elementFromPoint(innerWidth / 2, innerHeight - 1); e; e = e.parentElement) {
    const color = getComputedStyle(e).backgroundColor;
    if (color && color !== 'transparent' && !/, 0\)$/.test(color)) return color;
  }
  return getComputedStyle(document.body).backgroundColor;
})()
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

  /// Read up front: `ref` is gone by the time [dispose] runs.
  late final PipeManager _pipes;
  Timer? _watch;
  int? _port;
  String? _error;
  bool _loading = true;

  /// The host's DSH Web lacks dsh-mobile-maxxing, and the user has not hidden the note.
  bool _noPhoneLayout = false;

  /// DSH Web's bottom edge (light or dark theme), behind Android's navigation bar.
  Color? _pageColor;
  bool _connecting = false;

  /// A link check is under way (its probe can take seconds).
  bool _checking = false;

  /// DSH Web's page failed to load (the WebView shows an error page), or the
  /// tunnel stalled under it: telling such a page the network is back does
  /// nothing, so the next connect loads DSH Web afresh.
  bool _pageFailed = false;

  String get _hostId => widget.hostId;

  @override
  void initState() {
    super.initState();
    _pipes = ref.read(pipeManagerProvider)..retainWeb(widget.hostId);
    // The app closes the tunnel when backgrounded (app.dart); reopen it on return.
    _lifecycle = AppLifecycleListener(onHide: () => _signalPage(online: false), onResume: () => unawaited(_connect()));
    // After this build: the link state it sets is watched by the host list, and
    // by the screen this one replaces when a notification is tapped.
    unawaited(Future.microtask(_connect));
    _watch = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_checkLink()));
    ref.listenManual(networkChangesProvider, (_, __) => unawaited(_checkLink()));
  }

  /// Keeps the tunnel up while DSH Web is open. DSH Web retries on its own, but
  /// its retries cannot reopen this phone's window or redial a host that was
  /// down, so when the tunnel's connection is gone, or up with nothing coming
  /// back on it (the probe hangs that one up), or the first open failed, this
  /// reopens it quietly, and DSH Web reconnects as soon as it is back.
  Future<void> _checkLink() async {
    if (_connecting || _checking || !_inForeground) return;
    final link = ref.read(linkStateProvider(_hostId));
    if (link == LinkState.revoked || link == LinkState.outdated) return;
    if (_port == null) {
      if (_error != null) await _connect(quiet: true);
      return;
    }
    _checking = true;
    try {
      final status = await _pipes.status(_hostId).catchError((_) => const PipeStatus(connected: false, paths: []));
      if (!mounted || _connecting) return;
      final up = status.webConnected == true;
      final answers = up && !_pageFailed && await _pipes.probeWeb(_hostId);
      if (!mounted || _connecting) return;
      if (answers) {
        _link(LinkState.online);
        unawaited(_matchPageColor());
      } else {
        // Up with nothing coming back (the probe hung it up): what DSH Web asked
        // for meanwhile is lost, and a page that was starting stays half built.
        if (up) _pageFailed = true;
        await _connect(quiet: true);
      }
    } finally {
      _checking = false;
    }
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _watch?.cancel();
    unawaited(_pipes.releaseWeb(_hostId));
    super.dispose();
  }

  void _link(LinkState state) {
    if (mounted) ref.read(linkStateProvider(_hostId).notifier).state = state;
  }

  /// The tunnel stays closed in the background (app.dart): while it is open the
  /// host counts the phone as present and sends it no notifications. Android
  /// keeps the app running there, timers included.
  bool get _inForeground {
    final state = WidgetsBinding.instance.lifecycleState;
    return state == null || state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;
  }

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
      // A notification tapped on a cold start opens this screen before the
      // hosts have loaded from the secure store: wait for them.
      await ref.read(hostsProvider.future);
      if (!mounted) return;
      final session = ref.read(hostSessionProvider(_hostId));
      if (session == null) {
        // Not paired on this phone (forgotten since): nothing to open.
        context.go('/');
        return;
      }
      final web = await _openWindow(session);
      // A notification tapped while this screen was open replaced it meanwhile.
      if (!mounted) return;
      setState(() => _noPhoneLayout = web.phoneLayout == false);
      final host = ref.read(hostsProvider).valueOrNull?.where((h) => h.hostId == _hostId).firstOrNull;
      // The host accepted this phone's signed request: an earlier refusal no longer holds.
      if (host?.revoked == true) unawaited(ref.read(hostsProvider.notifier).edit(_hostId, (h) => h.copyWith(revoked: false)));
      final port = await ref.read(pipeManagerProvider).openWeb(_hostId, () => host?.ticket ?? session.host.ticket);
      if (!mounted) return;
      if (!_inForeground) {
        // The app left while this was opening: close it again; the return reopens it.
        unawaited(ref.read(pipeManagerProvider).closeWeb(_hostId));
        return;
      }
      _link(LinkState.online);
      if (_error != null) setState(() => _error = null);
      // A new port is a new origin: DSH needs a fresh login there. The same port
      // keeps the page, unless the page itself failed to load.
      if (_controller == null || port != _port || _pageFailed) {
        _port = port;
        _pageFailed = false;
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
      if (!mounted) return;
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
        unawaited(controller.runJavaScript(_liveSpeedGuard).catchError((_) {}));
        unawaited(controller.runJavaScript(_embeddedStyle).catchError((_) {}));
        if (mounted) setState(() => _loading = false);
        // DSH Web paints its theme a moment after the load.
        unawaited(Future<void>.delayed(const Duration(seconds: 1), _matchPageColor));
      },
      onWebResourceError: (error) {
        if (error.isForMainFrame != false && mounted) {
          _pageFailed = true;
          setState(() => _error = 'Lost the connection to DSH Web.');
          _link(LinkState.offline);
        }
      },
    )));
    return controller;
  }

  /// Gives the strip behind Android's navigation bar DSH Web's bottom colour.
  Future<void> _matchPageColor() async {
    final controller = _controller;
    if (controller == null || defaultTargetPlatform != TargetPlatform.android) return;
    final result = await controller.runJavaScriptReturningResult(_bottomColor).catchError((_) => '');
    final rgb = RegExp(r'rgba?\((\d+),\s*(\d+),\s*(\d+)').firstMatch('$result');
    if (rgb == null || !mounted) return;
    final color = Color.fromARGB(255, int.parse(rgb[1]!), int.parse(rgb[2]!), int.parse(rgb[3]!));
    if (color != _pageColor) setState(() => _pageColor = color);
  }

  /// Reload the page, reopening the window first: a host that lost it would refuse the reload.
  Future<void> _reload() async {
    // A page that failed to load is loaded afresh by the connect.
    final failed = _pageFailed;
    await _connect(quiet: true);
    if (!failed) await _controller?.reload();
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
    // Android: DSH Web stops above the navigation bar, as in a browser; behind the
    // bar is a strip of the page's own bottom colour. (On iOS the WebView and DSH
    // Web keep clear of the home indicator themselves.)
    final android = defaultTargetPlatform == TargetPlatform.android;
    final strip = android ? _pageColor : null;
    final page = Column(children: [
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
    ]);
    final screen = PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_back());
      },
      child: Scaffold(
        backgroundColor: strip,
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
        body: android ? SafeArea(top: false, child: page) : page,
      ),
    );
    // Always wrapped, so the page colour arriving does not change the tree's
    // shape: a rebuilt subtree re-creates the WebView's platform view.
    final style = overlayStyle(Theme.of(context).brightness);
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: strip == null
          ? style
          // The bar's icons stay readable on a dark page as on a light one.
          : style.copyWith(systemNavigationBarColor: strip, systemNavigationBarIconBrightness: strip.computeLuminance() > 0.5 ? Brightness.dark : Brightness.light),
      child: screen,
    );
  }
}
