package dev.dshremote.dsh_remote

import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var push: PushChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        MethodChannel(messenger, "dev.dshremote/device_keys").setMethodCallHandler(DeviceKeys())
        push = PushChannel(this).also { MethodChannel(messenger, "dev.dshremote/push").setMethodCallHandler(it) }
        PushNotifications.ensureChannels(this)
        IrohPipe.nativeInit(applicationContext)

        // iroh cannot see Android network changes from native code; tell it through Dart.
        val network = MethodChannel(messenger, "dev.dshremote/network")
        val main = Handler(Looper.getMainLooper())
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) {
                main.post { network.invokeMethod("changed", null) }
            }

            override fun onLost(n: Network) {
                main.post { network.invokeMethod("changed", null) }
            }
        }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback)
        networkCallback = callback
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (push?.onPermissionResult(requestCode, grantResults) != true) super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onDestroy() {
        networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        networkCallback = null
        super.onDestroy()
    }
}
