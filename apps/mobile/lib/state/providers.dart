import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/errors.dart';
import '../core/models.dart';
import '../core/protocol.dart';
import '../device_keys/device_keys.dart';
import '../storage/host_store.dart';
import '../storage/secure_store.dart';
import '../transport/events_client.dart';
import '../transport/iroh_pipe.dart';
import 'host_session.dart';
import 'pipe_manager.dart';
import 'timeline.dart';

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
    }
    await _save([for (final h in current) if (h.hostId != hostId) h]);
  }
}

PairedHost? _host(Ref ref, String hostId) => ref.read(hostsProvider).valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;

final linkStateProvider = StateProvider.family<LinkState, String>((_, __) => LinkState.connecting);

/// The live connection to one host. Rebuilt only when its identity changes: a
/// refreshed ticket goes to the open pipe without tearing the session down.
final hostSessionProvider = Provider.family<HostSession?, String>((ref, hostId) {
  final identity = ref.watch(hostsProvider.select((value) {
    final host = value.valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;
    return host == null ? null : (host.deviceId, host.keyAlias, host.revoked);
  }));
  final host = _host(ref, hostId);
  if (identity == null || host == null || host.revoked) return null;
  final pipes = ref.read(pipeManagerProvider);
  // The latest stored ticket, read whenever the pipe (re)opens.
  String ticket() => _host(ref, hostId)?.ticket ?? host.ticket;
  late final HostSession session;
  session = HostSession(
    host: host,
    link: pipes.link(hostId, ticket),
    keys: ref.read(deviceKeysProvider),
    onLink: (link) {
      ref.read(linkStateProvider(hostId).notifier).state = link;
      if (link == LinkState.revoked) unawaited(ref.read(hostsProvider.notifier).edit(hostId, (h) => h.copyWith(revoked: true)));
      if (link == LinkState.online) unawaited(_refreshTicket(ref, hostId, session));
    },
  );
  Future.microtask(session.events.start);
  ref.onDispose(session.dispose);
  return session;
});

/// Keep the stored ticket current, so the next dial (after a restart or a
/// network change) uses the host's latest relay and addresses.
Future<void> _refreshTicket(Ref ref, String hostId, HostSession session) async {
  try {
    final address = await session.api.hostAddress();
    if (_host(ref, hostId)?.ticket == address.ticket) return;
    await ref.read(hostsProvider.notifier).edit(hostId, (h) => h.copyWith(ticket: address.ticket));
    await ref.read(pipeManagerProvider).refresh(hostId, address.ticket);
  } catch (_) {
    // Best effort: the stored ticket still works while the host stays where it was.
  }
}

HostSession _requireSession(Ref ref, String hostId) {
  final session = ref.watch(hostSessionProvider(hostId));
  if (session == null) throw const ApiException(status: 403, code: 'DEVICE_REVOKED', message: 'not paired');
  return session;
}

final sessionsProvider = FutureProvider.autoDispose.family<List<SessionSummary>, String>((ref, hostId) async {
  final session = _requireSession(ref, hostId);
  // Refresh the list when control changes or approvals come and go.
  final dispose = session.listenHost((frame) {
    if (const {'approvals.changed', 'lease.changed', 'session.unpublished'}.contains(frame['kind'])) ref.invalidateSelf();
  });
  ref.onDispose(dispose);
  return session.api.sessions();
});

final approvalsProvider = AsyncNotifierProvider.autoDispose.family<ApprovalsController, List<Approval>, String>(ApprovalsController.new);

class ApprovalsController extends AutoDisposeFamilyAsyncNotifier<List<Approval>, String> {
  @override
  Future<List<Approval>> build(String hostId) async {
    final session = _requireSession(ref, hostId);
    final dispose = session.listenHost((frame) {
      if (frame['kind'] != 'approvals.changed') return;
      final approval = Approval.fromJson((frame['payload'] as Map<String, dynamic>)['approval'] as Map<String, dynamic>);
      final others = [for (final a in state.valueOrNull ?? const <Approval>[]) if (a.approvalId != approval.approvalId) a];
      state = AsyncData(approval.state == ApprovalState.pending ? [...others, approval] : others);
    });
    ref.onDispose(dispose);
    return session.api.approvals();
  }

  /// Allow once / Deny with the revision the user saw; a stale answer refreshes the list.
  Future<String?> respond(Approval approval, {required bool allow}) async {
    final session = _requireSession(ref, arg);
    try {
      await session.api.respond(approval.approvalId, allow: allow, expectedRevision: approval.revision);
      state = AsyncData([for (final a in state.valueOrNull ?? const <Approval>[]) if (a.approvalId != approval.approvalId) a]);
      return null;
    } on ApiException catch (error) {
      if (error.code == 'APPROVAL_STALE' || error.code == 'NOT_FOUND') ref.invalidateSelf();
      return describeError(error);
    }
  }
}

typedef SessionRef = ({String hostId, String sessionId});

final timelineProvider = NotifierProvider.autoDispose.family<TimelineController, TimelineState, SessionRef>(TimelineController.new);

class TimelineController extends AutoDisposeFamilyNotifier<TimelineState, SessionRef> {
  HostSession? _session;

  @override
  TimelineState build(SessionRef arg) {
    final session = ref.watch(hostSessionProvider(arg.hostId));
    _session = session;
    if (session == null) return const TimelineState(loading: false, error: 'Access removed by the host.');
    final disposeListener = session.listenSession(arg.sessionId, _onFrame);
    ref.onDispose(() {
      disposeListener();
      session.events.unsubscribe(arg.sessionId);
    });
    unawaited(ref.read(hostsProvider.notifier).edit(arg.hostId, (h) => h.copyWith(lastSessionId: arg.sessionId)));
    Future.microtask(_load);
    return const TimelineState();
  }

  Future<void> _load() async {
    final session = _session;
    if (session == null) return;
    try {
      final snapshot = await session.api.snapshot(arg.sessionId);
      state = fromSnapshot(state, snapshot);
      session.events.subscribe(arg.sessionId, after: snapshot.cursor);
      await _reconcileUnknown();
    } on ApiException catch (error) {
      state = state.copyWith(loading: false, error: describeError(error), unpublished: error.code == 'SESSION_NOT_PUBLISHED');
    }
  }

  void _onFrame(Map<String, dynamic> frame) {
    if (frame['type'] == 'session.event') {
      state = applySessionEvent(state, frame);
      final cursor = frame['cursor'] as String?;
      if (cursor != null) _session?.events.advance(arg.sessionId, cursor);
      return;
    }
    final payload = frame['payload'] as Map<String, dynamic>? ?? const {};
    switch (frame['kind']) {
      case 'resync.required':
        unawaited(_load());
      case 'session.unpublished':
        state = state.copyWith(unpublished: true, error: 'This session is no longer shared. Run /rc on the host.');
      case 'lease.changed' || 'lease.lost':
        final controller = Controller.fromJson(payload['controller']);
        state = state.copyWith(controller: controller, clearController: controller == null);
      case 'approvals.changed':
        state = upsertApproval(state, Approval.fromJson(payload['approval'] as Map<String, dynamic>));
      case 'subscribed':
        // A reconnect re-subscribed us; anything still unknown can be checked now.
        unawaited(_reconcileUnknown());
    }
  }

  bool get iControl {
    final controller = state.controller;
    return controller == null || controller.deviceId == _session?.host.deviceId;
  }

  /// Send a prompt. Never retried automatically; the user decides after a failure.
  Future<void> send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    if (utf8.encode(trimmed).length > maxPromptBytes) {
      state = state.copyWith(error: 'That message is too long (16 KB maximum).');
      return;
    }
    final prompt = OutgoingPrompt(clientRequestId: 'req_${randomToken(12)}', text: trimmed, status: OutgoingStatus.sending);
    state = state.copyWith(outgoing: [...state.outgoing, prompt], clearError: true);
    await _submit(prompt);
  }

  /// Re-send with the *same* request id: the host returns the original turn instead of running it twice.
  Future<void> retry(OutgoingPrompt prompt) async {
    _replace(prompt.copyWith(status: OutgoingStatus.sending));
    await _submit(prompt);
  }

  void discard(OutgoingPrompt prompt) => state = state.copyWith(outgoing: [for (final p in state.outgoing) if (p.clientRequestId != prompt.clientRequestId) p]);

  Future<void> _submit(OutgoingPrompt prompt) async {
    final session = _session;
    if (session == null) return;
    try {
      final receipt = await session.api.sendPrompt(arg.sessionId, prompt.clientRequestId, prompt.text);
      _replace(prompt.copyWith(status: receipt.state == 'failed' ? OutgoingStatus.failed : OutgoingStatus.accepted, turnId: receipt.turnId));
    } on ApiException catch (error) {
      final status = error.code == 'LEASE_HELD'
          ? OutgoingStatus.blocked
          : error.outcomeUnknown
              ? OutgoingStatus.unknown
              : OutgoingStatus.failed;
      _replace(prompt.copyWith(status: status, error: describeError(error)));
    }
  }

  /// Read-only reconciliation of prompts whose fate is unknown (spec §6: reconcile by request id first).
  Future<void> _reconcileUnknown() async {
    final session = _session;
    if (session == null) return;
    for (final prompt in state.outgoing.where((p) => p.status == OutgoingStatus.unknown)) {
      try {
        final receipt = await session.api.receipt(arg.sessionId, prompt.clientRequestId);
        _replace(prompt.copyWith(status: receipt.state == 'failed' ? OutgoingStatus.failed : receipt.state == 'submitting' ? OutgoingStatus.unknown : OutgoingStatus.accepted, turnId: receipt.turnId));
      } on ApiException catch (error) {
        if (error.code == 'NOT_FOUND') _replace(prompt.copyWith(status: OutgoingStatus.failed, error: 'Not delivered.'));
      }
    }
  }

  void _replace(OutgoingPrompt prompt) {
    state = state.copyWith(outgoing: [for (final p in state.outgoing) p.clientRequestId == prompt.clientRequestId ? prompt : p]);
  }

  Future<void> cancelTurn() async {
    final active = state.activeTurn;
    final session = _session;
    if (active == null || session == null) return;
    try {
      await session.api.cancel(arg.sessionId, active.turnId);
    } on ApiException catch (error) {
      state = state.copyWith(error: describeError(error));
    }
  }

  Future<void> takeControl() async {
    final session = _session;
    if (session == null) return;
    try {
      // Blocked prompts never reached the host, so their request ids are still unused and "Send" may reuse them.
      final holder = await session.api.acquireLease(arg.sessionId, takeover: true);
      state = state.copyWith(controller: holder, clearError: true);
    } on ApiException catch (error) {
      state = state.copyWith(error: describeError(error));
    }
  }

  void clearError() => state = state.copyWith(clearError: true);
}
