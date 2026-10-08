package org.ecofutures.simulator;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.io.File;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/**
 * The Android app, as the desktop one: starts its own anvil chain on a free port of this device, opens the
 * simulator against it, and stops the chain when the app is closed. anvil ships inside the APK as
 * lib/&lt;abi&gt;/libanvil.so (a static Linux build), with the small launcher liblaunch.so that starts it; Android
 * extracts both to the app's native library directory, the one place an app may still run a program from.
 */
public class MainActivity extends Activity {
    private static final String ASSETS = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final int PICK_FILE = 1;

    private Process anvil;
    private String rpc;
    private volatile boolean ready;
    private Thread starter;
    private WebView web;
    private ValueCallback<Uri[]> picked;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // a run goes on only while the app is in front: keep the screen on rather than let the phone sleep it
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        // the page is served from the APK's assets on a secure origin, so its storage and modules behave as on the web
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // any other link opens in the browser
                return true;
            }
        });
        // "Load settings": the page's file input opens the system's file picker
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picked != null) picked.onReceiveValue(null);
                picked = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                startActivityForResult(Intent.createChooser(i, "Load settings"), PICK_FILE);
                return true;
            }
        });

        // Android 15 draws an app edge to edge, under the status bar, the gesture bar and any camera cutout; the page
        // sits inside them, and above the keyboard while one is open
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0E1512);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(root);
        web.loadDataWithBaseURL(null, page("Starting the local chain…"), "text/html", "utf-8", null);
        startChain();
    }

    // Android cuts an app off from the network, its own port included, while it is not in front with the screen on:
    // a start interrupted that way finishes when the app is back in front
    @Override
    protected void onResume() {
        super.onResume();
        if (!ready) startChain();
    }

    private void startChain() {
        if (starter != null && starter.isAlive()) return;
        starter = new Thread(this::start, "chain");
        starter.start();
    }

    private void start() {
        try {
            if (anvil == null || !anvil.isAlive()) launch();
            waitForChain(rpc, 60_000);
            ready = true;
            String url = ASSETS + "?rpc=" + Uri.encode(rpc);
            runOnUiThread(() -> web.loadUrl(url));
        } catch (Exception e) {
            String why = String.valueOf(e.getMessage());
            runOnUiThread(() -> web.loadDataWithBaseURL(null, page("The local chain has not answered yet: " + escape(why)
                    + "<br><br>It is tried again whenever the app comes back to the front."), "text/html", "utf-8", null));
        }
    }

    private void launch() throws Exception {
        {
            int port = freePort();
            rpc = "http://127.0.0.1:" + port;
            File lib = new File(getApplicationInfo().nativeLibraryDir);
            // through the launcher, which clears the signals the app's runtime blocks and ignores;
            // 1 January 2026 (each run jumps to its own start), a block gas limit large enough to deploy the contracts, recent states in memory only
            List<String> cmd = Arrays.asList(new File(lib, "liblaunch.so").getAbsolutePath(), new File(lib, "libanvil.so").getAbsolutePath(),
                    "--auto-impersonate", "--timestamp", "1767225600",
                    "--port", String.valueOf(port), "--gas-limit", "100000000", "--prune-history", "64", "--silent");
            ProcessBuilder pb = new ProcessBuilder(cmd).directory(getFilesDir()).redirectErrorStream(true)
                    .redirectInput(new File("/dev/null")).redirectOutput(new File(getFilesDir(), "anvil.log"));
            pb.environment().put("HOME", getFilesDir().getAbsolutePath());
            pb.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
            anvil = pb.start();
        }
    }

    private static int freePort() throws Exception {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    private void waitForChain(String rpc, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        byte[] body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}".getBytes(StandardCharsets.UTF_8);
        String last = "no answer";
        while (System.currentTimeMillis() < end) {
            if (anvil != null && !anvil.isAlive()) throw new Exception("anvil exited with code " + anvil.exitValue());
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(rpc).openConnection();
                c.setRequestMethod("POST");
                c.setRequestProperty("content-type", "application/json");
                c.setConnectTimeout(500);
                c.setReadTimeout(500);
                c.setDoOutput(true);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
                if (c.getResponseCode() == 200) return;
                last = "HTTP " + c.getResponseCode();
            } catch (Exception e) {
                last = e.toString();
            }
            Thread.sleep(200);
        }
        throw new Exception("it did not answer within " + ms / 1000 + " seconds (" + last + ")");
    }

    private static String page(String message) {
        return "<html><body style=\"margin:0;background:#0e1512;color:#cfd8d3;font:16px sans-serif;display:flex;"
                + "align-items:center;justify-content:center;height:100vh;padding:24px;box-sizing:border-box;text-align:center\">"
                + message + "</body></html>";
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE && picked != null) {
            picked.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            picked = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    // Back leaves the app running (the chain with it) rather than closing it
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        if (anvil != null) anvil.destroy();
        web.destroy();
        super.onDestroy();
    }
}
