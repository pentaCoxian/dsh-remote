import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/errors.dart';
import '../../core/models.dart';
import '../../push/push_registration.dart';
import '../../state/host_session.dart';
import '../../state/providers.dart';
import '../../ui/theme.dart';
import '../../ui/widgets.dart';

/// This host's notifications on this phone: on/off, which events, and a test.
class NotificationsGroup extends ConsumerStatefulWidget {
  const NotificationsGroup({super.key, required this.hostId});
  final String hostId;

  @override
  ConsumerState<NotificationsGroup> createState() => _NotificationsGroupState();
}

class _NotificationsGroupState extends ConsumerState<NotificationsGroup> {
  PushState? _state;
  String? _error;
  bool _busy = true;
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    unawaited(_run((registrar, session) => registrar.sync(session)));
  }

  Future<void> _run(Future<PushState> Function(PushRegistrar registrar, HostSession session) action) async {
    final session = ref.read(hostSessionProvider(widget.hostId));
    if (session == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final state = await action(ref.read(pushRegistrarProvider), session);
      if (mounted) setState(() => _state = state);
    } catch (error) {
      if (mounted) setState(() => _error = error is ApiException ? describeError(error) : 'Notifications could not be set up: $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toggle(bool on) => unawaited(_run((registrar, session) => on ? registrar.sync(session, enable: true) : registrar.disable(session)));

  void _events(PushEvents events) => unawaited(_run((registrar, session) => registrar.sync(session, events: events)));

  Future<void> _test() async {
    final session = ref.read(hostSessionProvider(widget.hostId));
    if (session == null) return;
    setState(() => _testing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await session.api.testPush();
      messenger.showSnackBar(const SnackBar(content: Text('Sent. It arrives when DSH Remote is in the background.')));
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error is ApiException ? describeError(error) : '$error')));
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Tokens.of(context);
    final state = _state;
    final on = state?.availability == PushAvailability.on;
    final canToggle = !_busy && state != null && const {PushAvailability.on, PushAvailability.off, PushAvailability.notAllowed}.contains(state.availability);
    final detail = _error ??
        switch (state?.availability) {
          null => 'Checking…',
          PushAvailability.on => 'End-to-end encrypted. Sent while DSH Web is not open on this phone.',
          PushAvailability.off => 'Off for this host on this phone.',
          PushAvailability.hostOff => 'Turned off on this host (pushGateway in its DSH Remote config).',
          PushAvailability.notAllowed => 'Not allowed for DSH Remote. Turn them on in system settings.',
          PushAvailability.unavailable => 'This build of DSH Remote cannot receive notifications.',
        };
    Widget toggle(bool value, ValueChanged<bool>? onChanged) => Switch(value: value, onChanged: _busy ? null : onChanged);
    final events = state?.events ?? const PushEvents();
    return Group(children: [
      InfoRow(
        icon: Icon(on ? LucideIcons.bellRing : LucideIcons.bellOff),
        label: 'Notifications',
        value: detail,
        trailing: _busy && state == null
            ? const Padding(padding: EdgeInsets.all(12), child: SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)))
            : toggle(on, canToggle ? _toggle : null),
      ),
      if (on) ...[
        InfoRow(icon: const Icon(LucideIcons.shieldAlert), label: 'Approval needed', trailing: toggle(events.approval, (v) => _events(events.copyWith(approval: v)))),
        InfoRow(icon: const Icon(LucideIcons.circleCheck), label: 'Turn finished', trailing: toggle(events.turnFinished, (v) => _events(events.copyWith(turnFinished: v)))),
        InfoRow(icon: const Icon(LucideIcons.circleX), label: 'Turn failed', trailing: toggle(events.turnFailed, (v) => _events(events.copyWith(turnFailed: v)))),
        InfoRow(
          icon: const Icon(LucideIcons.send),
          label: 'Send a test notification',
          onTap: _testing ? null : _test,
          trailing: _testing
              ? const Padding(padding: EdgeInsets.all(12), child: SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)))
              : Padding(padding: const EdgeInsets.all(12), child: Icon(LucideIcons.chevronRight, size: 18, color: t.textTertiary)),
        ),
      ],
    ]);
  }
}
