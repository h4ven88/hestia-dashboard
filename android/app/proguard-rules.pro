# The bridge is reached by name from JavaScript, so its @JavascriptInterface
# methods must survive minification or the app silently loses the bridge.
-keepclassmembers class com.hestari.hestia.HestiaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
