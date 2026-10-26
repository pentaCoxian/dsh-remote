package dev.dshremote.dsh_remote

import android.content.Context
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * Per-host notification keys. Each is 32 random bytes, handed to Dart once (it
 * goes to the host over the signed tunnel) and imported into the Android
 * Keystore as a non-exportable decrypt-only key, so [PushService] can open
 * notifications while the app is not running. Which host a gateway handle
 * belongs to (part of the AAD) is kept in private preferences.
 */
object PushKeys {
    private const val PREFS = "dshr_push_handles"
    private const val BASE64URL = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    private fun alias(handle: String) = "dshr.push.$handle"

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** A new key for notifications from [hostId] that arrive with [handle]; base64url for the host. */
    fun create(context: Context, handle: String, hostId: String): String {
        val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
        try {
            val protection = KeyProtection.Builder(KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
            keyStore().setEntry(alias(handle), KeyStore.SecretKeyEntry(SecretKeySpec(raw, "AES")), protection)
            prefs(context).edit().putString(handle, hostId).commit()
            return Base64.encodeToString(raw, BASE64URL)
        } finally {
            raw.fill(0)
        }
    }

    fun delete(context: Context, handle: String) {
        keyStore().deleteEntry(alias(handle))
        prefs(context).edit().remove(handle).commit()
    }

    /** Whether [handle] belongs to a host this phone still knows. */
    fun known(context: Context, handle: String): Boolean = prefs(context).contains(handle)

    /** The notification that arrived with [handle], or null when it is not authentic. */
    fun open(context: Context, handle: String, envelope: String): JSONObject? {
        val hostId = prefs(context).getString(handle, null) ?: return null
        val key = keyStore().getKey(alias(handle), null) as? SecretKey ?: return null
        val sealed = try {
            Base64.decode(envelope, BASE64URL)
        } catch (_: IllegalArgumentException) {
            return null
        }
        val text = PushCrypto.open(key, hostId, handle, sealed) ?: return null
        return try {
            JSONObject(text).takeIf { it.optInt("v") == 1 && it.optString("hostId") == hostId }
        } catch (_: Exception) {
            null
        }
    }
}
