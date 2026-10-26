import 'package:dsh_remote/core/models.dart';
import 'package:dsh_remote/state/timeline.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> event(int seq, String kind, [Map<String, dynamic> payload = const {}]) =>
    {'v': 1, 'type': 'session.event', 'sessionId': 's1', 'eventId': 'e$seq', 'seq': seq, 'cursor': 'c1.x$seq', 'kind': kind, 'at': 1, 'payload': payload};

Map<String, dynamic> delta(String text) => {'v': 1, 'type': 'session.event', 'sessionId': 's1', 'eventId': 'x', 'ephemeral': true, 'kind': 'assistant.delta', 'at': 1, 'payload': {'text': text}};

void main() {
  const empty = TimelineState(loading: false);

  test('appends durable events in order and ignores replays', () {
    var state = applySessionEvent(empty, event(3, 'turn.started', {'turn': 1}));
    state = applySessionEvent(state, event(4, 'user.message', {'text': 'hi'}));
    state = applySessionEvent(state, event(4, 'user.message', {'text': 'hi'}));
    state = applySessionEvent(state, event(2, 'assistant.message', {'text': 'old'}));
    expect(state.items.map((i) => i.seq), [3, 4]);
    expect(state.lastSeq, 4);
    expect(state.cursor, 'c1.x4');
  });

  test('tracks the active turn id the way the host does', () {
    var state = applySessionEvent(empty, event(7, 'turn.started', {'turn': 2}));
    expect(state.activeTurn!.turnId, 'turn_seq000007');
    state = applySessionEvent(state, event(8, 'user.message', {'text': 'from phone', 'requestId': 'turn_abc123def'}));
    expect(state.activeTurn!.turnId, 'turn_abc123def');
    state = applySessionEvent(state, event(9, 'turn.finished', {'turn': 2}));
    expect(state.activeTurn, isNull);
  });

  test('streams deltas without storing them and clears them on commit', () {
    var state = applySessionEvent(empty, delta('3 tests '));
    state = applySessionEvent(state, delta('passed'));
    expect(state.partial, '3 tests passed');
    expect(state.items, isEmpty);
    state = applySessionEvent(state, event(1, 'assistant.message', {'text': '3 tests passed'}));
    expect(state.partial, '');
  });

  test('retires an outgoing prompt once its user message arrives', () {
    var state = empty.copyWith(outgoing: [const OutgoingPrompt(clientRequestId: 'req_1', text: 'hi', status: OutgoingStatus.accepted, turnId: 'turn_xyz12345')]);
    state = applySessionEvent(state, event(1, 'user.message', {'text': 'other', 'requestId': 'turn_other999'}));
    expect(state.outgoing, hasLength(1));
    state = applySessionEvent(state, event(2, 'user.message', {'text': 'hi', 'requestId': 'turn_xyz12345'}));
    expect(state.outgoing, isEmpty);
  });

  test('drops a resolved approval from the pending list', () {
    final approval = Approval.fromJson({'approvalId': 'apr_1xxxxx', 'sessionId': 's1', 'revision': 1, 'toolName': 'bash', 'preview': {'text': 'ls', 'truncated': false}, 'requestedAt': 1, 'state': 'pending'});
    var state = upsertApproval(empty, approval);
    expect(state.pendingApprovals, hasLength(1));
    state = applySessionEvent(state, event(5, 'approval.resolved', {'approvalId': 'apr_1xxxxx', 'outcome': 'allowed_once'}));
    expect(state.pendingApprovals, isEmpty);
  });

  test('a snapshot replaces the window and keeps undelivered prompts', () {
    final snapshot = SessionSnapshot.fromJson({
      'session': {'sessionId': 's1', 'workspaceId': 'ws', 'title': 'T', 'status': 'running', 'updatedAt': 1, 'controller': null},
      'cursor': 'c1.snap',
      'hasMore': false,
      'items': [event(10, 'turn.started', {'turn': 3})],
      'activeTurn': {'turn': 3, 'turnId': 'turn_seq000010'},
      'pendingApprovals': [],
    });
    final state = fromSnapshot(empty.copyWith(outgoing: [const OutgoingPrompt(clientRequestId: 'r', text: 't', status: OutgoingStatus.unknown)]), snapshot);
    expect(state.cursor, 'c1.snap');
    expect(state.lastSeq, 10);
    expect(state.activeTurn!.turnId, 'turn_seq000010');
    expect(state.outgoing, hasLength(1));
  });
}
