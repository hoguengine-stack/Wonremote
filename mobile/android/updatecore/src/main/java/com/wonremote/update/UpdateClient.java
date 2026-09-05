package com.wonremote.update;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class UpdateClient implements AutoCloseable {
    public static final String HOST = "wonremote-a7fd3.web.app";
    public static final String MANIFEST = "https://" + HOST + "/download/android-update.json";
    public interface Fetcher { InputStream open(String url) throws Exception; }
    public static final class Release {
        public final String packageId, versionName, url, zipHash, apkHash;
        public final long versionCode, apkSize, zipSize;
        Release(JSONObject json, String id) throws Exception {
            packageId = id;
            versionName = json.getString("versionName");
            versionCode = json.getLong("versionCode");
            url = json.getString("url");
            zipHash = json.getString("zipSha256");
            apkHash = json.getString("apkSha256");
            apkSize = json.getLong("apkSize");
            zipSize = json.getLong("zipSize");
            URI uri = new URI(url);
            if (!"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost())
                || uri.getPort() != -1 || uri.getUserInfo() != null
                || !uri.getPath().startsWith("/download/android/v") || !uri.getPath().endsWith(".zip")
                || !zipHash.matches("[a-f0-9]{64}") || !apkHash.matches("[a-f0-9]{64}")
                || apkSize < 1 || apkSize > 128L * 1024 * 1024
                || zipSize < 1 || zipSize > 64L * 1024 * 1024 || versionCode < 1) {
                throw new IOException("Invalid Android release metadata");
            }
        }
    }
    private final String packageId;
    private final long installedVersion;
    private final Fetcher fetcher;
    private final AtomicBoolean busy = new AtomicBoolean();
    private boolean startupChecked;
    private volatile boolean closed;
    private volatile InputStream activeStream;

    public UpdateClient(String id, long version, Fetcher fetcher) {
        this.packageId = id;
        this.installedVersion = version;
        this.fetcher = fetcher;
    }
    // Calls occur only on launch or explicit refresh; no timer or automatic retry.
    public Release check(boolean manual) throws Exception {
        synchronized (this) {
            if (closed || busy.get() || (!manual && startupChecked)) return null;
            startupChecked = true;
            busy.set(true);
        }
        try {
            JSONObject manifest = new JSONObject(new String(read(MANIFEST, 64 * 1024), StandardCharsets.UTF_8));
            if (manifest.getInt("schemaVersion") != 1) throw new IOException("Unsupported update manifest");
            Release release = new Release(manifest.getJSONObject("apps").getJSONObject(packageId), packageId);
            return release.versionCode > installedVersion ? release : null;
        } finally { busy.set(false); }
    }
    public void download(Release release, File destination) throws Exception {
        if (closed || !busy.compareAndSet(false, true)) throw new IOException("Updater unavailable");
        boolean complete = false;
        try {
            byte[] zip = read(release.url, release.zipSize);
            if (zip.length != release.zipSize || !sha256(zip).equals(release.zipHash))
                throw new IOException("Update ZIP verification failed");
            File parent = destination.getParentFile();
            if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Update directory unavailable");
            try (ZipInputStream input = new ZipInputStream(new ByteArrayInputStream(zip));
                 OutputStream output = new FileOutputStream(destination)) {
                ZipEntry entry = input.getNextEntry();
                if (entry == null || entry.isDirectory() || !entry.getName().matches("WonRemote-[A-Za-z-]+\\.apk"))
                    throw new IOException("Unexpected update ZIP entry");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[32768];
                long size = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    ensureOpen();
                    size += count;
                    if (size > release.apkSize) throw new IOException("Update APK exceeds declared size");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                if (size != release.apkSize || !hex(digest.digest()).equals(release.apkHash)
                    || input.getNextEntry() != null) throw new IOException("Update APK verification failed");
            }
            complete = true;
        } finally {
            if (!complete) destination.delete();
            busy.set(false);
        }
    }
    private byte[] read(String url, long limit) throws Exception {
        ensureOpen();
        InputStream input = fetcher.open(url);
        activeStream = input;
        try (input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) {
                ensureOpen();
                if ((long) output.size() + count > limit) throw new IOException("Update response too large");
                output.write(buffer, 0, count);
            }
            ensureOpen();
            return output.toByteArray();
        } finally { activeStream = null; }
    }
    private void ensureOpen() throws IOException {
        if (closed || Thread.currentThread().isInterrupted()) throw new IOException("Update cancelled");
    }
    @Override public void close() {
        closed = true;
        InputStream stream = activeStream;
        if (stream != null) try { stream.close(); } catch (IOException ignored) { }
    }
    public static InputStream openHttps(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Cache-Control", "no-cache");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Update server HTTP " + connection.getResponseCode());
            return new FilterInputStream(connection.getInputStream()) {
                @Override public void close() throws IOException {
                    try { super.close(); } finally { connection.disconnect(); }
                }
            };
        } catch (Exception error) { connection.disconnect(); throw error; }
    }
    static String sha256(byte[] data) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(data));
    }
    private static String hex(byte[] data) {
        StringBuilder result = new StringBuilder();
        for (byte value : data) result.append(String.format("%02x", value & 255));
        return result.toString();
    }
}
