import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/errors.dart';
import '../core/protocol.dart';
import '../device_keys/device_keys.dart';
import '../storage/host_store.dart';
import '../transport/api_client.dart';
import '../transport/iroh_pipe.dart';
import '../transport/signer.dart';
import 'providers.dart';

enum PairingStep { ready, connecting, redeeming, waiting, done, denied, expired, failed }

class PairingState {
  const PairingState({required this.step, required this.payload, this.phoneFingerprint, this.hostId, this.message});
  final PairingStep step;
  final PairingPayload payload;

  /// Shown so the owner can compare it with the host's prompt.
  final String? phoneFingerprint;

  /// The host's EndpointId, from the ticket (and proven by QUIC once connected).
  final String? hostId;
  final String? message;

  PairingState copyWith({PairingStep? step, String? phoneFingerprint, String? hostId, String? message}) =>
      PairingState(step: step ?? this.step, payload: payload, phoneFingerprint: phoneFingerprint ?? this.phoneFingerprint, hostId: hostId ?? this.hostId, message: message);
}

final pairingProvider = NotifierProvider.autoDispose.family<PairingController, PairingState, PairingPayload>(PairingController.new);

/// First-time pairing (spec §5): dial the QR's ticket (QUIC authenticates the
/// host's key from the first packet), create a keystore key, redeem the
/// challenge with proof of possession, wait for the owner's approval on the
/// host, then check that the grant names this host and this phone's key.
class PairingController extends AutoDisposeFamilyNotifier<PairingState, PairingPayload> {
  bool _cancelled = false;
  DeviceKey? _key;

  @override
  PairingState build(PairingPayload arg) {
    ref.onDispose(() => _cancelled = true);
    return PairingState(step: PairingStep.ready, payload: arg);
  }

  DeviceKeys get _keys => ref.read(deviceKeysProvider);

  Future<void> start(String deviceLabel) async {
    final payload = arg;
    final pipes = ref.read(pipeManagerProvider);
    final String hostId;
    try {
      hostId = await pipes.hostIdOf(payload.ticket);
    } on PipeException {
      state = state.copyWith(step: PairingStep.failed, message: 'That is not a DSH Remote pairing code.');
      return;
    }
    final alreadyPaired = (ref.read(hostsProvider).valueOrNull ?? const []).any((h) => h.hostId == hostId && !h.revoked);
    final link = pipes.link(hostId, () => payload.ticket);
    try {
      state = state.copyWith(step: PairingStep.connecting, hostId: hostId);
      // A fresh ticket from the QR replaces whatever the pipe had for this host.
      await pipes.refresh(hostId, payload.ticket);
      await pipes.socketFor(hostId, () => payload.ticket);

      state = state.copyWith(step: PairingStep.redeeming);
      final alias = 'dshr_${hostId.substring(0, 16)}_${randomToken(6)}';
      final key = _key = await _keys.generate(alias);
      final phoneFingerprint = spkiFingerprint(key.publicKey);
      final signer = RequestSigner(keys: _keys, keyAlias: alias, deviceId: pendingDeviceId);
      final api = HostApi(link: link, signer: signer);
      final redeemed = await api.redeem(
        challengeId: payload.challengeId,
        publicKey: key.publicKey,
        label: deviceLabel,
        platform: Platform.isIOS ? 'ios' : Platform.isAndroid ? 'android' : 'other',
        hardwareBacked: key.hardwareBacked,
      );

      state = state.copyWith(step: PairingStep.waiting, phoneFingerprint: phoneFingerprint);
      final pairingRequestId = redeemed['pairingRequestId'] as String;
      final deadline = DateTime.fromMillisecondsSinceEpoch(redeemed['expiresAt'] as int).add(const Duration(seconds: 5));
      Map<String, dynamic> status;
      while (true) {
        if (_cancelled) return _abandon(hostId, alreadyPaired);
        status = await api.pairStatus(pairingRequestId);
        if (status['state'] != 'pending') break;
        if (DateTime.now().isAfter(deadline)) {
          state = state.copyWith(step: PairingStep.expired, message: 'Nobody approved the request in time.');
          return _abandon(hostId, alreadyPaired);
        }
        await Future<void>.delayed(const Duration(seconds: 2));
      }
      switch (status['state']) {
        case 'denied':
          state = state.copyWith(step: PairingStep.denied, message: 'The host owner declined this phone.');
          return _abandon(hostId, alreadyPaired);
        case 'expired':
          state = state.copyWith(step: PairingStep.expired, message: 'The request expired. Scan a new code.');
          return _abandon(hostId, alreadyPaired);
      }

      // The grant came over the connection QUIC authenticated as `hostId`; it must name that host and this key.
      final grant = status['grant'] as Map<String, dynamic>;
      if (grant['hostId'] != hostId || grant['deviceKeyFingerprint'] != phoneFingerprint) {
        throw const ApiException(status: 0, code: 'GRANT_INVALID', message: 'The host’s grant does not match this pairing.');
      }
      signer.deviceId = grant['deviceId'] as String;
      final meta = await api.meta();
      await ref.read(hostsProvider.notifier).add(PairedHost(
            hostId: hostId,
            ticket: payload.ticket,
            name: meta.hostName,
            deviceId: signer.deviceId,
            keyAlias: alias,
            devicePublicKey: key.publicKey,
            hardwareBacked: key.hardwareBacked,
            pairedAt: DateTime.now(),
            lastSessionId: payload.sessionId,
          ));
      _key = null;
      state = state.copyWith(step: PairingStep.done, hostId: hostId);
    } on ApiException catch (error) {
      state = state.copyWith(step: PairingStep.failed, message: error.code == 'CHALLENGE_INVALID' ? 'This code was already used or has expired. Run `dsh-remote pair` again.' : describeError(error));
      await _abandon(hostId, alreadyPaired);
    } catch (error) {
      state = state.copyWith(step: PairingStep.failed, message: error is PipeException ? 'Cannot reach the host: ${error.message}' : 'Pairing failed: $error');
      await _abandon(hostId, alreadyPaired);
    } finally {
      link.close();
    }
  }

  void cancel() => _cancelled = true;

  /// A half-finished pairing must leave no key, and no pipe to a host this phone is not paired with.
  Future<void> _abandon(String hostId, bool keepPipe) async {
    final key = _key;
    _key = null;
    if (key != null) await _keys.delete(key.alias).catchError((_) {});
    if (!keepPipe) await ref.read(pipeManagerProvider).close(hostId);
  }
}
