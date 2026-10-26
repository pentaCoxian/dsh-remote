// The app's transport end to end on the development machine: the real
// PairingController and HostApi, then the DSH Web tunnel, through the real
// Rust pipe (dart:ffi) and QUIC, to the host plugin (packages/dsh-plugin
// test/fixtures/iroh-host.ts, with a fake DSH Web behind it). Only the keystore
// and secure storage are fakes: the fixture signs with P-256 for us. Opt-in:
//   (cd native/dshr_pipe && cargo build)
//   DSHR_PIPE_LIB=$PWD/native/dshr_pipe/target/debug/libdshr_pipe.dylib DSHR_FIXTURE_NODE=$(which node) \
//     flutter test test/pipe_e2e_test.dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_remote/core/protocol.dart';
import 'package:dsh_remote/device_keys/device_keys.dart';
import 'package:dsh_remote/state/pairing.dart';
import 'package:dsh_remote/state/pipe_manager.dart';
import 'package:dsh_remote/state/providers.dart';
import 'package:dsh_remote/storage/secure_store.dart';
import 'package:dsh_remote/transport/iroh_pipe.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/web_login.dart';

/// The Node host fixture: one JSON line out per JSON line in.
class _Fixture {
  _Fixture._(this._process) {
    _process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (_waiting.isNotEmpty) {
        _waiting.removeAt(0).complete(line);
      } else {
        _ready.add(line);
      }
    });
  }

  final Process _process;
  final _waiting = <Completer<String>>[];
  final _ready = <String>[];
  Future<void> _tail = Future.value();
  late final String hostId;
  late final String url;

  static Future<_Fixture> start(String node) async {
    final process = await Process.start(node, ['--conditions=source', 'test/fixtures/iroh-host.ts'], workingDirectory: '../../packages/dsh-plugin');
    process.stderr.transform(utf8.decoder).listen(stderr.write);
    final fixture = _Fixture._(process);
    final hello = jsonDecode(await fixture._next()) as Map<String, dynamic>;
    fixture.hostId = hello['hostId'] as String;
    fixture.url = hello['url'] as String;
    return fixture;
  }

  Future<String> _next() {
    if (_ready.isNotEmpty) return Future.value(_ready.removeAt(0));
    final completer = Completer<String>();
    _waiting.add(completer);
    return completer.future;
  }

  /// Requests are answered in order, so they are sent one at a time.
  Future<Map<String, dynamic>> call(Map<String, Object> request) {
    final reply = _tail.then((_) {
      _process.stdin.writeln(jsonEncode(request));
      return _next();
    });
    _tail = reply.then((_) {}, onError: (_) {});
    return reply.then((line) => jsonDecode(line) as Map<String, dynamic>);
  }

  Future<void> stop() async {
    await _process.stdin.close();
    await _process.exitCode.timeout(const Duration(seconds: 10), onTimeout: () {
      _process.kill();
      return -1;
    });
  }
}

/// The phone's keystore, played by the fixture (Dart has no P-256).
class _FixtureKeys implements DeviceKeys {
  _FixtureKeys(this.fixture);
  final _Fixture fixture;

  @override
  Future<DeviceKey> generate(String alias) async =>
      DeviceKey(alias: alias, publicKey: (await fixture.call({'op': 'generate', 'alias': alias}))['publicKey'] as String, hardwareBacked: false);

  @override
  Future<Uint8List> sign(String alias, Uint8List data) async =>
      base64Decode((await fixture.call({'op': 'sign', 'alias': alias, 'data': base64Encode(data)}))['signature'] as String);

  @override
  Future<bool> verify(String spkiBase64Url, Uint8List data, Uint8List signature) => throw UnimplementedError();

  @override
  Future<void> delete(String alias) async {}
}

void main() {
  final node = Platform.environment['DSHR_FIXTURE_NODE'];
  final skip = Platform.environment['DSHR_PIPE_LIB'] == null || node == null ? 'set DSHR_PIPE_LIB and DSHR_FIXTURE_NODE' : false;

  test('pairs, then opens DSH Web through the tunnel', () async {
    final fixture = await _Fixture.start(node!);
    addTearDown(fixture.stop);
    final socketDir = Directory.systemTemp.createTempSync('dshr');
    final container = ProviderContainer(overrides: [
      secureStoreProvider.overrideWithValue(MemorySecureStore()),
      deviceKeysProvider.overrideWithValue(_FixtureKeys(fixture)),
      pipeManagerProvider.overrideWith((ref) => PipeManager(pipe: const NativeIrohPipe(), store: ref.watch(secureStoreProvider), relays: const [], socketDir: socketDir.path)),
    ]);
    addTearDown(() async {
      await container.read(pipeManagerProvider).pause();
      container.dispose();
      socketDir.deleteSync(recursive: true);
    });

    // Pairing: the QR text the host printed, dialed through the pipe and approved on the host.
    final payload = PairingPayload.parse(fixture.url)!;
    container.listen(pairingProvider(payload), (_, __) {});
    await container.read(pairingProvider(payload).notifier).start('Dart test phone');
    final paired = container.read(pairingProvider(payload));
    expect(paired.step, PairingStep.done, reason: paired.message);
    expect(paired.hostId, fixture.hostId);
    final host = (await container.read(hostsProvider.future)).single;
    expect(host.name, 'Home Lab');

    // The signed request opens this phone's web window; the tunnel then serves DSH Web.
    final session = container.read(hostSessionProvider(fixture.hostId))!;
    final web = await session.api.webSession();
    final pipes = container.read(pipeManagerProvider);
    final port = await pipes.openWeb(fixture.hostId, () => host.ticket);
    expect(port, PipeManager.webPortFor(fixture.hostId), reason: 'the stable per-host port, when free');
    expect(await webLogin(port, web.tokenQuery), contains('DeepSeek Harness'));

    // The connection details sheet reads the same pipe.
    final status = await pipes.status(fixture.hostId);
    expect(status.connected, isTrue);
    expect(status.remoteId, fixture.hostId);
    expect(status.webPort, port);
    expect(status.selected?.relay, isFalse);

    // Backgrounding closes the endpoint; reopening finds the same port, so DSH Web keeps its origin.
    await pipes.pause();
    await session.api.webSession();
    expect(await pipes.openWeb(fixture.hostId, () => host.ticket), port);
    expect(await webLogin(port, web.tokenQuery), contains('DeepSeek Harness'));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 2)));

  test('a pipe error surfaces as an unreachable host, not a crash', () async {
    final manager = PipeManager(pipe: const NativeIrohPipe(), store: MemorySecureStore(), relays: const [], socketDir: Directory.systemTemp.path);
    addTearDown(manager.pause);
    await expectLater(manager.hostIdOf('endpointnotaticket'), throwsA(isA<PipeException>()));
  }, skip: skip);
}
