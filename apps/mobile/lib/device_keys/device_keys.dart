import 'package:flutter/services.dart';

/// A per-host P-256 signing key that never leaves the platform keystore.
class DeviceKey {
  const DeviceKey({required this.alias, required this.publicKey, required this.hardwareBacked});
  final String alias;

  /// base64url SPKI DER.
  final String publicKey;

  /// Secure Enclave / StrongBox / TEE; false only for the simulator fallback.
  final bool hardwareBacked;
}

abstract interface class DeviceKeys {
  Future<DeviceKey> generate(String alias);

  /// DER-encoded ECDSA P-256 / SHA-256 signature over [data].
  Future<Uint8List> sign(String alias, Uint8List data);

  /// Verify a DER signature with a base64url SPKI key (used for the host-signed grant).
  Future<bool> verify(String spkiBase64Url, Uint8List data, Uint8List signature);

  Future<void> delete(String alias);
}

/// Android Keystore (StrongBox first, then TEE) and iOS Secure Enclave via `dev.dshremote/device_keys`.
class PlatformDeviceKeys implements DeviceKeys {
  const PlatformDeviceKeys();
  static const _channel = MethodChannel('dev.dshremote/device_keys');

  @override
  Future<DeviceKey> generate(String alias) async {
    final result = await _channel.invokeMapMethod<String, Object?>('generate', {'alias': alias});
    if (result == null) throw PlatformException(code: 'generate-failed');
    return DeviceKey(alias: alias, publicKey: result['publicKey']! as String, hardwareBacked: result['hardwareBacked'] == true);
  }

  @override
  Future<Uint8List> sign(String alias, Uint8List data) async {
    final signature = await _channel.invokeMethod<Uint8List>('sign', {'alias': alias, 'data': data});
    if (signature == null) throw PlatformException(code: 'sign-failed');
    return signature;
  }

  @override
  Future<bool> verify(String spkiBase64Url, Uint8List data, Uint8List signature) async =>
      await _channel.invokeMethod<bool>('verify', {'publicKey': spkiBase64Url, 'data': data, 'signature': signature}) ?? false;

  @override
  Future<void> delete(String alias) => _channel.invokeMethod<void>('delete', {'alias': alias});
}
