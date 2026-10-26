import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/protocol.dart';
import 'features/hosts/hosts_screen.dart';
import 'features/pair/pairing_screen.dart';
import 'features/pair/scan_screen.dart';
import 'features/settings/settings_screen.dart';
import 'features/web/web_screen.dart';
import 'state/providers.dart';
import 'ui/theme.dart';

final _router = GoRouter(
  // A pairing code opened from outside the app (dshremote://pair?v=2&…) arrives
  // as a deep link; route it to the pairing screen with the whole code.
  redirect: (_, state) {
    final uri = state.uri;
    final external = uri.scheme == 'dshremote' || (uri.path == '/' && uri.queryParameters['v'] == '2' && uri.queryParameters.containsKey('t'));
    if (!external) return null;
    final code = Uri(scheme: 'dshremote', host: 'pair', queryParameters: uri.queryParameters).toString();
    return Uri(path: '/pair', queryParameters: {'u': code}).toString();
  },
  routes: [
    GoRoute(path: '/', builder: (_, __) => const HostsScreen()),
    GoRoute(path: '/scan', builder: (_, __) => const ScanScreen()),
    GoRoute(
      path: '/pair',
      builder: (_, state) {
        final payload = PairingPayload.parse(state.uri.queryParameters['u'] ?? '');
        return payload == null ? const _InvalidCode() : PairingScreen(payload: payload);
      },
    ),
    GoRoute(path: '/host/:hostId', builder: (_, state) => WebScreen(hostId: state.pathParameters['hostId']!)),
    GoRoute(path: '/host/:hostId/settings', builder: (_, state) => SettingsScreen(hostId: state.pathParameters['hostId']!)),
  ],
);

class DshRemoteApp extends StatelessWidget {
  const DshRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    return _Lifecycle(
      child: MaterialApp.router(
        title: 'DSH Remote',
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        debugShowCheckedModeBanner: false,
        routerConfig: _router,
        builder: (context, child) => AnnotatedRegion<SystemUiOverlayStyle>(value: overlayStyle(Theme.of(context).brightness), child: child!),
      ),
    );
  }
}

/// Sockets do not survive backgrounding on mobile: close the iroh endpoint on
/// pause. It restarts, and the pipes reopen, on the first request after resume
/// (the web screen reconnects itself).
class _Lifecycle extends ConsumerStatefulWidget {
  const _Lifecycle({required this.child});
  final Widget child;

  @override
  ConsumerState<_Lifecycle> createState() => _LifecycleState();
}

class _LifecycleState extends ConsumerState<_Lifecycle> {
  late final AppLifecycleListener _listener;

  @override
  void initState() {
    super.initState();
    _listener = AppLifecycleListener(
      onPause: () => unawaited(ref.read(pipeManagerProvider).pause()),
    );
    // Android reports network changes from the platform side (MainActivity); iOS iroh sees them itself.
    const MethodChannel('dev.dshremote/network').setMethodCallHandler((call) async {
      if (call.method == 'changed') await ref.read(pipeManagerProvider).networkChanged();
    });
  }

  @override
  void dispose() {
    _listener.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class _InvalidCode extends StatelessWidget {
  const _InvalidCode();

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Connect host')),
        body: Center(child: Padding(padding: const EdgeInsets.all(32), child: Text('That is not a DSH Remote pairing code.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall))),
      );
}
