package dev.dshremote.dsh_remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.util.Base64
import javax.crypto.spec.SecretKeySpec

/** protocol/vectors/push.json, sealed by the host's code (packages/protocol/src/push.ts). */
class PushCryptoTest {
    private val vector = JSONObject(File("../../../../protocol/vectors/push.json").readText())
    private val key = SecretKeySpec(Base64.getUrlDecoder().decode(vector.getString("key")), "AES")
    private val hostId = vector.getString("hostId")
    private val handle = vector.getString("handle")

    private fun open(hostId: String, handle: String, envelope: String) = try {
        PushCrypto.open(key, hostId, handle, Base64.getUrlDecoder().decode(envelope))
    } catch (_: IllegalArgumentException) {
        null
    }

    @Test
    fun opensEveryValidEnvelope() {
        val valid = vector.getJSONArray("valid")
        for (i in 0 until valid.length()) {
            val case = valid.getJSONObject(i)
            val text = open(hostId, handle, case.getString("envelope"))!!
            val opened = case.getJSONObject("opened")
            val message = JSONObject(text)
            for (field in opened.keys()) assertEquals(field, opened.get(field).toString(), message.get(field).toString())
            assertEquals(opened.length(), message.length())
        }
    }

    @Test
    fun refusesEveryRejectedEnvelope() {
        val reject = vector.getJSONArray("reject")
        for (i in 0 until reject.length()) {
            val case = reject.getJSONObject(i)
            assertNull(case.getString("why"), open(case.getString("hostId"), case.getString("handle"), case.getString("envelope")))
        }
    }
}
