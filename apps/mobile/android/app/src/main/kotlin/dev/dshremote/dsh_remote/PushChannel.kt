package dev.dshremote.dsh_remote

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

/** `dev.dshremote/push`: FCM token, notification permission, and per-host keys (see lib/push/push_native.dart). */
class PushChannel(private val activity: Activity) : MethodChannel.MethodCallHandler {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var pendingPermission: MethodChannel.Result? = null

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            // Firebase starts only when the build has a google-services.json.
            "platform" -> result.success(if (FirebaseApp.getApps(activity).isNotEmpty()) "fcm" else null)
            "permitted" -> result.success(NotificationManagerCompat.from(activity).areNotificationsEnabled())
            "requestPermission" -> requestPermission(result)
            "token" -> token(result)
            "newKey" -> background(result) { PushKeys.create(activity, call.argument<String>("handle")!!, call.argument<String>("hostId")!!) }
            "deleteKey" -> background(result) { PushKeys.delete(activity, call.argument<String>("handle")!!).let { null } }
            else -> result.notImplemented()
        }
    }

    private fun token(result: MethodChannel.Result) {
        val messaging = try {
            FirebaseMessaging.getInstance()
        } catch (e: IllegalStateException) {
            return result.error("push", "Firebase is not configured in this build", null)
        }
        messaging.token.addOnCompleteListener { task ->
            if (task.isSuccessful && task.result != null) result.success(mapOf("token" to task.result))
            else result.error("push", task.exception?.message ?: "no FCM token", null)
        }
    }

    private fun requestPermission(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            result.success(NotificationManagerCompat.from(activity).areNotificationsEnabled())
            return
        }
        pendingPermission?.success(false)
        pendingPermission = result
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_CODE)
    }

    /** From [MainActivity.onRequestPermissionsResult]; true when it was ours. */
    fun onPermissionResult(requestCode: Int, grantResults: IntArray): Boolean {
        if (requestCode != REQUEST_CODE) return false
        pendingPermission?.success(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
        pendingPermission = null
        return true
    }

    private fun background(result: MethodChannel.Result, work: () -> Any?) {
        executor.execute {
            try {
                val value = work()
                main.post { result.success(value) }
            } catch (e: Exception) {
                main.post { result.error("push", e.message ?: e.javaClass.simpleName, null) }
            }
        }
    }

    companion object {
        private const val REQUEST_CODE = 7301
    }
}
