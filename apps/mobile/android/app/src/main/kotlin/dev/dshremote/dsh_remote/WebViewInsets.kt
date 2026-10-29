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
        // Insets arrive before layout, so they can be computed at a place the
        // WebView is about to leave: Flutter moves the view that holds it, and a
        // re-created platform view hands the WebView over to a new one that
        // starts at the top of the window. Once laid out somewhere else, ask
        // again (once per place, in case they never reach the WebView).
        var computedAt: Pair<Int, Int>? = null
        var askedAt: Pair<Int, Int>? = null
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            computedAt = placement(view)
            askedAt = null
            ViewCompat.onApplyWindowInsets(view, overlapping(view, insets))
        }
        webView.viewTreeObserver.addOnGlobalLayoutListener {
            val now = placement(webView)
            if (now != computedAt && now != askedAt) {
                askedAt = now
                ViewCompat.requestApplyInsets(webView)
            }
        }
        ViewCompat.requestApplyInsets(webView)
        result.success(null)
    }

    /** The WebView's top in the window, and its height. */
    private fun placement(view: View): Pair<Int, Int> {
        val location = IntArray(2)
        view.getLocationInWindow(location)
        return Pair(location[1], view.height)
    }

    private fun overlapping(view: View, insets: WindowInsetsCompat): WindowInsetsCompat {
        val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        val edges = insets.getInsets(types)
        val (y, height) = placement(view)
        val top = maxOf(0, edges.top - y)
        val bottom = maxOf(0, edges.bottom - (view.rootView.height - y - height))
        return WindowInsetsCompat.Builder(insets)
            .setInsets(types, Insets.of(edges.left, top, edges.right, bottom))
            .setDisplayCutout(if (top == edges.top) insets.displayCutout else null)
            .build()
    }
}
