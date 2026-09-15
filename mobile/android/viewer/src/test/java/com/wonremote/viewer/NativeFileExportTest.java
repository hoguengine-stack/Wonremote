package com.wonremote.viewer;

import static org.junit.Assert.*;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Looper;
import android.webkit.WebMessage;
import android.webkit.WebView;
import java.io.ByteArrayOutputStream;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.fakes.RoboWebMessagePort;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public class NativeFileExportTest {
    private static final String URL = "https://wonremote-a7fd3.web.app/viewer";
    private static final String BEGIN = "{\"type\":\"begin\",\"file\":{\"id\":\"test\",\"filename\":\"test.bin\",\"totalBytes\":0,\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\"}}";
    private static final class TestView extends WebView {
        WebMessage message; Uri origin;
        TestView(Activity activity) { super(activity); loadUrl(URL); }
        @Override public void postWebMessage(WebMessage value, Uri target) { message = value; origin = target; }
    }
    private static String awaitReply(RoboWebMessagePort port, int count) throws Exception {
        long deadline = System.nanoTime() + 3_000_000_000L;
        while (port.getReceivedMessages().size() < count && System.nanoTime() < deadline) {
            Shadows.shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5);
        }
        assertEquals(count, port.getReceivedMessages().size());
        return new JSONObject(port.getReceivedMessages().get(count - 1)).getString("type");
    }
    @Test public void selectedDestinationReceivesVerifiedFileAndCancellationCanRetry() throws Exception {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        NativeFileExport export = new NativeFileExport(activity);
        TestView view = new TestView(activity);
        try {
            export.attach(view, URL);
            assertEquals("https://wonremote-a7fd3.web.app", view.origin.toString());
            assertEquals("wonremote:file-export:1", view.message.getData());
            RoboWebMessagePort client = (RoboWebMessagePort) view.message.getPorts()[0];
            client.postMessage(new WebMessage(BEGIN));
            Intent chooser = Shadows.shadowOf(activity).getNextStartedActivityForResult().intent;
            assertEquals(Intent.ACTION_CREATE_DOCUMENT, chooser.getAction());
            assertEquals("test.bin", chooser.getStringExtra(Intent.EXTRA_TITLE));
            export.result(Activity.RESULT_CANCELED, null);
            assertEquals("cancelled", awaitReply(client, 1));
            client.postMessage(new WebMessage(BEGIN));
            Uri uri = Uri.parse("content://test/selected");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            Shadows.shadowOf(activity.getContentResolver()).registerOutputStream(uri, bytes);
            export.result(Activity.RESULT_OK, new Intent().setData(uri));
            assertEquals("ready", awaitReply(client, 2));
            client.postMessage(new WebMessage("{\"id\":\"test\",\"type\":\"finish\"}"));
            assertEquals("saved", awaitReply(client, 3));
            assertEquals(0, bytes.size());
        } finally { export.destroy(); view.destroy(); }
    }
    @Test public void navigationInvalidatesOldChooserAndOnlyExactHttpsOriginReceivesPort() throws Exception {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        NativeFileExport export = new NativeFileExport(activity);
        TestView view = new TestView(activity);
        try {
            for (String url : new String[]{"http://wonremote-a7fd3.web.app", "https://wonremote-a7fd3.web.app:444", "https://evil.test", "https://user@wonremote-a7fd3.web.app"}) {
                export.attach(view, url); assertNull(view.message);
            }
            export.attach(view, URL);
            RoboWebMessagePort client = (RoboWebMessagePort) view.message.getPorts()[0];
            client.postMessage(new WebMessage(BEGIN));
            export.detach();
            assertTrue(client.getConnectedPort().isClosed());
            export.attach(view, URL);
            RoboWebMessagePort next = (RoboWebMessagePort) view.message.getPorts()[0];
            next.postMessage(new WebMessage(BEGIN));
            assertEquals("error", awaitReply(next, 1));
            export.result(Activity.RESULT_OK, new Intent().setData(Uri.parse("content://test/stale")));
            assertEquals(1, next.getReceivedMessages().size());
            next.postMessage(new WebMessage(BEGIN));
            export.result(Activity.RESULT_CANCELED, null);
            assertEquals("cancelled", awaitReply(next, 2));
        } finally { export.destroy(); view.destroy(); }
    }
    @Test public void chunkedPortWritesExactBytesBeforeSavedReply() throws Exception {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        NativeFileExport export = new NativeFileExport(activity);
        TestView view = new TestView(activity);
        byte[] input = new byte[40000]; java.util.Arrays.fill(input, (byte) 73);
        StringBuilder hash = new StringBuilder();
        for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(input)) hash.append(String.format("%02x", b & 255));
        JSONObject begin = new JSONObject(BEGIN);
        begin.getJSONObject("file").put("totalBytes", input.length).put("sha256", hash.toString());
        try {
            export.attach(view, URL);
            RoboWebMessagePort client = (RoboWebMessagePort) view.message.getPorts()[0];
            client.postMessage(new WebMessage(begin.toString()));
            Uri uri = Uri.parse("content://test/chunks");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            Shadows.shadowOf(activity.getContentResolver()).registerOutputStream(uri, output);
            export.result(Activity.RESULT_OK, new Intent().setData(uri));
            assertEquals("ready", awaitReply(client, 1));
            for (int i = 0; i < 2; i++) {
                byte[] part = java.util.Arrays.copyOfRange(input, i * 32768, Math.min(input.length, (i + 1) * 32768));
                String chunk = new JSONObject().put("id", "test").put("type", "chunk").put("index", i)
                    .put("data", android.util.Base64.encodeToString(part, android.util.Base64.NO_WRAP)).toString();
                client.postMessage(new WebMessage(chunk));
                assertEquals("ack", awaitReply(client, i + 2));
            }
            assertArrayEquals(input, output.toByteArray());
            client.postMessage(new WebMessage("{\"id\":\"test\",\"type\":\"finish\"}"));
            assertEquals("saved", awaitReply(client, 4));
        } finally { export.destroy(); view.destroy(); }
    }
}
