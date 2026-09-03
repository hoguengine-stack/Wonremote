package com.wonremote.agent;

import android.content.Context;
import android.graphics.Bitmap;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.DataChannel;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.Consumer;

final class ScreenFrameStreamer {
    private static final int TILE_SIZE = 128;
    private static final int MAX_CAPTURE_DIMENSION = 1280;
    private static final int MAX_MESSAGE_BYTES = 52 * 1024;
    private static final long MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
    private static final long FRAME_INTERVAL_MS = 100;
    private static final long KEYFRAME_INTERVAL_MS = 5_000;

    private final Context context;
    private final HandlerThread captureThread = new HandlerThread("wonremote-capture");
    private final Object channelLock = new Object();
    private final Consumer<Boolean> readinessListener;

    private Handler captureHandler;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private Bitmap paddedBitmap;
    private int[] pixels;
    private long[] tileHashes;
    private DataChannel channel;
    private boolean needsKeyframe = true;
    private long lastFrameAt;
    private long lastKeyframeAt;
    private int sequence;

    ScreenFrameStreamer(Context context, Consumer<Boolean> readinessListener) {
        this.context = context.getApplicationContext();
        this.readinessListener = readinessListener;
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
    }

    void start(MediaProjection mediaProjection) {
        releaseProjection(true);
        projection = mediaProjection;
        MediaProjection acceptedProjection = mediaProjection;
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                captureHandler.post(() -> {
                    if (projection == acceptedProjection) {
                        releaseProjection(false);
                    }
                });
            }
        }, captureHandler);

        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        int sourceWidth = Math.max(1, metrics.widthPixels);
        int sourceHeight = Math.max(1, metrics.heightPixels);
        double scale = Math.min(1.0, MAX_CAPTURE_DIMENSION / (double) Math.max(sourceWidth, sourceHeight));
        int width = Math.max(32, (int) Math.round(sourceWidth * scale));
        int height = Math.max(32, (int) Math.round(sourceHeight * scale));

        imageReader = ImageReader.newInstance(width, height, android.graphics.PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(this::onImageAvailable, captureHandler);
        virtualDisplay = projection.createVirtualDisplay(
            "WonRemote Android",
            width,
            height,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            captureHandler
        );
        needsKeyframe = true;
        readinessListener.accept(isReady());
    }

    boolean isReady() {
        return projection != null && virtualDisplay != null;
    }

    void setChannel(DataChannel dataChannel) {
        synchronized (channelLock) {
            channel = dataChannel;
            needsKeyframe = true;
        }
    }

    void stop() {
        stopProjection();
        captureThread.quitSafely();
    }

    void stopProjection() {
        setChannel(null);
        releaseProjection(true);
    }

    private void onImageAvailable(ImageReader reader) {
        try (Image image = reader.acquireLatestImage()) {
            synchronized (channelLock) {
                DataChannel target = channel;
                long now = android.os.SystemClock.elapsedRealtime();
                if (image == null || target == null || target.state() != DataChannel.State.OPEN
                    || now - lastFrameAt < FRAME_INTERVAL_MS) {
                    return;
                }
                lastFrameAt = now;
                sendImage(image, target, now);
            }
        } catch (RuntimeException ignored) {
            needsKeyframe = true;
        }
    }

    private void sendImage(Image image, DataChannel target, long now) {
        Image.Plane plane = image.getPlanes()[0];
        int width = image.getWidth();
        int height = image.getHeight();
        int paddedWidth = plane.getRowStride() / plane.getPixelStride();
        if (paddedBitmap == null || paddedBitmap.getWidth() != paddedWidth || paddedBitmap.getHeight() != height) {
            recycleBitmap();
            paddedBitmap = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
            pixels = new int[width * height];
            int cols = (width + TILE_SIZE - 1) / TILE_SIZE;
            int rows = (height + TILE_SIZE - 1) / TILE_SIZE;
            tileHashes = new long[cols * rows];
            Arrays.fill(tileHashes, Long.MIN_VALUE);
            needsKeyframe = true;
        }

        ByteBuffer buffer = plane.getBuffer();
        buffer.rewind();
        paddedBitmap.copyPixelsFromBuffer(buffer);
        paddedBitmap.getPixels(pixels, 0, width, 0, 0, width, height);

        boolean keyframe = needsKeyframe || now - lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
        List<JSONObject> tiles = new ArrayList<>();
        long[] nextHashes = tileHashes.clone();
        int cols = (width + TILE_SIZE - 1) / TILE_SIZE;
        int rows = (height + TILE_SIZE - 1) / TILE_SIZE;
        for (int row = 0; row < rows; row++) {
            for (int col = 0; col < cols; col++) {
                int left = col * TILE_SIZE;
                int top = row * TILE_SIZE;
                int tileWidth = Math.min(TILE_SIZE, width - left);
                int tileHeight = Math.min(TILE_SIZE, height - top);
                int tileIndex = row * cols + col;
                long hash = tileHash(left, top, tileWidth, tileHeight, width);
                nextHashes[tileIndex] = hash;
                if (keyframe || tileHashes[tileIndex] != hash) {
                    tiles.add(encodeTile(left, top, tileWidth, tileHeight, width));
                }
            }
        }
        if (tiles.isEmpty() || target.bufferedAmount() >= MAX_BUFFERED_BYTES) {
            return;
        }

        int frameSequence = sequence + 1;
        List<byte[]> payloads = framePayloads(tiles, width, height, frameSequence, keyframe);
        long totalBytes = payloads.stream().mapToLong(payload -> payload.length).sum();
        if (target.bufferedAmount() + totalBytes > MAX_BUFFERED_BYTES) {
            return;
        }
        for (byte[] payload : payloads) {
            if (!target.send(new DataChannel.Buffer(ByteBuffer.wrap(payload), false))) {
                needsKeyframe = true;
                return;
            }
        }
        sequence = frameSequence;
        tileHashes = nextHashes;
        needsKeyframe = false;
        if (keyframe) {
            lastKeyframeAt = now;
        }
    }

    private JSONObject encodeTile(int left, int top, int width, int height, int frameWidth) {
        Bitmap tile = Bitmap.createBitmap(pixels, top * frameWidth + left, frameWidth, width, height, Bitmap.Config.ARGB_8888);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        tile.compress(Bitmap.CompressFormat.JPEG, 55, output);
        tile.recycle();
        try {
            return new JSONObject()
                .put("x", left / 32)
                .put("y", top / 32)
                .put("w", width)
                .put("h", height)
                .put("data", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
        } catch (JSONException error) {
            throw new IllegalStateException(error);
        }
    }

    private List<byte[]> framePayloads(
        List<JSONObject> tiles,
        int width,
        int height,
        int frameSequence,
        boolean keyframe
    ) {
        List<List<JSONObject>> chunks = new ArrayList<>();
        List<JSONObject> current = new ArrayList<>();
        int currentBytes = 256;
        for (JSONObject tile : tiles) {
            int tileBytes = tile.toString().getBytes(StandardCharsets.UTF_8).length + 1;
            if (!current.isEmpty() && currentBytes + tileBytes > MAX_MESSAGE_BYTES) {
                chunks.add(current);
                current = new ArrayList<>();
                currentBytes = 256;
            }
            if (tileBytes + 256 > MAX_MESSAGE_BYTES) {
                throw new IllegalStateException("Encoded screen tile is too large.");
            }
            current.add(tile);
            currentBytes += tileBytes;
        }
        if (!current.isEmpty()) {
            chunks.add(current);
        }

        List<byte[]> payloads = new ArrayList<>();
        for (int index = 0; index < chunks.size(); index++) {
            try {
                JSONObject frame = new JSONObject()
                    .put("tiles", new JSONArray(chunks.get(index)))
                    .put("width", width)
                    .put("height", height)
                    .put("sequence", frameSequence)
                    .put("keyframe", keyframe)
                    .put("frameChunkIndex", index)
                    .put("frameChunkCount", chunks.size());
                byte[] payload = frame.toString().getBytes(StandardCharsets.UTF_8);
                if (payload.length > MAX_MESSAGE_BYTES) {
                    throw new IllegalStateException("Encoded frame chunk is too large.");
                }
                payloads.add(payload);
            } catch (JSONException error) {
                throw new IllegalStateException(error);
            }
        }
        return payloads;
    }

    private long tileHash(int left, int top, int width, int height, int frameWidth) {
        long hash = 0xcbf29ce484222325L;
        for (int y = 0; y < height; y++) {
            int offset = (top + y) * frameWidth + left;
            for (int x = 0; x < width; x++) {
                hash ^= pixels[offset + x];
                hash *= 0x100000001b3L;
            }
        }
        return hash;
    }

    private void releaseProjection(boolean stopProjection) {
        boolean wasReady = isReady();
        MediaProjection currentProjection = projection;
        projection = null;
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.close();
            imageReader = null;
        }
        if (stopProjection && currentProjection != null) {
            currentProjection.stop();
        }
        recycleBitmap();
        pixels = null;
        tileHashes = null;
        needsKeyframe = true;
        if (wasReady) {
            readinessListener.accept(false);
        }
    }

    private void recycleBitmap() {
        if (paddedBitmap != null) {
            paddedBitmap.recycle();
            paddedBitmap = null;
        }
    }
}
