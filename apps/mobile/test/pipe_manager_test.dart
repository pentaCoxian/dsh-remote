import 'dart:async';

import 'package:dsh_remote/state/pipe_manager.dart';
import 'package:dsh_remote/storage/secure_store.dart';
import 'package:dsh_remote/transport/iroh_pipe.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the calls as the native pipe sees them; each completes when the test says.
class _SlowPipe implements IrohPipe {
  final calls = <String>[];
  final pending = <Completer<void>>[];

  Future<void> _call(String name) {
    calls.add(name);
    final done = Completer<void>();
    pending.add(done);
    return done.future.then((_) => calls.add('$name done'));
  }

  void finishNext() => pending.removeAt(0).complete();

  @override
  Future<String> start(List<int> secretKey, List<String> relays) => _call('start').then((_) => 'phone');

  @override
  Future<PipeHandle> open(String ticket, String socketPath) => _call('open').then((_) => PipeHandle(hostId: 'host', socketPath: socketPath));

  @override
  Future<void> suspend() => _call('suspend');

  @override
  Future<void> networkChanged() => _call('network_changed');

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

void main() {
  test('a pause keeps the endpoint; the pipe after it waits for the pause and looks at the network again', () async {
    final pipe = _SlowPipe();
    final manager = PipeManager(pipe: pipe, store: MemorySecureStore(), relays: const []);

    // The app goes to the background while the endpoint is still starting…
    final first = manager.start();
    await pumpEventQueue();
    final pause = manager.pause();
    // …and comes back to a host before anything finished.
    final socket = manager.socketFor('0123456789abcdef', () => 'ticket');
    await pumpEventQueue();
    expect(pipe.calls, ['start'], reason: 'the suspend waits for the start in flight; the pipe waits for the suspend');

    pipe.finishNext();
    await first;
    await pumpEventQueue();
    expect(pipe.calls, ['start', 'start done', 'suspend']);

    pipe.finishNext();
    await pause;
    await pumpEventQueue();
    expect(pipe.calls, ['start', 'start done', 'suspend', 'suspend done', 'network_changed']);

    pipe.finishNext();
    await pumpEventQueue();
    pipe.finishNext();
    expect(await socket, endsWith('h01234567'));
    expect(pipe.calls, ['start', 'start done', 'suspend', 'suspend done', 'network_changed', 'network_changed done', 'open', 'open done'],
        reason: 'one endpoint for the life of the app: no second start');
  });
}
