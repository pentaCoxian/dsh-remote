import '../core/models.dart';

/// Where a prompt the user sent from this phone stands (spec §4 reliability rules).
enum OutgoingStatus {
  /// Request in flight.
  sending,

  /// Host stored it (`queued`/`started`); it will appear in the timeline.
  accepted,

  /// No answer: it may or may not have arrived. Retry re-sends the same request id, which the host dedupes.
  unknown,

  /// Definitely not delivered; the user may send it again.
  failed,

  /// Another device holds the control lease.
  blocked,
}

class OutgoingPrompt {
  const OutgoingPrompt({required this.clientRequestId, required this.text, required this.status, this.turnId, this.error});
  final String clientRequestId;
  final String text;
  final OutgoingStatus status;
  final String? turnId;
  final String? error;

  OutgoingPrompt copyWith({OutgoingStatus? status, String? turnId, String? error}) =>
      OutgoingPrompt(clientRequestId: clientRequestId, text: text, status: status ?? this.status, turnId: turnId ?? this.turnId, error: error);
}

class TimelineState {
  const TimelineState({
    this.session,
    this.items = const [],
    this.cursor,
    this.lastSeq = -1,
    this.activeTurn,
    this.partial = '',
    this.outgoing = const [],
    this.pendingApprovals = const [],
    this.controller,
    this.loading = true,
    this.unpublished = false,
    this.error,
  });

  final SessionSummary? session;
  final List<TimelineItem> items;
  final String? cursor;
  final int lastSeq;
  final ActiveTurn? activeTurn;

  /// Text of the assistant attempt still streaming (ephemeral, never stored).
  final String partial;
  final List<OutgoingPrompt> outgoing;
  final List<Approval> pendingApprovals;
  final Controller? controller;
  final bool loading;
  final bool unpublished;
  final String? error;

  TimelineState copyWith({
    SessionSummary? session,
    List<TimelineItem>? items,
    String? cursor,
    int? lastSeq,
    ActiveTurn? activeTurn,
    bool clearActiveTurn = false,
    String? partial,
    List<OutgoingPrompt>? outgoing,
    List<Approval>? pendingApprovals,
    Controller? controller,
    bool clearController = false,
    bool? loading,
    bool? unpublished,
    String? error,
    bool clearError = false,
  }) =>
      TimelineState(
        session: session ?? this.session,
        items: items ?? this.items,
        cursor: cursor ?? this.cursor,
        lastSeq: lastSeq ?? this.lastSeq,
        activeTurn: clearActiveTurn ? null : (activeTurn ?? this.activeTurn),
        partial: partial ?? this.partial,
        outgoing: outgoing ?? this.outgoing,
        pendingApprovals: pendingApprovals ?? this.pendingApprovals,
        controller: clearController ? null : (controller ?? this.controller),
        loading: loading ?? this.loading,
        unpublished: unpublished ?? this.unpublished,
        error: clearError ? null : (error ?? this.error),
      );
}

/// Same id the host synthesizes for turns it did not start from a phone.
String synthesizedTurnId(int seq) => 'turn_seq${seq.toString().padLeft(6, '0')}';

TimelineState fromSnapshot(TimelineState previous, SessionSnapshot snapshot) {
  final lastSeq = snapshot.items.isEmpty ? -1 : snapshot.items.last.seq;
  return _retireDelivered(previous.copyWith(
    session: snapshot.session,
    items: snapshot.items,
    cursor: snapshot.cursor,
    lastSeq: lastSeq,
    activeTurn: snapshot.activeTurn,
    clearActiveTurn: snapshot.activeTurn == null,
    partial: snapshot.partialText ?? '',
    pendingApprovals: snapshot.pendingApprovals,
    controller: snapshot.session.controller,
    clearController: snapshot.session.controller == null,
    loading: false,
    unpublished: false,
    clearError: true,
  ));
}

/// Apply one `session.event` frame. Durable events at or below `lastSeq` were
/// already applied (replay after reconnect) and are dropped.
TimelineState applySessionEvent(TimelineState state, Map<String, dynamic> frame) {
  final kind = frame['kind'] as String? ?? '';
  final payload = frame['payload'] as Map<String, dynamic>? ?? const {};
  if (frame['ephemeral'] == true) {
    return switch (kind) {
      'assistant.started' => state.copyWith(partial: ''),
      'assistant.delta' => state.copyWith(partial: state.partial + (payload['text'] as String? ?? '')),
      'assistant.ended' => state.copyWith(partial: ''),
      _ => state,
    };
  }
  final item = TimelineItem.fromJson(frame);
  if (item.seq <= state.lastSeq) return state;
  var next = state.copyWith(items: [...state.items, item], lastSeq: item.seq, cursor: frame['cursor'] as String?);
  switch (kind) {
    case 'turn.started':
      next = next.copyWith(activeTurn: ActiveTurn(turn: payload['turn'] as int? ?? 0, turnId: synthesizedTurnId(item.seq)));
    case 'user.message':
      final requestId = payload['requestId'] as String?;
      final active = next.activeTurn;
      if (requestId != null && requestId.startsWith('turn_') && active != null) {
        next = next.copyWith(activeTurn: ActiveTurn(turn: active.turn, turnId: requestId));
      }
      next = _retireDelivered(next);
    case 'assistant.message':
      next = next.copyWith(partial: '');
    case 'turn.finished':
      next = next.copyWith(clearActiveTurn: true, partial: '');
    case 'approval.resolved':
      final id = payload['approvalId'];
      next = next.copyWith(pendingApprovals: [for (final a in next.pendingApprovals) if (a.approvalId != id) a]);
  }
  return next;
}

/// Prompts that now appear in the log as a user message are no longer "outgoing".
TimelineState _retireDelivered(TimelineState state) {
  final delivered = {for (final item in state.items) if (item.kind == 'user.message') item.payload['requestId']};
  final remaining = [for (final prompt in state.outgoing) if (prompt.turnId == null || !delivered.contains(prompt.turnId)) prompt];
  return remaining.length == state.outgoing.length ? state : state.copyWith(outgoing: remaining);
}

TimelineState upsertApproval(TimelineState state, Approval approval) {
  final others = [for (final a in state.pendingApprovals) if (a.approvalId != approval.approvalId) a];
  return state.copyWith(pendingApprovals: approval.state == ApprovalState.pending ? [...others, approval] : others);
}
