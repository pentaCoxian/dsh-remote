package dev.dshremote.dsh_remote

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugins.webviewflutter.WebViewFlutterAndroidExternalApi

/**
 * Android hands a WebView the window's insets as if it filled the screen, so DSH
 * Web (below the app's own bar) read the status bar as env(safe-area-inset-top)
 * and left an empty band under the bar. This gives the WebView only the part of
 * each system bar it actually lies under, and recomputes it when the WebView
 * moves or resizes (the keyboard lifts it off the gesture bar).
 */
class WebViewInsets(private val engine: FlutterEngine) : MethodChannel.MethodCallHandler {
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "fitToPosition") return result.notImplemented()
        val id = call.argument<Number>("id")?.toLong() ?: return result.error("ARGS", "id is required", null)
        val webView = WebViewFlutterAndroidExternalApi.getWebView(engine, id) ?: return result.error("NO_WEBVIEW", "no WebView $id", null)
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets -> ViewCompat.onApplyWindowInsets(view, overlapping(view, insets)) }
        // Flutter moves the view that holds the WebView, not the WebView itself: watch where it lands.
        var placed = Pair(-1, -1)
        webView.viewTreeObserver.addOnGlobalLayoutListener {
            val location = IntArray(2)
            webView.getLocationInWindow(location)
            val now = Pair(location[1], webView.height)
            if (now != placed) {
                placed = now
                ViewCompat.requestApplyInsets(webView)
            }
        }
        ViewCompat.requestApplyInsets(webView)
        result.success(null)
    }

    private fun overlapping(view: View, insets: WindowInsetsCompat): WindowInsetsCompat {
        val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        val edges = insets.getInsets(types)
        val location = IntArray(2)
        view.getLocationInWindow(location)
        val windowHeight = view.rootView.height
        val top = maxOf(0, edges.top - location[1])
        val bottom = maxOf(0, edges.bottom - (windowHeight - location[1] - view.height))
        return WindowInsetsCompat.Builder(insets)
            .setInsets(types, Insets.of(edges.left, top, edges.right, bottom))
            .setDisplayCutout(if (top == edges.top) insets.displayCutout else null)
            .build()
    }
}
