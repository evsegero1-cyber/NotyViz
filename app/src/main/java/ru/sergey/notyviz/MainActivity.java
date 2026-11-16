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
import android.webkit.WebChromeClient;
import android.webkit.PermissionRequest;
import android.Manifest;
import android.content.pm.PackageManager;
import android.widget.Toast;
import android.content.ClipData;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import java.io.OutputStream;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final int REQ_OPEN = 1;
    private static final int REQ_MULTI = 2;
    private static final int REQ_SAVE = 3;
    private static final int REQ_MIC = 4;
    private PermissionRequest pendingMic = null;
    private static final String START = "https://appassets.androidplatform.net/assets/index.html";

    private WebView web;
    private boolean pageReady = false;
    private Intent pendingIntent = null;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // Последний открытый файл ждёт, пока страница его заберёт
    private volatile byte[] fileData = null;
    private volatile String fileName = "";
    // Несколько файлов для объединения
    private final java.util.List<byte[]> multiData = new java.util.ArrayList<>();
    private final java.util.List<String> multiNames = new java.util.ArrayList<>();
    // Файл, который ждёт сохранения (экспорт)
    private byte[] saveData = null;
    private boolean landscapeLocked = false;

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
        // Микрофон для тюнера: страница просит доступ → спрашиваем разрешение Android → отдаём странице
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsMic = false;
                    for (String r : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
                    if (!wantsMic) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        if (pendingMic != null) pendingMic.deny();
                        pendingMic = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }
        });
        web.loadUrl(START);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MIC || pendingMic == null) return;
        boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else {
            pendingMic.deny();
            Toast.makeText(this, "Без доступа к микрофону тюнер не слышит гитару", Toast.LENGTH_LONG).show();
        }
        pendingMic = null;
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
        } else if (requestCode == REQ_MULTI && resultCode == RESULT_OK && data != null) {
            final java.util.List<Uri> uris = new java.util.ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            io.execute(() -> {
                synchronized (multiData) {
                    multiData.clear(); multiNames.clear();
                    for (Uri u : uris) {
                        try (InputStream in = getContentResolver().openInputStream(u)) {
                            if (in == null) continue;
                            multiData.add(readAll(in)); multiNames.add(queryName(u));
                        } catch (Exception ignored) {
                        }
                    }
                }
                runOnUiThread(() -> web.evaluateJavascript("window.onFilesReady && window.onFilesReady()", null));
            });
        } else if (requestCode == REQ_SAVE) {
            boolean ok = false;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && saveData != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    out.write(saveData); ok = true;
                } catch (Exception e) {
                    Toast.makeText(this, "Не удалось сохранить: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
            saveData = null;
            web.evaluateJavascript("window.onSaved && window.onSaved(" + ok + ")", null);
        }
    }

    // Полноэкранный альбомный режим
    private void applyLandscape(boolean on, boolean rotate) {
        if (rotate || !on) {
            landscapeLocked = on && rotate;
            setRequestedOrientation(on ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        }
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = on ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            getWindow().setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                if (on) {
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    c.hide(WindowInsets.Type.systemBars());
                } else c.show(WindowInsets.Type.systemBars());
            }
        } else {
            int flags = on ? (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION) : 0;
            getWindow().getDecorView().setSystemUiVisibility(flags);
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
        public void openPickerMulti() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_MULTI);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Нет приложения для выбора файлов", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public int getFilesCount() {
            synchronized (multiData) { return multiData.size(); }
        }

        @JavascriptInterface
        public String getFileAt(int i) {
            synchronized (multiData) { return i < multiData.size() ? Base64.encodeToString(multiData.get(i), Base64.NO_WRAP) : ""; }
        }

        @JavascriptInterface
        public String getFileNameAt(int i) {
            synchronized (multiData) { return i < multiNames.size() ? multiNames.get(i) : ""; }
        }

        @JavascriptInterface
        public void clearFiles() {
            synchronized (multiData) { multiData.clear(); multiNames.clear(); }
        }

        @JavascriptInterface
        public void saveFile(String name, String mime, String b64) {
            saveData = Base64.decode(b64, Base64.DEFAULT);
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Нет приложения для сохранения файлов", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void setLandscape(boolean on) {
            runOnUiThread(() -> applyLandscape(on, true));
        }

        @JavascriptInterface
        public void setImmersive(boolean on) {
            runOnUiThread(() -> applyLandscape(on, false));
        }

        @JavascriptInterface
        public boolean isLandscapeLocked() {
            return landscapeLocked;
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
