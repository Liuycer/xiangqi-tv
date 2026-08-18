package com.xiangqitv.app

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

class MainActivity : Activity() {
    private lateinit var webView: WebView

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
        }

        setContentView(webView)
        webView.loadUrl(APP_URL)
        webView.requestFocus()
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

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }

        webView.evaluateJavascript(BACK_HANDLER_SCRIPT) { result ->
            if (result != "true" && !isFinishing && !isDestroyed) {
                exitFromBack()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun exitFromBack() = super.onBackPressed()

    override fun onDestroy() {
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

    private companion object {
        const val APP_URL = "https://appassets.androidplatform.net/assets/index.html"
        const val APP_ASSET_HOST = "appassets.androidplatform.net"
        const val APP_ASSET_PATH = "/assets/"
        const val BACK_HANDLER_SCRIPT =
            "(function(){return typeof window.__xiangqiHandleBack === 'function'" +
                " ? window.__xiangqiHandleBack() : false;})()"
    }
}
