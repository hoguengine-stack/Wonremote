package com.wonremote.viewer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

final class NativeFileExport {
    static final int REQUEST = 1003;
    private static final String ORIGIN = "https://wonremote-a7fd3.web.app";
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private WebMessagePort port;
    private FileExportSession.Metadata pending;
    private boolean choosing, busy, active, destroyed;
    private int generation;
    // Output access is confined to the single writer, including cleanup.
    private FileExportSession sink;

    NativeFileExport(Activity activity) { this.activity = activity; }

    static boolean trusted(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        return "https".equals(uri.getScheme()) && "wonremote-a7fd3.web.app".equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }

    void attach(WebView view, String url) {
        detach();
        if (destroyed || !trusted(url) || !trusted(view.getUrl())) return;
        WebMessagePort[] pair = view.createWebMessageChannel();
        port = pair[0];
        int owner = generation;
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort source, WebMessage message) {
                if (owner != generation || source != port || destroyed) return;
                receive(message.getData());
            }
        });
        view.postWebMessage(new WebMessage("wonremote:file-export:1", new WebMessagePort[]{pair[1]}), Uri.parse(ORIGIN));
    }

    private void reply(String message) {
        if (port != null) {
            try { port.postMessage(new WebMessage(message)); }
            catch (IllegalStateException error) { detach(); }
        }
    }

    private void receive(String text) {
        if (busy) { detach(); return; }
        try {
            if (text == null || text.length() > 45000) throw new IllegalArgumentException();
            JSONObject message = new JSONObject(text);
            if ("cancel".equals(message.optString("type")) && choosing && pending != null
                && message.length() == 2 && pending.id.equals(message.optString("id"))) {
                pending = null;
                reply("{\"type\":\"cancelled\"}");
                return;
            }
            if ("begin".equals(message.optString("type"))) {
                if (active || choosing || message.length() != 2) throw new IllegalArgumentException();
                pending = FileExportSession.Metadata.parse(message.getJSONObject("file").toString());
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, pending.filename);
                choosing = true;
                try { activity.startActivityForResult(intent, REQUEST); }
                catch (RuntimeException error) { pending = null; choosing = false; throw error; }
                return;
            }
            if (!active) throw new IllegalArgumentException();
            busy = true;
            int owner = generation;
            writer.execute(() -> {
                String response;
                boolean completed = false;
                try { response = sink.acceptMessage(text); completed = sink.isComplete() || "cancelled".equals(new JSONObject(response).optString("type")); }
                catch (Exception error) { response = "{\"type\":\"error\"}"; completed = true; closeSink(); }
                final String result = response;
                final boolean terminal = completed;
                main.post(() -> {
                    if (owner != generation || destroyed) return;
                    busy = false;
                    if (terminal) active = false;
                    reply(result);
                });
            });
        } catch (Exception error) { reply("{\"type\":\"error\"}"); }
    }

    void result(int resultCode, Intent data) {
        if (!choosing) return;
        choosing = false;
        FileExportSession.Metadata metadata = pending;
        pending = null;
        if (destroyed || metadata == null || port == null) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            reply("{\"type\":\"cancelled\"}"); return;
        }
        busy = true;
        int owner = generation;
        writer.execute(() -> {
            String response;
            boolean opened;
            try {
                sink = FileExportSession.open(activity.getContentResolver(), data.getData(), metadata);
                response = new JSONObject().put("type", "ready").put("id", metadata.id).toString();
                opened = true;
            } catch (Exception error) { response = "{\"type\":\"error\"}"; opened = false; }
            final String result = response;
            final boolean ready = opened;
            main.post(() -> {
                if (owner != generation || destroyed) return;
                busy = false; active = ready; reply(result);
            });
        });
    }

    void detach() {
        generation++;
        if (port != null) { port.close(); port = null; }
        // Keep the outstanding chooser marker until its old result arrives.
        pending = null; busy = false; active = false;
        if (!writer.isShutdown()) writer.execute(this::closeSink);
    }

    private void closeSink() {
        if (sink != null) {
            try { sink.close(); } catch (Exception ignored) { }
            sink = null;
        }
    }

    void destroy() { detach(); destroyed = true; writer.shutdown(); }
}
