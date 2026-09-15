package com.wonremote.viewer;

import android.content.ContentResolver;
import android.net.Uri;
import android.util.Base64;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

final class FileExportSession implements AutoCloseable {
    static final long MAX_BYTES = 500L * 1024 * 1024;
    static final int CHUNK_BYTES = 32768;

    static final class Metadata {
        final String id, filename, sha256;
        final long totalBytes;
        private Metadata(String id, String filename, long totalBytes, String sha256) {
            this.id = id; this.filename = filename; this.totalBytes = totalBytes; this.sha256 = sha256;
        }
        static Metadata parse(String json) throws IOException {
            try {
                if (json == null || json.length() > 8192) throw new IOException("Invalid file metadata");
                JSONObject value = new JSONObject(json);
                Object count = value.get("totalBytes");
                String id = value.getString("id"), name = value.getString("filename"), hash = value.getString("sha256");
                long size = value.getLong("totalBytes");
                if (value.length() != 4 || !(value.get("id") instanceof String) || !(value.get("filename") instanceof String)
                    || !(value.get("sha256") instanceof String) || !(count instanceof Number) || ((Number) count).doubleValue() != size
                    || size < 0 || size > MAX_BYTES || !id.matches("[A-Za-z0-9_-]{1,100}")
                    || name.isEmpty() || name.equals(".") || name.equals("..") || name.matches("(?s).*[\\\\/\\x00\\r\\n].*")
                    || name.getBytes(StandardCharsets.UTF_8).length > 255 || !hash.matches("[a-fA-F0-9]{64}")) throw new IOException("Invalid file metadata");
                return new Metadata(id, name, size, hash.toLowerCase(java.util.Locale.ROOT));
            } catch (Exception error) { throw new IOException("Invalid file metadata", error); }
        }
    }

    private final Metadata metadata;
    private final OutputStream output;
    private final MessageDigest hash;
    private long received;
    private int nextIndex;
    private String previousChunk;
    private boolean closed;
    private boolean complete;

    FileExportSession(Metadata metadata, OutputStream output) throws IOException {
        if (metadata == null || output == null) throw new IOException("Invalid file destination");
        this.metadata = metadata; this.output = output;
        try { this.hash = MessageDigest.getInstance("SHA-256"); }
        catch (Exception error) { throw new IOException("Checksum unavailable", error); }
    }

    static FileExportSession open(ContentResolver resolver, Uri uri, Metadata metadata) throws IOException {
        if (metadata == null || uri == null || !"content".equals(uri.getScheme())) throw new IOException("Invalid file destination");
        OutputStream output = resolver.openOutputStream(uri, "wt");
        if (output == null) throw new IOException("Document provider did not open the file");
        try { return new FileExportSession(metadata, output); }
        catch (IOException error) { output.close(); throw error; }
    }

    synchronized long writeChunk(int index, String encoded) throws IOException {
        if (closed) throw new IOException("File export closed");
        if (encoded == null || encoded.length() > 43692 || !encoded.matches("[A-Za-z0-9+/]*={0,2}")) throw new IOException("Invalid file chunk");
        if (index == nextIndex - 1 && encoded.equals(previousChunk)) return received;
        if (index != nextIndex) throw new IOException("File chunk out of order");
        final byte[] bytes;
        try { bytes = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException error) { throw new IOException("Invalid file chunk", error); }
        int expected = (int) Math.min(CHUNK_BYTES, metadata.totalBytes - received);
        if (bytes.length != expected || (expected == 0 && (metadata.totalBytes != 0 || nextIndex != 0))) throw new IOException("Invalid file chunk size");
        try { output.write(bytes); }
        catch (IOException error) { closeAfterFailure(); throw error; }
        hash.update(bytes); received += bytes.length; nextIndex++; previousChunk = encoded;
        return received;
    }

    synchronized void finish() throws IOException {
        if (closed) throw new IOException("File export closed");
        try {
            if (received != metadata.totalBytes || !hex(hash.digest()).equals(metadata.sha256)) throw new IOException("File verification failed");
            output.flush();
            close();
            complete = true;
        } catch (IOException error) { closeAfterFailure(); throw error; }
    }
    synchronized boolean isComplete() { return complete; }
    // Called by the export port's worker only after the user chooses a destination.
    synchronized String acceptMessage(String message) throws IOException {
        try {
            if (message == null || message.length() > 45000) throw new IOException("Invalid export message");
            JSONObject value = new JSONObject(message);
            if (!(value.get("id") instanceof String) || !metadata.id.equals(value.getString("id"))
                || !(value.get("type") instanceof String)) throw new IOException("Invalid export identity");
            String type = value.getString("type");
            JSONObject reply = new JSONObject().put("id", metadata.id);
            if ("cancel".equals(type) && value.length() == 2) {
                close();
                return reply.put("type", "cancelled").toString();
            }
            if ("chunk".equals(type)) {
                Object index = value.get("index");
                if (value.length() != 4 || !(index instanceof Number)
                    || ((Number) index).doubleValue() != value.getInt("index") || value.getInt("index") < 0
                    || !(value.get("data") instanceof String)) throw new IOException("Invalid export chunk");
                long bytes = writeChunk(value.getInt("index"), value.getString("data"));
                return reply.put("type", "ack").put("index", value.getInt("index")).put("receivedBytes", bytes).toString();
            }
            if ("finish".equals(type) && value.length() == 2) {
                finish();
                return reply.put("type", "saved").put("receivedBytes", received).toString();
            }
            throw new IOException("Invalid export operation");
        } catch (org.json.JSONException error) { throw new IOException("Invalid export message", error); }
    }
    @Override public synchronized void close() throws IOException {
        if (closed) return;
        closed = true; output.close();
    }
    private void closeAfterFailure() { try { close(); } catch (IOException ignored) { } }
    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return text.toString();
    }
}
