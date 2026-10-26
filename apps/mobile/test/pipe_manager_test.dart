import 'dart:async';

import 'package:dsh_remote/state/pipe_manager.dart';
import 'package:dsh_remote/storage/secure_store.dart';
import 'package:dsh_remote/transport/iroh_pipe.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records start and stop as the native pipe sees them; each completes when the test says.
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
  Future<void> stop() => _call('stop');

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

void main() {
  test('a pause and the start after it never overlap in the native pipe', () async {
    final pipe = _SlowPipe();
    final manager = PipeManager(pipe: pipe, store: MemorySecureStore(), relays: const []);

    // The app goes to the background while the endpoint is still starting…
    final first = manager.start();
    await pumpEventQueue();
    final pause = manager.pause();
    // …and comes back before anything finished.
    final second = manager.start();
    await pumpEventQueue();
    expect(pipe.calls, ['start'], reason: 'stop waits for the start in flight; the next start waits for the stop');

    pipe.finishNext();
    await first;
    await pumpEventQueue();
    expect(pipe.calls, ['start', 'start done', 'stop']);

    pipe.finishNext();
    await pause;
    await pumpEventQueue();
    expect(pipe.calls, ['start', 'start done', 'stop', 'stop done', 'start']);

    pipe.finishNext();
    expect(await second, 'phone');
  });
}
