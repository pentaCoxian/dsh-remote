package dev.dshremote.dsh_remote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/** Posts decrypted notifications: approvals on a high-importance channel, turns on a quiet one. */
object PushNotifications {
    private const val APPROVALS = "approvals"
    private const val ACTIVITY = "activity"
    private val HOST_ID = Regex("^[0-9a-f]{64}$")

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply { description = "A tool call is waiting for your OK" })
        manager.createNotificationChannel(NotificationChannel(ACTIVITY, "Turns", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Finished and failed turns you asked to hear about" })
    }

    /** Show [message] (null: it could not be read, so say only that something happened). Tapping opens that host's DSH Web. */
    fun show(context: Context, message: JSONObject?) {
        val notifications = NotificationManagerCompat.from(context)
        if (!notifications.areNotificationsEnabled()) return
        ensureChannels(context)
        val kind = message?.optString("kind").orEmpty()
        val hostId = message?.optString("hostId")?.takeIf { HOST_ID.matches(it) }
        val sessionId = message?.optString("sessionId").orEmpty()
        val body = message?.optString("body")?.takeIf { it.isNotEmpty() } ?: "New activity"
        val approval = kind == "approval" || kind == "test"
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(if (hostId == null) "dshremote://host/" else "dshremote://host/$hostId"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val tap = PendingIntent.getActivity(context, (hostId ?: "").hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, if (approval) APPROVALS else ACTIVITY)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(message?.optString("title")?.takeIf { it.isNotEmpty() } ?: "DSH Remote")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSubText(message?.optString("hostName")?.takeIf { it.isNotEmpty() })
            .setPriority(if (approval) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(if (approval) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setWhen(message?.optLong("ts")?.takeIf { it > 0 } ?: System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .apply { if (hostId != null) setGroup(hostId) }
            .build()
        // A session's newer turn notification replaces the older one; every approval stands alone.
        val tag = if (approval) "msg:${message?.optString("id")}" else "turn:$hostId:$sessionId"
        try {
            notifications.notify(tag, 0, notification)
        } catch (_: SecurityException) {
            // Permission withdrawn between the check and here.
        }
    }
}
