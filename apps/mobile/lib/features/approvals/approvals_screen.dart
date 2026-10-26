import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors.dart';
import '../../state/providers.dart';
import 'approval_card.dart';

class ApprovalsScreen extends ConsumerWidget {
  const ApprovalsScreen({super.key, required this.hostId});
  final String hostId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final approvals = ref.watch(approvalsProvider(hostId));
    return Scaffold(
      appBar: AppBar(title: const Text('Approvals')),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(approvalsProvider(hostId).future),
        child: approvals.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text(describeError(error)))]),
          data: (items) => items.isEmpty
              ? ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('Nothing is waiting for approval.'))])
              : ListView(children: [for (final approval in items) ApprovalCard(hostId: hostId, approval: approval)]),
        ),
      ),
    );
  }
}
