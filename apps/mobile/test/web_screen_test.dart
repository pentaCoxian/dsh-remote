import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_remote/device_keys/device_keys.dart';
import 'package:dsh_remote/features/web/web_screen.dart';
import 'package:dsh_remote/state/link.dart';
import 'package:dsh_remote/state/pipe_manager.dart';
import 'package:dsh_remote/state/providers.dart';
import 'package:dsh_remote/storage/host_store.dart';
import 'package:dsh_remote/storage/secure_store.dart';
import 'package:dsh_remote/transport/iroh_pipe.dart';
import 'package:dsh_remote/ui/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

const _hostId = '363957e22f03a9d524e912e511e5cfa0916df64f3db842424971690f2723f88d';

PairedHost _paired({bool revoked = false}) => PairedHost(
      hostId: _hostId,
      ticket: 'endpointticket',
      name: 'Home Lab',
      deviceId: 'dev_test',
      keyAlias: 'test',
      devicePublicKey: 'key',
      hardwareBacked: true,
      pairedAt: DateTime(2026),
      revoked: revoked,
    );

/// The secure store on a cold start: reads wait until the test lets them through.
class _SlowStore extends MemorySecureStore {
  final ready = Completer<void>();

  @override
  Future<String?> read(String key) async {
    await ready.future;
    return super.read(key);
  }
}

class _Keys implements DeviceKeys {
  @override
  Future<Uint8List> sign(String alias, Uint8List data) async => Uint8List(70);

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

/// The native pipe, with the host's end already listening at [socketPath].
/// Without a [webPort] it has no web tunnel: the screen stops after the signed request.
class _Pipe implements IrohPipe {
  _Pipe(this.socketPath, {this.webPort});
  final String socketPath;
  final int? webPort;
  var webClosed = 0;

  @override
  Future<String> start(List<int> secretKey, List<String> relays) async => 'phone';

  @override
  Future<PipeHandle> open(String ticket, String socketPath) async => PipeHandle(hostId: _hostId, socketPath: this.socketPath);

  @override
  Future<int> openWeb(String hostId, int preferredPort) async => webPort ?? (throw const PipeException('no web tunnel here'));

  @override
  Future<void> closeWeb(String hostId) async => webClosed++;

  @override
  Future<PipeStatus> status(String hostId) async => PipeStatus(connected: true, paths: const [], webPort: webPort, webConnected: webPort != null);

  /// Whether the tunnel answers its probe; a stalled one is hung up.
  var answers = true;
  var probes = 0;

  @override
  Future<bool> probeWeb(String hostId) async {
    probes++;
    return answers;
  }

  @override
  Future<void> close(String hostId) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

/// The WebView as the screen drives it: records page loads, and plays the page's events.
class _WebView extends WebViewPlatform {
  final loads = <String>[];
  late _Navigation navigation;

  @override
  PlatformWebViewController createPlatformWebViewController(PlatformWebViewControllerCreationParams params) => _Controller(params, loads);

  @override
  PlatformNavigationDelegate createPlatformNavigationDelegate(PlatformNavigationDelegateCreationParams params) => navigation = _Navigation(params);

  @override
  PlatformWebViewWidget createPlatformWebViewWidget(PlatformWebViewWidgetCreationParams params) => _View(params);

  /// The page fails to load, as when the tunnel drops under it.
  void failLoad() {
    navigation.started?.call(loads.last);
    navigation.error?.call(WebResourceError(errorCode: -6, description: 'net::ERR_CONNECTION_CLOSED', isForMainFrame: true, url: loads.last));
    navigation.finished?.call(loads.last);
  }
}

class _Controller extends PlatformWebViewController {
  _Controller(super.params, this.loads) : super.implementation();
  final List<String> loads;

  @override
  Future<void> loadRequest(LoadRequestParams params) async => loads.add('${params.uri}');

  @override
  Future<void> setJavaScriptMode(JavaScriptMode javaScriptMode) async {}

  @override
  Future<void> setPlatformNavigationDelegate(PlatformNavigationDelegate handler) async {}

  @override
  Future<void> runJavaScript(String javaScript) async {}

  @override
  Future<Object> runJavaScriptReturningResult(String javaScript) async => '';
}

class _Navigation extends PlatformNavigationDelegate {
  _Navigation(super.params) : super.implementation();
  PageEventCallback? started;
  PageEventCallback? finished;
  WebResourceErrorCallback? error;

  @override
  Future<void> setOnNavigationRequest(NavigationRequestCallback onNavigationRequest) async {}

  @override
  Future<void> setOnPageStarted(PageEventCallback onPageStarted) async => started = onPageStarted;

  @override
  Future<void> setOnPageFinished(PageEventCallback onPageFinished) async => finished = onPageFinished;

  @override
  Future<void> setOnWebResourceError(WebResourceErrorCallback onWebResourceError) async => error = onWebResourceError;
}

class _View extends PlatformWebViewWidget {
  _View(super.params) : super.implementation();

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}

/// The host: answers each request with [answer] and records its route.
class _Host {
  _Host._(this._server, this.path);
  final HttpServer _server;
  final String path;
  final routes = <String>[];
  (int, Object) Function() answer = () => (200, {'tokenQuery': 'token=t', 'expiresAt': 0});

  static Future<_Host> start(String path) async {
    final server = await HttpServer.bind(InternetAddress(path, type: InternetAddressType.unix), 0);
    final host = _Host._(server, path);
    server.listen((request) async {
      host.routes.add('${request.method} ${request.uri.path}');
      await request.drain<void>();
      final (status, body) = host.answer();
      request.response
        ..statusCode = status
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(body));
      await request.response.close();
    });
    return host;
  }

  Future<void> stop() => _server.close(force: true);
}

void main() {
  late Directory dir;
  late _Host host;
  late _WebView webView;

  setUp(() async {
    // The test binding answers every HttpClient with 400; this host is real.
    HttpOverrides.global = null;
    dir = Directory.systemTemp.createTempSync('dshr');
    host = await _Host.start('${dir.path}/host');
    WebViewPlatform.instance = webView = _WebView();
  });

  tearDown(() async {
    await host.stop();
    dir.deleteSync(recursive: true);
  });

  Widget app(ProviderContainer container, {Key? key}) =>
      UncontrolledProviderScope(container: container, child: MaterialApp(theme: buildTheme(Brightness.light), home: WebScreen(key: key, hostId: _hostId)));

  Future<ProviderContainer> open(WidgetTester tester, SecureStore store, {_Pipe? pipe}) async {
    final container = ProviderContainer(overrides: [
      secureStoreProvider.overrideWithValue(store),
      deviceKeysProvider.overrideWithValue(_Keys()),
      pipeManagerProvider.overrideWith((ref) => PipeManager(pipe: pipe ?? _Pipe(host.path), store: ref.watch(secureStoreProvider), relays: const [], socketDir: dir.path)),
    ]);
    await tester.pumpWidget(app(container));
    return container;
  }

  /// Lets the socket I/O run between frames, and the client's timers fire, until [done].
  Future<void> until(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
      await tester.pump(const Duration(milliseconds: 1));
    }
    expect(done(), isTrue);
  }

  /// Lets the screen's follow-up requests (after an open: the ticket refresh and
  /// the push sync) finish, until the host has heard nothing new for a while.
  Future<void> drain(WidgetTester tester) async {
    for (var seen = -1; seen != host.routes.length;) {
      seen = host.routes.length;
      for (var i = 0; i < 20; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
        await tester.pump(const Duration(milliseconds: 1));
      }
    }
  }

  /// Closes the screen once nothing it asked for is in flight.
  Future<void> close(WidgetTester tester, ProviderContainer container) async {
    await drain(tester);
    await tester.pumpWidget(const SizedBox());
    container.dispose();
  }

  PairedHost stored(ProviderContainer container) => container.read(hostsProvider).requireValue.single;

  /// The screen is done with its attempt (its request answered), so closing it leaves nothing in flight.
  bool settled(ProviderContainer container) => container.read(linkStateProvider(_hostId)) != LinkState.connecting;

  testWidgets('opened before the hosts have loaded (a notification on a cold start), it asks the host', (tester) async {
    final store = _SlowStore();
    await HostStore(store).save([_paired()]);
    final container = await open(tester, store);
    expect(container.read(hostsProvider).isLoading, isTrue);

    store.ready.complete();
    await until(tester, () => settled(container));
    expect(host.routes, ['POST /v1/web/session']);
    expect(stored(container).revoked, isFalse);
    expect(container.read(linkStateProvider(_hostId)), isNot(LinkState.revoked));
    await close(tester, container);
  });

  testWidgets('a host marked revoked is asked again, and clears when it answers', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired(revoked: true)]);
    final container = await open(tester, store);

    await until(tester, () => settled(container) && container.read(hostsProvider).valueOrNull?.single.revoked == false);
    expect(host.routes, ['POST /v1/web/session']);
    await close(tester, container);
  });

  testWidgets('the host refusing this phone marks it revoked', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired()]);
    host.answer = () => (403, {'error': {'code': 'DEVICE_REVOKED', 'message': 'revoked'}});
    final container = await open(tester, store);

    await until(tester, () => settled(container) && container.read(hostsProvider).valueOrNull?.single.revoked == true);
    expect(container.read(linkStateProvider(_hostId)), LinkState.revoked);
    expect(find.text('Access removed by the host.'), findsOneWidget);
    await close(tester, container);
  });

  const page = 'http://127.0.0.1:30123/?token=t';

  testWidgets('Try again loads DSH Web afresh when its page failed to load', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired()]);
    final container = await open(tester, store, pipe: _Pipe(host.path, webPort: 30123));
    await until(tester, () => settled(container) && webView.loads.length == 1);

    webView.failLoad();
    await tester.pump();
    expect(find.text('Lost the connection to DSH Web.'), findsOneWidget);

    // The tunnel is fine again; an error page would not hear about it.
    await tester.tap(find.text('Try again'));
    await until(tester, () => settled(container) && webView.loads.length == 2);
    expect(webView.loads, [page, page]);
    expect(find.text('Lost the connection to DSH Web.'), findsNothing);
    // The error page's colour check, a second after it finished.
    await tester.pump(const Duration(seconds: 1));
    await close(tester, container);
  });

  testWidgets('the link check loads a failed page again once the tunnel answers', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired()]);
    final container = await open(tester, store, pipe: _Pipe(host.path, webPort: 30123));
    await until(tester, () => settled(container) && webView.loads.length == 1);

    webView.failLoad();
    await tester.pump(const Duration(seconds: 5));
    await until(tester, () => settled(container) && webView.loads.length == 2);
    expect(webView.loads.last, page);
    await close(tester, container);
  });

  testWidgets('the link check reopens a tunnel that looks up but stopped answering, and loads DSH Web afresh', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired()]);
    final pipe = _Pipe(host.path, webPort: 30123);
    final container = await open(tester, store, pipe: pipe);
    await until(tester, () => settled(container) && webView.loads.length == 1);
    await drain(tester);
    int windows() => host.routes.where((route) => route == 'POST /v1/web/session').length;
    expect(windows(), 1);

    pipe.answers = false;
    await tester.pump(const Duration(seconds: 5));
    await until(tester, () => windows() == 2);
    expect(pipe.probes, 1);
    // What the page asked for while nothing came back is lost; it may never have started.
    await until(tester, () => webView.loads.length == 2);
    expect(webView.loads, [page, page]);
    await close(tester, container);
  });

  testWidgets('a screen replaced by another for the same host (a notification tap) leaves their tunnel open', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired()]);
    final pipe = _Pipe(host.path, webPort: 30123);
    final container = await open(tester, store, pipe: pipe);
    await until(tester, () => settled(container) && webView.loads.length == 1);

    await tester.pumpWidget(app(container, key: const ValueKey('from a notification')));
    await until(tester, () => settled(container) && webView.loads.length == 2);
    await drain(tester);
    expect(pipe.webClosed, 0);

    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(pipe.webClosed, 1);
    container.dispose();
  });
}
