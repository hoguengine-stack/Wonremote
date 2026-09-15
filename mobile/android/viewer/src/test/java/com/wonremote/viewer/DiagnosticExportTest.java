package com.wonremote.viewer;

import static org.junit.Assert.*;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.Robolectric;
import android.webkit.WebView;
import android.webkit.WebResourceRequest;
import java.util.Collections;
import java.util.Map;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public class DiagnosticExportTest {
    private final String report = "{\n  \"schemaVersion\": 1, \"presence\": \"online\"\n}";
    private final String origin = "https://wonremote-a7fd3.web.app/viewer";
    private Uri request(String text) { return Uri.parse("wonremote-diagnostics://save?report=" + Uri.encode(text)); }

    @Test public void exactPreviewPassesOnlyFromTrustedMainFrameGesture() {
        assertEquals(report, DiagnosticExport.parse(request(report), origin, true, true));
        assertNull(DiagnosticExport.parse(request(report), origin, false, true));
        assertNull(DiagnosticExport.parse(request(report), origin, true, false));
        for (String page : new String[]{"https://evil.test/", "http://wonremote-a7fd3.web.app/viewer", "https://wonremote-a7fd3.web.app:444/viewer", "https://user@wonremote-a7fd3.web.app/viewer"}) {
            assertNull(DiagnosticExport.parse(request(report), page, true, true));
        }
        assertNull(DiagnosticExport.parse(Uri.parse(request(report) + "&path=secret"), origin, true, true));
        assertNull(DiagnosticExport.parse(Uri.parse(request(report) + "&report=x"), origin, true, true));
    }

    @Test public void rejectsInvalidAndOversizedPayloads() {
        assertNull(DiagnosticExport.parse(request("not-json"), origin, true, true));
        assertNull(DiagnosticExport.parse(request("{\"schemaVersion\":2}"), origin, true, true));
        assertNull(DiagnosticExport.parse(request("{\"schemaVersion\":1,\"x\":\"" + new String(new char[17000]).replace('\0','x') + "\"}"), origin, true, true));
    }

    @Test public void opensSystemPickerWithoutAnArbitraryPathAndWritesExactReviewedBytes() throws Exception {
        Intent intent = DiagnosticExport.createIntent();
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("application/json", intent.getType());
        assertEquals("wonremote-diagnostics.json", intent.getStringExtra(Intent.EXTRA_TITLE));
        assertNull(intent.getData());
        ContentResolver resolver = RuntimeEnvironment.getApplication().getContentResolver();
        Uri selected = Uri.parse("content://documents/reviewed-report");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Shadows.shadowOf(resolver).registerOutputStream(selected, output);
        DiagnosticExport.write(resolver, selected, report);
        assertArrayEquals(report.getBytes(StandardCharsets.UTF_8), output.toByteArray());
        try { DiagnosticExport.write(resolver, Uri.parse("file:///arbitrary.json"), report); fail("must reject file path"); }
        catch (java.io.IOException expected) { }
    }

    @Test public void activityRoutesClickToOnePickerAndWritesOnlyAfterSelection() throws Exception {
        org.robolectric.android.controller.ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create();
        MainActivity activity = controller.get();
        java.lang.reflect.Field field = MainActivity.class.getDeclaredField("webView");
        field.setAccessible(true);
        WebView view = (WebView) field.get(activity);
        WebResourceRequest click = new WebResourceRequest() {
            public Uri getUrl() { return request(report); }
            public boolean isForMainFrame() { return true; }
            public boolean isRedirect() { return false; }
            public boolean hasGesture() { return true; }
            public String getMethod() { return "GET"; }
            public Map<String,String> getRequestHeaders() { return Collections.emptyMap(); }
        };
        try {
            assertTrue(view.getSettings().getUserAgentString().contains("WonRemoteViewer/1"));
            assertTrue(view.getWebViewClient().shouldOverrideUrlLoading(view, click));
            org.robolectric.shadows.ShadowActivity.IntentForResult first = Shadows.shadowOf(activity).getNextStartedActivityForResult();
            assertNotNull(first);
            assertEquals(Intent.ACTION_CREATE_DOCUMENT, first.intent.getAction());
            view.getWebViewClient().shouldOverrideUrlLoading(view, click);
            assertNull(Shadows.shadowOf(activity).getNextStartedActivityForResult());
            activity.onActivityResult(first.requestCode, android.app.Activity.RESULT_CANCELED, null);
            view.getWebViewClient().shouldOverrideUrlLoading(view, click);
            assertNotNull(Shadows.shadowOf(activity).getNextStartedActivityForResult());
            Uri selected = Uri.parse("content://documents/activity-report");
            java.util.concurrent.CountDownLatch closed = new java.util.concurrent.CountDownLatch(1);
            ByteArrayOutputStream output = new ByteArrayOutputStream() {
                @Override public void close() { closed.countDown(); }
            };
            Shadows.shadowOf(activity.getContentResolver()).registerOutputStream(selected, output);
            assertEquals(0, output.size());
            activity.onActivityResult(first.requestCode, android.app.Activity.RESULT_OK, new Intent().setData(selected));
            assertTrue(closed.await(3, java.util.concurrent.TimeUnit.SECONDS));
            assertArrayEquals(report.getBytes(StandardCharsets.UTF_8), output.toByteArray());
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        } finally { controller.destroy(); }
    }
}
