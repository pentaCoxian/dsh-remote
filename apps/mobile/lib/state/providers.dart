import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../device_keys/device_keys.dart';
import '../push/push_registration.dart';
import '../storage/host_store.dart';
import '../storage/secure_store.dart';
import '../transport/iroh_pipe.dart';
import 'host_session.dart';
import 'link.dart';
import 'pipe_manager.dart';

final secureStoreProvider = Provider<SecureStore>((_) => const PlatformSecureStore());
final deviceKeysProvider = Provider<DeviceKeys>((_) => const PlatformDeviceKeys());
final irohPipeProvider = Provider<IrohPipe>((_) => const NativeIrohPipe());
final pipeManagerProvider = Provider<PipeManager>((ref) => PipeManager(pipe: ref.watch(irohPipeProvider), store: ref.watch(secureStoreProvider)));

final hostsProvider = AsyncNotifierProvider<HostsController, List<PairedHost>>(HostsController.new);

class HostsController extends AsyncNotifier<List<PairedHost>> {
  HostStore get _store => HostStore(ref.read(secureStoreProvider));

  @override
  Future<List<PairedHost>> build() => _store.load();

  Future<void> _save(List<PairedHost> hosts) async {
    await _store.save(hosts);
    state = AsyncData(hosts);
  }

  Future<void> add(PairedHost host) async {
    final current = state.valueOrNull ?? await future;
    await _save([for (final h in current) if (h.hostId != host.hostId) h, host]);
  }

  Future<void> edit(String hostId, PairedHost Function(PairedHost) change) async {
    final current = state.valueOrNull ?? await future;
    await _save([for (final h in current) h.hostId == hostId ? change(h) : h]);
  }

  /// Forget a host on this phone: drop its key and pipe (the host still lists the device until revoked there).
  Future<void> remove(String hostId) async {
    final current = state.valueOrNull ?? await future;
    final host = current.where((h) => h.hostId == hostId).firstOrNull;
    if (host != null) {
      await ref.read(deviceKeysProvider).delete(host.keyAlias).catchError((_) {});
      await ref.read(pipeManagerProvider).close(hostId);
      await ref.read(pushRegistrarProvider).forget(hostId).catchError((_) {});
    }
    await _save([for (final h in current) if (h.hostId != hostId) h]);
  }
}

PairedHost? _host(Ref ref, String hostId) => ref.read(hostsProvider).valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;

final linkStateProvider = StateProvider.family<LinkState, String>((_, __) => LinkState.connecting);

/// Counts the phone's network changes (Android reports them; iroh sees iOS's itself).
final networkChangesProvider = StateProvider<int>((_) => 0);

/// The signed API of one host. Rebuilt only when its identity changes: a
/// refreshed ticket goes to the open pipe without tearing the session down.
/// Null while the hosts are still loading (await [hostsProvider] first) and for
/// a host not paired on this phone. A host marked revoked keeps its session:
/// only the host can say whether that still holds.
final hostSessionProvider = Provider.family<HostSession?, String>((ref, hostId) {
  final identity = ref.watch(hostsProvider.select((value) {
    final host = value.valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;
    return host == null ? null : (host.deviceId, host.keyAlias);
  }));
  final host = _host(ref, hostId);
  if (identity == null || host == null) return null;
  // The latest stored ticket, read whenever the pipe (re)opens.
  String ticket() => _host(ref, hostId)?.ticket ?? host.ticket;
  final session = HostSession(host: host, link: ref.read(pipeManagerProvider).link(hostId, ticket), keys: ref.read(deviceKeysProvider));
  ref.onDispose(session.dispose);
  return session;
});

/// Keep the stored ticket current, so the next dial (after a restart or a
/// network change) uses the host's latest relay and addresses.
Future<void> refreshTicket(WidgetRef ref, String hostId) async {
  final session = ref.read(hostSessionProvider(hostId));
  if (session == null) return;
  try {
    final address = await session.api.hostAddress();
    if (_hostOf(ref, hostId)?.ticket == address.ticket) return;
    await ref.read(hostsProvider.notifier).edit(hostId, (h) => h.copyWith(ticket: address.ticket));
    await ref.read(pipeManagerProvider).refresh(hostId, address.ticket);
  } catch (_) {
    // Best effort: the stored ticket still works while the host stays where it was.
  }
}

PairedHost? _hostOf(WidgetRef ref, String hostId) => ref.read(hostsProvider).valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;
