package dev.dshremote.dsh_remote

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Opens a host's sealed notification (protocol/vectors/push.json): base64url of
 * nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16), with AAD binding it to the
 * host and the gateway handle. Plain JVM, so the vectors test it off-device.
 */
object PushCrypto {
    private const val NONCE_BYTES = 12
    private const val TAG_BITS = 128

    fun aad(hostId: String, handle: String): ByteArray = "dsh-remote/push/1\n$hostId\n$handle".toByteArray(Charsets.UTF_8)

    /** The notification's JSON text (padding removed) from the decoded envelope, or null when it is not authentic. */
    fun open(key: SecretKey, hostId: String, handle: String, sealed: ByteArray): String? = try {
        if (sealed.size < NONCE_BYTES + TAG_BITS / 8) {
            null
        } else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 0, NONCE_BYTES))
            cipher.updateAAD(aad(hostId, handle))
            String(cipher.doFinal(sealed, NONCE_BYTES, sealed.size - NONCE_BYTES), Charsets.UTF_8).trimEnd()
        }
    } catch (_: Exception) {
        null
    }
}
