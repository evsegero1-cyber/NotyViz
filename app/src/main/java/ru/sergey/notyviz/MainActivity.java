package ru.sergey.notyviz;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final int REQ_OPEN = 1;
    private static final String START = "https://appassets.androidplatform.net/assets/index.html";

    private WebView web;
    private boolean pageReady = false;
    private Intent pendingIntent = null;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // Последний открытый файл ждёт, пока страница его заберёт
    private volatile byte[] fileData = null;
    private volatile String fileName = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);

        // Файлы приложения отдаются по https-адресу: так работают модули и worker'ы pdf.js
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse r = loader.shouldInterceptRequest(request.getUrl());
                if (r != null && request.getUrl().getPath() != null && request.getUrl().getPath().endsWith(".mjs")) {
                    r.setMimeType("text/javascript");
                }
                return r;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (pageReady) return;
                pageReady = true;
                handleIntent(pendingIntent != null ? pendingIntent : getIntent());
                pendingIntent = null;
            }
        });
        web.loadUrl(START);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (pageReady) handleIntent(intent);
        else pendingIntent = intent;
    }

    private void handleIntent(Intent intent) {
        Uri uri = null;
        if (intent != null) {
            String action = intent.getAction();
            if (Intent.ACTION_VIEW.equals(action)) {
                uri = intent.getData();
            } else if (Intent.ACTION_SEND.equals(action)) {
                Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (extra instanceof Uri) uri = (Uri) extra;
            }
        }
        if (uri != null) {
            intent.setAction(Intent.ACTION_MAIN);
            loadUri(uri);
        }
    }

    private void loadUri(final Uri uri) {
        io.execute(() -> {
            try {
                String name = queryName(uri);
                byte[] data;
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    if (in == null) throw new Exception("файл не открылся");
                    data = readAll(in);
                }
                fileData = data;
                fileName = name;
                runOnUiThread(() -> web.evaluateJavascript("window.onFileReady && window.onFileReady()", null));
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Не удалось открыть файл: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        });
    }

    private String queryName(Uri uri) {
        String name = null;
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null ? "file" : name;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OPEN && resultCode == RESULT_OK && data != null && data.getData() != null) {
            loadUri(data.getData());
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.onBack ? window.onBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.evaluateJavascript("window.onAppPause && window.onAppPause()", null);
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        super.onDestroy();
    }

    /** Методы, которые вызывает страница */
    private class Bridge {
        @JavascriptInterface
        public boolean hasFile() {
            return fileData != null;
        }

        @JavascriptInterface
        public String getFile() {
            byte[] d = fileData;
            return d == null ? "" : Base64.encodeToString(d, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public String getFileName() {
            return fileName;
        }

        @JavascriptInterface
        public void clearFile() {
            fileData = null;
        }

        @JavascriptInterface
        public void openPicker() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/pdf", "audio/midi", "audio/x-midi", "audio/mid",
                        "application/x-guitar-pro", "application/gpx+xml",
                        "application/vnd.recordare.musicxml+xml", "application/vnd.recordare.musicxml",
                        "application/xml", "text/xml", "application/octet-stream", "application/zip"});
                try {
                    startActivityForResult(i, REQ_OPEN);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Нет приложения для выбора файлов", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void setKeepOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }
}
