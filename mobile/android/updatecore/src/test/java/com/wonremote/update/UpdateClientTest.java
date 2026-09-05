package com.wonremote.update;

import org.junit.Test;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.*;
import static org.junit.Assert.*;

public class UpdateClientTest {
    private static final String ID = "com.wonremote.agent";
    private byte[] manifest(String id, long code, byte[] zip, byte[] apk) throws Exception {
        JSONObject release = new JSONObject()
            .put("versionName", "0.1.80").put("versionCode", code)
            .put("url", "https://wonremote-a7fd3.web.app/download/android/v0.1.80/agent.zip")
            .put("apkSize", apk.length).put("zipSize", zip.length)
            .put("apkSha256", UpdateClient.sha256(apk)).put("zipSha256", UpdateClient.sha256(zip));
        return new JSONObject().put("schemaVersion", 1)
            .put("apps", new JSONObject().put(id, release)).toString().getBytes(StandardCharsets.UTF_8);
    }
    private byte[] zip(byte[] apk, String name) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream output = new ZipOutputStream(bytes)) {
            output.putNextEntry(new ZipEntry(name));
            output.write(apk); output.closeEntry();
        }
        return bytes.toByteArray();
    }
    @Test public void threeProductsDetect79To80AndDownloadVerifiedBytes() throws Exception {
        for (String id : new String[]{ID, "com.wonremote.viewer", "com.wonremote.controladdon"}) {
            byte[] apk = "signed-apk-fixture".getBytes(StandardCharsets.UTF_8);
            byte[] zip = zip(apk, "WonRemote-Agent.apk");
            byte[] metadata = manifest(id, 1080, zip, apk);
            AtomicInteger reads = new AtomicInteger();
            try (UpdateClient client = new UpdateClient(id, 1079, url -> {
                reads.incrementAndGet();
                return new ByteArrayInputStream(url.equals(UpdateClient.MANIFEST) ? metadata : zip);
            })) {
                UpdateClient.Release release = client.check(false);
                assertNotNull(release); assertEquals(1080, release.versionCode);
                // A whole day of resume/idle events performs no more startup reads.
                for (int second = 0; second < 86400; second++) assertNull(client.check(false));
                assertEquals(1, reads.get());
                assertNotNull(client.check(true)); // explicit manual refresh
                File target = Files.createTempFile("wonremote-update", ".apk").toFile();
                try { client.download(release, target); assertArrayEquals(apk, Files.readAllBytes(target.toPath())); }
                finally { target.delete(); }
                assertEquals(3, reads.get());
            }
        }
    }
    @Test public void currentOrOlderReleaseNeverDownloads() throws Exception {
        byte[] content = {1};
        AtomicInteger reads = new AtomicInteger();
        try (UpdateClient client = new UpdateClient(ID, 1080, url -> {
            reads.incrementAndGet(); return new ByteArrayInputStream(manifest(ID, 1080, content, content));
        })) {
            assertNull(client.check(false)); assertEquals(1, reads.get());
        }
    }
    @Test public void quotaOrNetworkFailureNeverRetriesWithoutUserAction() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        try (UpdateClient client = new UpdateClient(ID, 1079, url -> {
            reads.incrementAndGet(); throw new IOException("HTTP 429");
        })) {
            assertThrows(IOException.class, () -> client.check(false));
            for (int i = 0; i < 86400; i++) assertNull(client.check(false));
            assertEquals(1, reads.get());
            assertThrows(IOException.class, () -> client.check(true));
            assertEquals(2, reads.get());
        }
    }
    @Test public void slowConcurrentChecksUseOneRequestAndClosedClientCannotRestart() throws Exception {
        CountDownLatch opened = new CountDownLatch(1), unblock = new CountDownLatch(1);
        AtomicInteger reads = new AtomicInteger();
        UpdateClient client = new UpdateClient(ID, 1079, url -> {
            reads.incrementAndGet(); opened.countDown(); unblock.await(5, TimeUnit.SECONDS);
            return new ByteArrayInputStream(manifest(ID, 1080, new byte[]{1}, new byte[]{1}));
        });
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<?> result = executor.submit(() -> {
                try { client.check(false); fail("closed check must be cancelled"); } catch (Exception expected) { }
            });
            assertTrue(opened.await(5, TimeUnit.SECONDS));
            assertNull(client.check(true)); assertNull(client.check(false));
            client.close(); unblock.countDown(); result.get(5, TimeUnit.SECONDS);
            assertNull(client.check(true)); assertEquals(1, reads.get());
        } finally { unblock.countDown(); client.close(); executor.shutdownNow(); }
    }
    @Test public void corruptZipAndTraversalNeverLeaveInstallableFile() throws Exception {
        byte[] apk = {1, 2, 3};
        for (boolean traversal : new boolean[]{false, true}) {
            byte[] archive = zip(apk, traversal ? "../evil.apk" : "WonRemote-Agent.apk");
            byte[] data = manifest(ID, 1080, archive, apk);
            UpdateClient client = new UpdateClient(ID, 1079, url ->
                new ByteArrayInputStream(url.equals(UpdateClient.MANIFEST) ? data :
                    traversal ? archive : new byte[archive.length]));
            File file = Files.createTempFile("wonremote-corrupt", ".apk").toFile();
            try {
                UpdateClient.Release release = client.check(false);
                assertThrows(IOException.class, () -> client.download(release, file));
                assertFalse(file.exists());
            } finally { client.close(); file.delete(); }
        }
    }
    @Test public void rejectsWrongPackageOrUntrustedDownloadHost() throws Exception {
        byte[] data = manifest(ID, 1080, new byte[]{1}, new byte[]{1});
        try (UpdateClient client = new UpdateClient("com.wonremote.viewer", 1079, url -> new ByteArrayInputStream(data))) {
            assertThrows(Exception.class, () -> client.check(false));
        }
        String foreign = new String(data, StandardCharsets.UTF_8).replace("wonremote-a7fd3.web.app", "untrusted.example");
        try (UpdateClient client = new UpdateClient(ID, 1079, url -> new ByteArrayInputStream(foreign.getBytes(StandardCharsets.UTF_8)))) {
            assertThrows(IOException.class, () -> client.check(false));
        }
    }
}
