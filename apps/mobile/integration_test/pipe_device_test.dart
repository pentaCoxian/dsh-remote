// On a simulator or phone, with nothing faked: the bundled native pipe, the
// platform keystore and Keychain/Keystore storage pair with the host plugin
// fixture, then open DSH Web (a fake behind the fixture) through the tunnel.
//   (cd ../../packages/dsh-plugin && node --conditions=source test/fixtures/iroh-host.ts --offers 47123)
//   flutter test integration_test/pipe_device_test.dart -d <device> --dart-define=DSHR_FIXTURE=http://127.0.0.1:47123
// The fixture serves direct addresses only (relays off), so the device must reach
// the machine running it: an iOS simulator always can (same host).
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/core/protocol.dart';
import 'package:dsh_remote/state/pairing.dart';
import 'package:dsh_remote/state/providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/support/web_login.dart';

const _fixture = String.fromEnvironment('DSHR_FIXTURE');

/// A fresh pairing code from the fixture (codes expire after 120 s).
Future<String> _freshOffer() async {
  final client = HttpClient();
  try {
    final response = await (await client.getUrl(Uri.parse('$_fixture/offer'))).close();
    return (jsonDecode(await response.transform(utf8.decoder).join()) as Map<String, dynamic>)['url'] as String;
  } finally {
    client.close();
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('pairs and opens DSH Web over the native pipe', (tester) async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    expect(_fixture, isNotEmpty, reason: 'pass --dart-define=DSHR_FIXTURE=http://127.0.0.1:<port>');

    await tester.runAsync(() async {
      final payload = PairingPayload.parse(await _freshOffer());
      expect(payload, isNotNull);
      container.listen(pairingProvider(payload!), (_, __) {});
      await container.read(pairingProvider(payload).notifier).start('Integration phone');
      final paired = container.read(pairingProvider(payload));
      expect(paired.step, PairingStep.done, reason: paired.message);
      final hostId = paired.hostId!;

      // The signed request opens this phone's web window; the tunnel then serves DSH Web.
      final session = container.read(hostSessionProvider(hostId))!;
      final web = await session.api.webSession();
      final port = await container.read(pipeManagerProvider).openWeb(hostId, () => paired.payload.ticket);
      expect(await webLogin(port, web.tokenQuery), contains('DeepSeek Harness'));

      final status = await container.read(pipeManagerProvider).status(hostId);
      expect(status.connected, isTrue);
      expect(status.remoteId, hostId);
      final path = status.selected;
      // The phone's own home relay comes up in the background (after its first net report).
      var homeRelay = status.homeRelay;
      for (var i = 0; i < 40 && homeRelay == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 250));
        homeRelay = (await container.read(pipeManagerProvider).status(hostId)).homeRelay;
      }
      // ignore: avoid_print
      print('DSHR path: ${path == null ? 'none' : path.relay ? 'relay' : 'direct'}, rtt ${path?.rttMs} ms, phone relay $homeRelay');

      // Clean up what pairing stored on the device.
      await container.read(hostsProvider.notifier).remove(hostId);
      await container.read(pipeManagerProvider).pause();
    });
  });
}
