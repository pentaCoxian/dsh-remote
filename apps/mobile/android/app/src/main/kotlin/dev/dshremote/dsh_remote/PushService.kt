package dev.dshremote.dsh_remote

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM delivers data-only messages here, even with the app closed: `h` is the
 * gateway handle (which host), `e` the sealed notification. Only this phone
 * holds the key; Google and the gateway see ciphertext.
 */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val handle = message.data["h"] ?: return
        val envelope = message.data["e"] ?: return
        // A handle of a host this phone forgot: stay quiet rather than show a mystery.
        if (!PushKeys.known(this, handle)) return
        PushNotifications.show(this, PushKeys.open(this, handle, envelope))
    }

    override fun onNewToken(token: String) {
        // The app registers the new token with each host's gateway when it next opens that host.
    }
}
