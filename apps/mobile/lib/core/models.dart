// Wire models (protocol/native-v1.schema.json). Host objects are open, so
// unknown fields are ignored and unknown kinds are kept but not rendered.

typedef Json = Map<String, dynamic>;

T _as<T>(Object? value, T fallback) => value is T ? value : fallback;

class Controller {
  const Controller({required this.deviceId, required this.label});
  final String deviceId;
  final String label;

  static Controller? fromJson(Object? json) => json is Json ? Controller(deviceId: _as(json['deviceId'], ''), label: _as(json['label'], '')) : null;
}

enum SessionStatus { idle, running, needsApproval, unavailable }

SessionStatus _status(Object? value) => switch (value) {
      'running' => SessionStatus.running,
      'needs_approval' => SessionStatus.needsApproval,
      'idle' => SessionStatus.idle,
      _ => SessionStatus.unavailable,
    };

class SessionSummary {
  const SessionSummary({required this.sessionId, required this.workspaceId, required this.title, required this.status, required this.updatedAt, this.controller});
  final String sessionId;
  final String workspaceId;
  final String title;
  final SessionStatus status;
  final DateTime updatedAt;
  final Controller? controller;

  factory SessionSummary.fromJson(Json json) => SessionSummary(
        sessionId: _as(json['sessionId'], ''),
        workspaceId: _as(json['workspaceId'], ''),
        title: _as(json['title'], 'Untitled session'),
        status: _status(json['status']),
        updatedAt: DateTime.fromMillisecondsSinceEpoch(_as<int>(json['updatedAt'], 0)),
        controller: Controller.fromJson(json['controller']),
      );
}

class Workspace {
  const Workspace({required this.workspaceId, required this.name});
  final String workspaceId;
  final String name;
  factory Workspace.fromJson(Json json) => Workspace(workspaceId: _as(json['workspaceId'], ''), name: _as(json['name'], 'Workspace'));
}

/// One durable timeline event (snapshot item or `session.event` frame).
class TimelineItem {
  const TimelineItem({required this.eventId, required this.seq, required this.kind, required this.at, required this.payload});
  final String eventId;
  final int seq;
  final String kind;
  final DateTime at;
  final Json payload;

  factory TimelineItem.fromJson(Json json) => TimelineItem(
        eventId: _as(json['eventId'], ''),
        seq: _as(json['seq'], -1),
        kind: _as(json['kind'], ''),
        at: DateTime.fromMillisecondsSinceEpoch(_as<int>(json['at'], 0)),
        payload: _as<Json>(json['payload'], const {}),
      );
}

enum ApprovalState { pending, allowedOnce, denied, cancelled, unavailable }

ApprovalState _approvalState(Object? value) => switch (value) {
      'pending' => ApprovalState.pending,
      'allowed_once' => ApprovalState.allowedOnce,
      'denied' => ApprovalState.denied,
      'cancelled' => ApprovalState.cancelled,
      _ => ApprovalState.unavailable,
    };

class Approval {
  const Approval({required this.approvalId, required this.sessionId, required this.revision, required this.toolName, required this.preview, required this.previewTruncated, required this.requestedAt, required this.state, this.reason, this.resolvedBy});
  final String approvalId;
  final String sessionId;
  final int revision;
  final String toolName;
  final String? reason;
  final String preview;
  final bool previewTruncated;
  final DateTime requestedAt;
  final ApprovalState state;
  final String? resolvedBy;

  factory Approval.fromJson(Json json) {
    final preview = _as<Json>(json['preview'], const {});
    return Approval(
      approvalId: _as(json['approvalId'], ''),
      sessionId: _as(json['sessionId'], ''),
      revision: _as(json['revision'], 1),
      toolName: _as(json['toolName'], 'tool'),
      reason: json['reason'] as String?,
      preview: _as(preview['text'], ''),
      previewTruncated: _as(preview['truncated'], false),
      requestedAt: DateTime.fromMillisecondsSinceEpoch(_as<int>(json['requestedAt'], 0)),
      state: _approvalState(json['state']),
      resolvedBy: json['resolvedBy'] as String?,
    );
  }
}

class ActiveTurn {
  const ActiveTurn({required this.turn, required this.turnId});
  final int turn;
  final String turnId;
  static ActiveTurn? fromJson(Object? json) => json is Json ? ActiveTurn(turn: _as(json['turn'], 0), turnId: _as(json['turnId'], '')) : null;
}

class SessionSnapshot {
  const SessionSnapshot({required this.session, required this.cursor, required this.hasMore, required this.items, required this.pendingApprovals, this.activeTurn, this.partialText});
  final SessionSummary session;
  final String cursor;
  final bool hasMore;
  final List<TimelineItem> items;
  final List<Approval> pendingApprovals;
  final ActiveTurn? activeTurn;
  final String? partialText;

  factory SessionSnapshot.fromJson(Json json) => SessionSnapshot(
        session: SessionSummary.fromJson(_as<Json>(json['session'], const {})),
        cursor: _as(json['cursor'], ''),
        hasMore: _as(json['hasMore'], false),
        items: [for (final item in _as<List>(json['items'], const [])) if (item is Json) TimelineItem.fromJson(item)],
        pendingApprovals: [for (final item in _as<List>(json['pendingApprovals'], const [])) if (item is Json) Approval.fromJson(item)],
        activeTurn: ActiveTurn.fromJson(json['activeTurn']),
        partialText: (json['partial'] is Json) ? (json['partial'] as Json)['text'] as String? : null,
      );
}

/// Host-side idempotency receipt for one prompt.
class PromptReceipt {
  const PromptReceipt({required this.clientRequestId, required this.turnId, required this.state});
  final String clientRequestId;
  final String turnId;

  /// `submitting | queued | started | finished | failed`.
  final String state;
  factory PromptReceipt.fromJson(Json json) => PromptReceipt(clientRequestId: _as(json['clientRequestId'], ''), turnId: _as(json['turnId'], ''), state: _as(json['state'], 'submitting'));
}

class HostMeta {
  const HostMeta({required this.hostId, required this.hostName, required this.deviceId, required this.serverTime});
  final String hostId;
  final String hostName;
  final String deviceId;
  final int serverTime;
  factory HostMeta.fromJson(Json json) => HostMeta(
        hostId: _as(json['hostId'], ''),
        hostName: _as(json['hostName'], 'Host'),
        deviceId: _as(_as<Json>(json['device'], const {})['deviceId'], ''),
        serverTime: _as(json['serverTime'], 0),
      );
}
