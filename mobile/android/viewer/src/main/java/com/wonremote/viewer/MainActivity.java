package com.wonremote.viewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public final class MainActivity extends com.wonremote.update.UpdateActivity {
    private static final String VIEWER_HOST = "wonremote-a7fd3.web.app";
    private static final String VIEWER_URL = "https://" + VIEWER_HOST + "/viewer";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int DARK = Color.rgb(16, 32, 42);
    private static final int ACCENT = Color.rgb(32, 184, 154);

    private WebView webView;
    private View loadingView;
    private View errorView;
    private boolean mainFrameFailed;
    private ValueCallback<Uri[]> fileChooserCallback;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(DARK);
        getWindow().setNavigationBarColor(DARK);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(DARK);
        webView = new WebView(this);
        webView.setBackgroundColor(DARK);
        configureWebView(webView);
        root.addView(webView, matchMatch());
        loadingView = buildLoadingView();
        root.addView(loadingView, matchMatch());
        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, matchMatch());
        root.addView(updateButton(), new FrameLayout.LayoutParams(dp(40), dp(40), Gravity.END | Gravity.BOTTOM));
        setContentView(root);

        if (savedInstanceState == null) {
            webView.loadUrl(VIEWER_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSafeBrowsingEnabled(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, false);

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        view.setWebViewClient(new ViewerWebViewClient());
        view.setWebChromeClient(new ViewerChromeClient());
    }

    private View buildLoadingView() {
        LinearLayout layout = centeredPanel();
        TextView mark = text("V", 28, true, DARK);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(rounded(ACCENT, 14));
        layout.addView(mark, new LinearLayout.LayoutParams(dp(60), dp(60)));

        TextView title = text("WonRemote Viewer", 21, true, Color.WHITE);
        LinearLayout.LayoutParams titleParams = wrapWrap();
        titleParams.topMargin = dp(18);
        layout.addView(title, titleParams);

        ProgressBar progress = new ProgressBar(this);
        progress.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(40), dp(40));
        progressParams.topMargin = dp(18);
        layout.addView(progress, progressParams);
        return layout;
    }

    private View buildErrorView() {
        LinearLayout layout = centeredPanel();
        TextView title = text("연결할 수 없습니다", 21, true, Color.WHITE);
        layout.addView(title, wrapWrap());
        TextView message = text("네트워크 연결을 확인한 뒤 다시 시도하세요.", 14, false, Color.rgb(189, 202, 210));
        message.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams messageParams = wrapWrap();
        messageParams.topMargin = dp(8);
        layout.addView(message, messageParams);

        Button retry = new Button(this);
        retry.setText("다시 시도");
        retry.setTextColor(DARK);
        retry.setTextSize(15);
        retry.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        retry.setAllCaps(false);
        retry.setBackground(rounded(ACCENT, 9));
        retry.setOnClickListener(view -> webView.loadUrl(VIEWER_URL));
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(dp(180), dp(50));
        retryParams.topMargin = dp(22);
        layout.addView(retry, retryParams);
        return layout;
    }

    private LinearLayout centeredPanel() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(dp(24), dp(24), dp(24), dp(24));
        layout.setBackgroundColor(DARK);
        return layout;
    }

    private void showLoading() {
        loadingView.setVisibility(View.VISIBLE);
        errorView.setVisibility(View.GONE);
    }

    private void showContent() {
        loadingView.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
    }

    private void showError() {
        loadingView.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) {
            hideFullscreen();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) {
            return;
        }
        fileChooserCallback.onReceiveValue(
            resultCode == RESULT_OK ? WebChromeClient.FileChooserParams.parseResult(resultCode, data) : null
        );
        fileChooserCallback = null;
    }

    @Override
    protected void onDestroy() {
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        webView.stopLoading();
        webView.destroy();
        super.onDestroy();
    }

    private void showFullscreen(View view, WebChromeClient.CustomViewCallback callback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden();
            return;
        }
        fullscreenView = view;
        fullscreenCallback = callback;
        addContentView(view, matchMatch());
        webView.setVisibility(View.GONE);
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );
    }

    private void hideFullscreen() {
        if (fullscreenView == null) {
            return;
        }
        ((ViewGroup) fullscreenView.getParent()).removeView(fullscreenView);
        fullscreenView = null;
        webView.setVisibility(View.VISIBLE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        if (fullscreenCallback != null) {
            fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private TextView text(String value, int size, boolean bold, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        }
        return view;
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    private FrameLayout.LayoutParams matchMatch() {
        return new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
    }

    private LinearLayout.LayoutParams wrapWrap() {
        return new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class ViewerWebViewClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            mainFrameFailed = false;
            showLoading();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!mainFrameFailed) {
                showContent();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                mainFrameFailed = true;
                showError();
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame()) {
                mainFrameFailed = true;
                showError();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("https".equals(uri.getScheme()) && VIEWER_HOST.equals(uri.getHost())) {
                return false;
            }
            openExternal(uri);
            return true;
        }
    }

    private final class ViewerChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
            WebView view,
            ValueCallback<Uri[]> callback,
            FileChooserParams params
        ) {
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(null);
            }
            fileChooserCallback = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                return true;
            } catch (ActivityNotFoundException error) {
                fileChooserCallback = null;
                return false;
            }
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            showFullscreen(view, callback);
        }

        @Override
        public void onHideCustomView() {
            hideFullscreen();
        }
    }
}
