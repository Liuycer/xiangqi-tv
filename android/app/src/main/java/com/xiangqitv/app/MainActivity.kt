package com.xiangqitv.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.annotation.RequiresApi
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var predictiveBackCallback: Any? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(0xFF17110C.toInt())
            isFocusable = true
            isFocusableInTouchMode = true
            isHorizontalScrollBarEnabled = false
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER

            settings.apply {
                javaScriptEnabled = true
                javaScriptCanOpenWindowsAutomatically = false
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_NO_CACHE
                builtInZoomControls = false
                displayZoomControls = false
                textZoom = 100
                setGeolocationEnabled(false)
                setSupportMultipleWindows(false)
                setSupportZoom(false)
            }

            webViewClient = LocalContentWebViewClient(assetLoader)
            webChromeClient = object : WebChromeClient() {
                override fun onJsConfirm(
                    view: WebView,
                    url: String,
                    message: String,
                    result: JsResult,
                ): Boolean {
                    val dialog = AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton("确定") { _, _ -> result.confirm() }
                        .setNegativeButton("取消") { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }
                        .create()
                    dialog.show()
                    return true
                }

                override fun onJsAlert(
                    view: WebView,
                    url: String,
                    message: String,
                    result: JsResult,
                ): Boolean {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton("确定") { _, _ -> result.confirm() }
                        .setOnCancelListener { result.cancel() }
                        .create()
                        .show()
                    return true
                }
            }
        }

        setContentView(webView)
        webView.loadUrl(APP_URL)
        webView.requestFocus()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            predictiveBackCallback = Api33BackHandler.register(this)
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
        }
    }

    override fun onPause() {
        if (::webView.isInitialized) {
            webView.onPause()
        }
        super.onPause()
    }

    @SuppressLint("GestureBackNavigation")
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() = handleBackRequest()

    private fun handleBackRequest() {
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }

        webView.evaluateJavascript(BACK_HANDLER_SCRIPT) { result ->
            if (result != "true" && !isFinishing && !isDestroyed) {
                finish()
            }
        }
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            predictiveBackCallback?.let { Api33BackHandler.unregister(this, it) }
            predictiveBackCallback = null
        }
        if (::webView.isInitialized) {
            webView.apply {
                stopLoading()
                loadUrl("about:blank")
                clearHistory()
                removeAllViews()
                destroy()
            }
        }
        super.onDestroy()
    }

    private class LocalContentWebViewClient(
        private val assetLoader: WebViewAssetLoader,
    ) : WebViewClientCompat() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean = !isLocalAppUrl(request.url)

        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
            !isLocalAppUrl(Uri.parse(url))

        private fun isLocalAppUrl(uri: Uri): Boolean =
            uri.scheme == "https" &&
                uri.host == APP_ASSET_HOST &&
                uri.path?.startsWith(APP_ASSET_PATH) == true
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private object Api33BackHandler {
        fun register(activity: MainActivity): Any {
            val callback = OnBackInvokedCallback { activity.handleBackRequest() }
            activity.onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                callback,
            )
            return callback
        }

        fun unregister(activity: MainActivity, callback: Any) {
            activity.onBackInvokedDispatcher.unregisterOnBackInvokedCallback(
                callback as OnBackInvokedCallback,
            )
        }
    }

    private companion object {
        const val APP_URL = "https://appassets.androidplatform.net/assets/index.html"
        const val APP_ASSET_HOST = "appassets.androidplatform.net"
        const val APP_ASSET_PATH = "/assets/"
        const val BACK_HANDLER_SCRIPT =
            "(function(){return typeof window.__xiangqiHandleBack === 'function'" +
                " ? window.__xiangqiHandleBack() : false;})()"
    }
}
