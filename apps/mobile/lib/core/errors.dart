/// A refusal from the host (spec §6 error envelope) or the transport.
class ApiException implements Exception {
  const ApiException({required this.status, required this.code, required this.message, this.retryable = false, this.serverTime});

  final int status;

  /// Host error code, or `NETWORK` / `TIMEOUT` / `UNREACHABLE` (the pipe could not dial) for transport failures.
  final String code;
  final String message;
  final bool retryable;
  final int? serverTime;

  /// The request may or may not have reached the host (never assume it failed).
  bool get outcomeUnknown => code == 'NETWORK' || code == 'TIMEOUT' || (code == 'UNAVAILABLE' && status == 503);

  bool get deviceGone => code == 'DEVICE_REVOKED' || code == 'DEVICE_UNPAIRED';

  @override
  String toString() => 'ApiException($status $code: $message)';
}

/// Short, user-facing copy for a failure (spec §4 connection states).
String describeError(Object error) {
  if (error is! ApiException) return 'Something went wrong.';
  return switch (error.code) {
    'NETWORK' || 'TIMEOUT' => 'Connection lost — trying again.',
    'UNREACHABLE' => 'Cannot reach the home lab. Is DSH running there?',
    'UNAUTHENTICATED' => 'The connection was not authenticated. Pair this phone again.',
    'ACCESS_DENIED' => 'This phone’s connection key does not match its pairing. Pair again.',
    'DEVICE_REVOKED' => 'Access removed by the host.',
    'DEVICE_UNPAIRED' => 'Pair this phone on the host again.',
    'LEASE_HELD' => 'Another device is controlling this session.',
    'SESSION_NOT_PUBLISHED' => 'This session is no longer shared. Run /rc on the host.',
    'APPROVAL_STALE' => 'This request was already answered.',
    'TURN_NOT_ACTIVE' => 'That turn already finished.',
    'IDEMPOTENCY_CONFLICT' => 'This message conflicts with one already sent.',
    'PROTOCOL_UNSUPPORTED' => 'Update DSH Remote to talk to this host.',
    'RATE_LIMITED' => 'Too many attempts; wait a minute.',
    'UNAVAILABLE' => 'The home lab cannot do that right now.',
    _ => error.message,
  };
}
