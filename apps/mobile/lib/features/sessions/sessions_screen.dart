import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/errors.dart';
import '../../state/providers.dart';
import '../../widgets/status.dart';

class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key, required this.hostId});
  final String hostId;

  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final hostId = widget.hostId;
    final host = ref.watch(hostsProvider).valueOrNull?.where((h) => h.hostId == hostId).firstOrNull;
    final link = ref.watch(linkStateProvider(hostId));
    final sessions = ref.watch(sessionsProvider(hostId));
    final approvals = ref.watch(approvalsProvider(hostId)).valueOrNull ?? const [];
    return Scaffold(
      appBar: AppBar(
        title: Text(host?.name ?? 'Sessions'),
        actions: [
          IconButton(
            tooltip: 'Approvals',
            onPressed: () => context.push('/host/$hostId/approvals'),
            icon: Badge(isLabelVisible: approvals.isNotEmpty, label: Text('${approvals.length}'), child: const Icon(Icons.verified_user_outlined)),
          ),
          IconButton(tooltip: 'Host settings', icon: const Icon(Icons.settings_outlined), onPressed: () => context.push('/host/$hostId/settings')),
        ],
      ),
      body: Column(children: [
        LinkBanner(link),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search sessions'), onChanged: (value) => setState(() => _query = value.toLowerCase())),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () => ref.refresh(sessionsProvider(hostId).future),
            child: sessions.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (error, _) => ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text(describeError(error)))]),
              data: (items) {
                final shown = items.where((s) => _query.isEmpty || s.title.toLowerCase().contains(_query)).toList();
                if (shown.isEmpty) {
                  return ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('No shared sessions. Run /rc in a DSH session on the host to share it.'))]);
                }
                return ListView.separated(
                  itemCount: shown.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final session = shown[index];
                    return ListTile(
                      title: Text(session.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                      subtitle: Text([relativeTime(session.updatedAt), if (session.controller != null) 'Controlled by ${session.controller!.label}'].join(' · ')),
                      trailing: SessionStatusChip(session.status),
                      onTap: () => context.push('/host/$hostId/session/${session.sessionId}'),
                    );
                  },
                );
              },
            ),
          ),
        ),
      ]),
    );
  }
}
