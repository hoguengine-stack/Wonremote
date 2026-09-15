package com.wonremote.viewer;

import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class DiagnosticExport {
    static final String SCHEME = "wonremote-diagnostics";
    static final int MAX_BYTES = 16384;

    static String parse(Uri request, String pageUrl, boolean mainFrame, boolean gesture) {
        if (!mainFrame || !gesture || pageUrl == null || request.toString().length() > MAX_BYTES * 9) return null;
        Uri page = Uri.parse(pageUrl);
        if (!"https".equals(page.getScheme()) || !"wonremote-a7fd3.web.app".equals(page.getHost())
            || page.getUserInfo() != null || (page.getPort() != -1 && page.getPort() != 443)) return null;
        if (!SCHEME.equals(request.getScheme()) || !"save".equals(request.getHost())
            || request.getUserInfo() != null || request.getPort() != -1 || request.getFragment() != null
            || (request.getPath() != null && !request.getPath().isEmpty())
            || request.getQueryParameters("report").size() != 1 || request.getQueryParameterNames().size() != 1) return null;
        String report = request.getQueryParameter("report");
        return validReport(report) ? report : null;
    }

    static boolean validReport(String report) {
        if (report == null || report.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) return false;
        try { return new JSONObject(report).getInt("schemaVersion") == 1; }
        catch (Exception error) { return false; }
    }

    static Intent createIntent() {
        return new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json").putExtra(Intent.EXTRA_TITLE, "wonremote-diagnostics.json");
    }

    static void write(ContentResolver resolver, Uri uri, String report) throws IOException {
        if (uri == null || !"content".equals(uri.getScheme()) || !validReport(report)) throw new IOException("Invalid diagnostic destination or report");
        try (OutputStream output = resolver.openOutputStream(uri, "wt")) {
            if (output == null) throw new IOException("Document provider did not open the file");
            output.write(report.getBytes(StandardCharsets.UTF_8));
        }
    }
}
