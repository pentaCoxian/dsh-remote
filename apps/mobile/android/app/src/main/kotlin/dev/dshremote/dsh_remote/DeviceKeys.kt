package dev.dshremote.dsh_remote

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.Executors

/**
 * Per-host P-256 signing keys in the Android Keystore. StrongBox is tried
 * first, then the TEE; private keys are non-exportable. Signatures are DER
 * ECDSA over SHA-256, exactly what the host verifies.
 */
class DeviceKeys : MethodChannel.MethodCallHandler {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        executor.execute {
            try {
                val value: Any? = when (call.method) {
                    "generate" -> generate(call.argument<String>("alias")!!)
                    "sign" -> sign(call.argument<String>("alias")!!, call.argument<ByteArray>("data")!!)
                    "verify" -> verify(call.argument<String>("publicKey")!!, call.argument<ByteArray>("data")!!, call.argument<ByteArray>("signature")!!)
                    "delete" -> keyStore().deleteEntry(call.argument<String>("alias")!!).let { null }
                    else -> {
                        main.post { result.notImplemented() }
                        return@execute
                    }
                }
                main.post { result.success(value) }
            } catch (error: Exception) {
                main.post { result.error("device-keys", error.javaClass.simpleName, null) }
            }
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun generate(alias: String): Map<String, Any> {
        val store = keyStore()
        if (store.containsAlias(alias)) store.deleteEntry(alias)
        val pair = try {
            createPair(alias, strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
        } catch (error: StrongBoxUnavailableException) {
            createPair(alias, strongBox = false)
        }
        val private = pair.private
        val info = KeyFactory.getInstance(private.algorithm, "AndroidKeyStore").getKeySpec(private, KeyInfo::class.java)
        val hardware = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX || info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT
        } else {
            @Suppress("DEPRECATION")
            info.isInsideSecureHardware
        }
        return mapOf("publicKey" to base64Url(pair.public.encoded), "hardwareBacked" to hardware)
    }

    private fun createPair(alias: String, strongBox: Boolean) = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
        initialize(spec.build())
        generateKeyPair()
    }

    private fun sign(alias: String, data: ByteArray): ByteArray {
        val key = keyStore().getKey(alias, null) as? PrivateKey ?: throw IllegalStateException("no key")
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(data)
            sign()
        }
    }

    private fun verify(spki: String, data: ByteArray, signature: ByteArray): Boolean {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(spki, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)))
        return Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(data)
            verify(signature)
        }
    }

    private fun base64Url(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
