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
/// It has no web tunnel: the screen stops after the signed request.
class _Pipe implements IrohPipe {
  _Pipe(this.socketPath);
  final String socketPath;

  @override
  Future<String> start(List<int> secretKey, List<String> relays) async => 'phone';

  @override
  Future<PipeHandle> open(String ticket, String socketPath) async => PipeHandle(hostId: _hostId, socketPath: this.socketPath);

  @override
  Future<int> openWeb(String hostId, int preferredPort) => Future.error(const PipeException('no web tunnel here'));

  @override
  Future<void> closeWeb(String hostId) async {}

  @override
  Future<void> close(String hostId) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
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

  setUp(() async {
    // The test binding answers every HttpClient with 400; this host is real.
    HttpOverrides.global = null;
    dir = Directory.systemTemp.createTempSync('dshr');
    host = await _Host.start('${dir.path}/host');
  });

  tearDown(() async {
    await host.stop();
    dir.deleteSync(recursive: true);
  });

  Future<ProviderContainer> open(WidgetTester tester, SecureStore store) async {
    final container = ProviderContainer(overrides: [
      secureStoreProvider.overrideWithValue(store),
      deviceKeysProvider.overrideWithValue(_Keys()),
      pipeManagerProvider.overrideWith((ref) => PipeManager(pipe: _Pipe(host.path), store: ref.watch(secureStoreProvider), relays: const [], socketDir: dir.path)),
    ]);
    await tester.pumpWidget(UncontrolledProviderScope(container: container, child: MaterialApp(theme: buildTheme(Brightness.light), home: const WebScreen(hostId: _hostId))));
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

  Future<void> close(WidgetTester tester, ProviderContainer container) async {
    await tester.pumpWidget(const SizedBox());
    container.dispose();
  }

  PairedHost stored(ProviderContainer container) => container.read(hostsProvider).requireValue.single;

  testWidgets('opened before the hosts have loaded (a notification on a cold start), it asks the host', (tester) async {
    final store = _SlowStore();
    await HostStore(store).save([_paired()]);
    final container = await open(tester, store);
    expect(container.read(hostsProvider).isLoading, isTrue);

    store.ready.complete();
    await until(tester, () => host.routes.isNotEmpty);
    expect(host.routes, ['POST /v1/web/session']);
    expect(stored(container).revoked, isFalse);
    expect(container.read(linkStateProvider(_hostId)), isNot(LinkState.revoked));
    await close(tester, container);
  });

  testWidgets('a host marked revoked is asked again, and clears when it answers', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired(revoked: true)]);
    final container = await open(tester, store);

    await until(tester, () => container.read(hostsProvider).valueOrNull?.single.revoked == false);
    expect(host.routes, ['POST /v1/web/session']);
    await close(tester, container);
  });

  testWidgets('the host refusing this phone marks it revoked', (tester) async {
    final store = MemorySecureStore();
    await HostStore(store).save([_paired()]);
    host.answer = () => (403, {'error': {'code': 'DEVICE_REVOKED', 'message': 'revoked'}});
    final container = await open(tester, store);

    await until(tester, () => container.read(hostsProvider).valueOrNull?.single.revoked == true);
    expect(container.read(linkStateProvider(_hostId)), LinkState.revoked);
    expect(find.text('Access removed by the host.'), findsOneWidget);
    await close(tester, container);
  });
}
