import 'package:flutter/services.dart';

/// The platform push service and this app's per-host notification keys
/// (`dev.dshremote/push`). Keys are made and kept natively, where the
/// notification code that decrypts them (FirebaseMessagingService, the iOS
/// Notification Service Extension) can read them while the app is not running.
class PushNative {
  const PushNative();

  static const _channel = MethodChannel('dev.dshremote/push');

  /// `fcm` or `apns`; null when this build cannot receive pushes (Android without a Firebase config).
  Future<String?> platform() => _channel.invokeMethod<String>('platform');

  /// Whether the OS lets this app show notifications.
  Future<bool> permitted() async => await _channel.invokeMethod<bool>('permitted') ?? false;

  /// Ask the OS once; later calls return the remembered answer.
  Future<bool> requestPermission() async => await _channel.invokeMethod<bool>('requestPermission') ?? false;

  /// The device token, and on iOS the APNs environment this build is signed for.
  Future<({String token, String? environment})> token() async {
    final reply = await _channel.invokeMapMethod<String, Object?>('token');
    return (token: reply!['token']! as String, environment: reply['environment'] as String?);
  }

  /// A fresh 32-byte key for the notifications of [hostId] that arrive with [handle]; base64url.
  Future<String> newKey({required String handle, required String hostId}) async => (await _channel.invokeMethod<String>('newKey', {'handle': handle, 'hostId': hostId}))!;

  Future<void> deleteKey(String handle) => _channel.invokeMethod<void>('deleteKey', {'handle': handle});
}
