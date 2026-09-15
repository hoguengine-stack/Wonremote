package com.wonremote.viewer;

import static org.junit.Assert.*;
import android.content.ContentResolver;
import android.net.Uri;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public class FileExportSessionTest {
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder value = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) value.append(String.format("%02x", b & 255));
        return value.toString();
    }
    private static String metadata(byte[] bytes) throws Exception {
        return new JSONObject().put("id", "export-1").put("filename", "report.bin").put("totalBytes", bytes.length).put("sha256", hash(bytes)).toString();
    }
    private static String encoded(byte[] bytes) { return Base64.encodeToString(bytes, Base64.NO_WRAP); }

    @Test public void streamsToSelectedContentUriAndIgnoresLastChunkDuplicate() throws Exception {
        byte[] bytes = new byte[40000]; Arrays.fill(bytes, (byte) 71);
        ContentResolver resolver = RuntimeEnvironment.getApplication().getContentResolver();
        Uri uri = Uri.parse("content://test/export/report");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Shadows.shadowOf(resolver).registerOutputStream(uri, output);
        FileExportSession session = FileExportSession.open(resolver, uri, FileExportSession.Metadata.parse(metadata(bytes)));
        String first = encoded(Arrays.copyOfRange(bytes, 0, 32768));
        assertEquals(32768, session.writeChunk(0, first));
        assertEquals(32768, session.writeChunk(0, first));
        assertEquals(40000, session.writeChunk(1, encoded(Arrays.copyOfRange(bytes, 32768, bytes.length))));
        assertFalse(session.isComplete());
        session.finish();
        assertTrue(session.isComplete()); assertArrayEquals(bytes, output.toByteArray());
        session.close();
        assertThrows(IOException.class, () -> session.writeChunk(2, ""));
    }
    @Test public void rejectsInvalidMetadataAndNonContentDestination() throws Exception {
        String valid = metadata(new byte[0]);
        for (Object name : new Object[]{"../a", "C:\\a", "a\nb", "", "..", 42}) {
            String bad = new JSONObject(valid).put("filename", name).toString();
            assertThrows(IOException.class, () -> FileExportSession.Metadata.parse(bad));
        }
        for (Object size : new Object[]{-1, FileExportSession.MAX_BYTES + 1, 1.5, "0"}) {
            String bad = new JSONObject(valid).put("totalBytes", size).toString();
            assertThrows(IOException.class, () -> FileExportSession.Metadata.parse(bad));
        }
        assertThrows(IOException.class, () -> FileExportSession.open(RuntimeEnvironment.getApplication().getContentResolver(), Uri.parse("file:///private"), FileExportSession.Metadata.parse(valid)));
    }
    @Test public void rejectsOutOfOrderOversizedAndInvalidChunks() throws Exception {
        byte[] bytes = new byte[2];
        FileExportSession session = new FileExportSession(FileExportSession.Metadata.parse(metadata(bytes)), new ByteArrayOutputStream());
        assertThrows(IOException.class, () -> session.writeChunk(1, encoded(bytes)));
        assertThrows(IOException.class, () -> session.writeChunk(0, "bad!"));
        assertThrows(IOException.class, () -> session.writeChunk(0, "A".repeat(43693)));
        assertThrows(IOException.class, () -> session.writeChunk(0, encoded(new byte[1])));
        session.writeChunk(0, encoded(bytes)); session.finish(); assertTrue(session.isComplete());
    }
    @Test public void rejectsIncompleteOrCorruptedOutputAndSupportsEmptyFiles() throws Exception {
        byte[] bytes = new byte[]{1, 2};
        FileExportSession incomplete = new FileExportSession(FileExportSession.Metadata.parse(metadata(bytes)), new ByteArrayOutputStream());
        assertThrows(IOException.class, incomplete::finish); assertFalse(incomplete.isComplete());
        FileExportSession corrupt = new FileExportSession(FileExportSession.Metadata.parse(metadata(bytes)), new ByteArrayOutputStream());
        corrupt.writeChunk(0, encoded(new byte[]{3, 4}));
        assertThrows(IOException.class, corrupt::finish); assertFalse(corrupt.isComplete());
        FileExportSession empty = new FileExportSession(FileExportSession.Metadata.parse(metadata(new byte[0])), new ByteArrayOutputStream());
        empty.finish(); assertTrue(empty.isComplete());
    }
    @Test public void writeOrCloseFailureCannotBeReportedAsSuccess() throws Exception {
        FileExportSession.Metadata info = FileExportSession.Metadata.parse(metadata(new byte[]{1}));
        OutputStream failingWrite = new OutputStream() { @Override public void write(int value) throws IOException { throw new IOException("full"); } };
        FileExportSession first = new FileExportSession(info, failingWrite);
        assertThrows(IOException.class, () -> first.writeChunk(0, encoded(new byte[]{1}))); assertFalse(first.isComplete());
        OutputStream failingClose = new ByteArrayOutputStream() { @Override public void close() throws IOException { throw new IOException("close failed"); } };
        FileExportSession second = new FileExportSession(info, failingClose);
        second.writeChunk(0, encoded(new byte[]{1}));
        assertThrows(IOException.class, second::finish); assertFalse(second.isComplete());
    }
    @Test public void messageProtocolBindsIdentityAndAcknowledgesOnlySuccessfulOutput() throws Exception {
        byte[] bytes = new byte[]{1, 2};
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        FileExportSession session = new FileExportSession(FileExportSession.Metadata.parse(metadata(bytes)), output);
        JSONObject chunk = new JSONObject().put("type", "chunk").put("id", "export-1").put("index", 0).put("data", encoded(bytes));
        String valid = chunk.toString();
        for (String bad : new String[]{"null", "{}", "x".repeat(45001),
            new JSONObject(valid).put("id", "another-file").toString(),
            new JSONObject(valid).put("index", 0.5).toString(),
            new JSONObject(valid).put("index", "0").toString(),
            new JSONObject(valid).put("index", -1).toString(),
            new JSONObject(valid).put("path", "/private").toString(),
            new JSONObject(valid).put("data", 12).toString()}) {
            assertThrows(IOException.class, () -> session.acceptMessage(bad));
            assertEquals(0, output.size());
        }
        JSONObject ack = new JSONObject(session.acceptMessage(valid));
        assertEquals("ack", ack.getString("type")); assertEquals(2, ack.getLong("receivedBytes"));
        assertEquals(ack.toString(), session.acceptMessage(valid));
        assertArrayEquals(bytes, output.toByteArray()); assertFalse(session.isComplete());
        String finish = new JSONObject().put("type", "finish").put("id", "export-1").toString();
        assertEquals("saved", new JSONObject(session.acceptMessage(finish)).getString("type"));
        assertTrue(session.isComplete());
        assertThrows(IOException.class, () -> session.acceptMessage(valid));
    }
    @Test public void messageProtocolNeverAcknowledgesCloseFailureAsSaved() throws Exception {
        OutputStream output = new ByteArrayOutputStream() {
            @Override public void close() throws IOException { throw new IOException("Provider failed"); }
        };
        FileExportSession session = new FileExportSession(FileExportSession.Metadata.parse(metadata(new byte[0])), output);
        assertThrows(IOException.class, () -> session.acceptMessage("{\"type\":\"finish\",\"id\":\"export-1\"}"));
        assertFalse(session.isComplete());
    }
}
