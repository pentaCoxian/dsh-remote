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

final _router = GoRouter(
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
    ThemeData theme(Brightness brightness) => ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3D5AFE), brightness: brightness),
          useMaterial3: true,
          pageTransitionsTheme: const PageTransitionsTheme(builders: {
            TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
          }),
        );
    return _Lifecycle(
      child: MaterialApp.router(
        title: 'DSH Remote',
        theme: theme(Brightness.light),
        darkTheme: theme(Brightness.dark),
        routerConfig: _router,
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
        body: const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('That is not a DSH Remote pairing code.', textAlign: TextAlign.center))),
      );
}
