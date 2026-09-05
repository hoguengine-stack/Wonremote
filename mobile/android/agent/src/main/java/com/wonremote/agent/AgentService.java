package com.wonremote.agent;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import com.google.firebase.firestore.ListenerRegistration;

public final class AgentService extends Service {
    private static final String CHANNEL_ID = "wonremote-agent";
    private static final String REQUEST_CHANNEL_ID = "wonremote-screen-share-request";
    private static final String ACTION_PROJECTION = "com.wonremote.agent.PROJECTION";
    private static final String ACTION_STOP_PROJECTION = "com.wonremote.agent.STOP_PROJECTION";
    private static final String ACTION_CANCEL_PROJECTION_REQUEST = "com.wonremote.agent.CANCEL_PROJECTION_REQUEST";
    private static final String ACTION_STOP_AGENT = "com.wonremote.agent.STOP_AGENT";
    private static final String EXTRA_RESULT_CODE = "result_code";
    private static final String EXTRA_RESULT_DATA = "result_data";
    private static final int NOTIFICATION_ID = 177;
    private static final int REQUEST_NOTIFICATION_ID = 178;
    private static final long APPROVAL_TIMEOUT_MS = 60_000;
    private static volatile boolean projectionReady;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private AgentRepository repository;
    private ScreenFrameStreamer streamer;
    private RemoteSessionController remoteSession;
    private ListenerRegistration commandListener;
    private String pendingSessionId;
    private PowerManager.WakeLock sessionWakeLock;
    private boolean shuttingDown;
    private long quotaRetryAtMs;
    private final Runnable projectionRequestTimeout = () -> cancelProjectionRequest("화면 공유 요청 만료");

    static void start(Context context) {
        Intent intent = new Intent(context, AgentService.class);
        context.startForegroundService(intent);
    }

    static void setProjection(Context context, int resultCode, Intent resultData) {
        Intent intent = new Intent(context, AgentService.class)
            .setAction(ACTION_PROJECTION)
            .putExtra(EXTRA_RESULT_CODE, resultCode)
            .putExtra(EXTRA_RESULT_DATA, resultData);
        context.startForegroundService(intent);
    }

    static void stopProjection(Context context) {
        projectionReady = false;
        context.startForegroundService(
            new Intent(context, AgentService.class).setAction(ACTION_STOP_PROJECTION)
        );
    }

    static void cancelProjectionRequest(Context context) {
        context.startService(
            new Intent(context, AgentService.class).setAction(ACTION_CANCEL_PROJECTION_REQUEST)
        );
    }

    static void stop(Context context) {
        context.startService(new Intent(context, AgentService.class).setAction(ACTION_STOP_AGENT));
    }

    static boolean isProjectionReady() {
        return projectionReady;
    }

    static boolean shouldPromptForProjection(boolean ready, String sessionId, String pendingId) {
        return !ready && sessionId != null && !sessionId.trim().isEmpty()
            && !sessionId.equals(pendingId);
    }

    static boolean shouldStopRemoteSession(String action, String activeSessionId) {
        String prefix = "stop-stream ";
        return action != null && action.startsWith(prefix) && activeSessionId != null
            && activeSessionId.equals(action.substring(prefix.length()).trim());
    }

    @Override
    public void onCreate() {
        super.onCreate();
        repository = new AgentRepository(this);
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        sessionWakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            getPackageName() + ":remote-session"
        );
        sessionWakeLock.setReferenceCounted(false);
        streamer = new ScreenFrameStreamer(this, ready -> {
            projectionReady = ready;
            handler.post(() -> updateNotification(ready ? "온라인 · 화면 공유 준비됨" : "온라인"));
        });
        createNotificationChannel();
        Notification notification = notification("연결 준비 중");
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        repository.heartbeat().addOnCompleteListener(task -> {
            if (FirebaseQuota.exhausted(task.getException())) deferQuotaRetry(task.getException());
            connectCommands.run();
        });
    }

    private final Runnable connectCommands = new Runnable() {
        @Override
        public void run() {
            if (shuttingDown || commandListener != null) {
                return;
            }
            long quotaWaitMs = quotaRetryAtMs - SystemClock.elapsedRealtime();
            if (quotaWaitMs > 0) {
                handler.postDelayed(this, quotaWaitMs);
                return;
            }
            repository.connect().addOnCompleteListener(task -> {
                if (shuttingDown) {
                    return;
                }
                if (FirebaseQuota.exhausted(task.getException())) {
                    deferQuotaRetry(task.getException());
                } else {
                    updateNotification(task.isSuccessful() ? "온라인" : "연결 재시도 중");
                }
                if (task.isSuccessful()) {
                    if (commandListener == null) {
                        commandListener = repository.listenForCommands(
                            AgentService.this::handleCommand,
                            error -> {
                                stopCommandListener();
                                if (FirebaseQuota.exhausted(error)) {
                                    deferQuotaRetry(error);
                                } else {
                                    updateNotification("명령 채널 재연결 중");
                                }
                                handler.removeCallbacks(connectCommands);
                                handler.postDelayed(connectCommands, FirebaseQuota.retryDelayMs(error));
                            }
                        );
                    }
                }
                if (!task.isSuccessful()) handler.postDelayed(this, FirebaseQuota.retryDelayMs(task.getException()));
            });
        }
    };

    private void deferQuotaRetry(Throwable error) {
        quotaRetryAtMs = SystemClock.elapsedRealtime() + FirebaseQuota.retryDelayMs(error);
        updateNotification("서버 사용량 한도 초과 · 5분 후 재시도");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP_AGENT.equals(intent.getAction())) {
            stopAgent();
            return START_NOT_STICKY;
        } else if (intent != null && ACTION_PROJECTION.equals(intent.getAction())) {
            acceptProjection(intent);
        } else if (intent != null && ACTION_STOP_PROJECTION.equals(intent.getAction())) {
            stopProjection();
        } else if (intent != null && ACTION_CANCEL_PROJECTION_REQUEST.equals(intent.getAction())) {
            cancelProjectionRequest("화면 공유 요청 거절됨");
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        shuttingDown = true;
        handler.removeCallbacksAndMessages(null);
        stopCommandListener();
        if (remoteSession != null) {
            remoteSession.close();
            remoteSession = null;
        }
        streamer.stop();
        releaseSessionWakeLock();
        projectionReady = false;
        repository.markOffline();
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.cancel(NOTIFICATION_ID);
        notifications.cancel(REQUEST_NOTIFICATION_ID);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "WonRemote Agent",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("원격 연결 대기 상태");
        NotificationChannel requestChannel = new NotificationChannel(
            REQUEST_CHANNEL_ID,
            "원격 화면 공유 요청",
            NotificationManager.IMPORTANCE_HIGH
        );
        requestChannel.setDescription("Viewer 연결 요청 승인");
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(channel);
        notifications.createNotificationChannel(requestChannel);
    }

    private Intent projectionApprovalActivityIntent() {
        return new Intent(this, MainActivity.class)
            .setAction(MainActivity.ACTION_REQUEST_SCREEN_SHARE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    private PendingIntent projectionApprovalIntent() {
        return PendingIntent.getActivity(
            this,
            3,
            projectionApprovalActivityIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private PendingIntent projectionCancelIntent() {
        return PendingIntent.getService(
            this,
            4,
            new Intent(this, AgentService.class).setAction(ACTION_CANCEL_PROJECTION_REQUEST),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void showProjectionRequest() {
        PendingIntent approve = projectionApprovalIntent();
        PendingIntent cancel = projectionCancelIntent();
        Notification notification = new Notification.Builder(this, REQUEST_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("원격 화면 공유 요청")
            .setContentText("승인하려면 눌러 전체 화면 공유를 시작하세요.")
            .setContentIntent(approve)
            .setDeleteIntent(cancel)
            .setCategory(Notification.CATEGORY_EVENT)
            .setPriority(Notification.PRIORITY_HIGH)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setTimeoutAfter(APPROVAL_TIMEOUT_MS)
            .addAction(android.R.drawable.ic_menu_view, "승인", approve)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "거절", cancel)
            .build();
        getSystemService(NotificationManager.class).notify(REQUEST_NOTIFICATION_ID, notification);
        handler.removeCallbacks(projectionRequestTimeout);
        handler.postDelayed(projectionRequestTimeout, APPROVAL_TIMEOUT_MS);
        if (MainActivity.isVisible()) {
            startActivity(projectionApprovalActivityIntent());
        } else if (!WonRemoteAccessibilityService.requestScreenShareConsent()) {
            ControlAddonClient.requestScreenShareConsent(this);
        }
    }

    private Notification notification(String status) {
        PendingIntent open = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("WonRemote Agent")
            .setContentText(status)
            .setContentIntent(open)
            .setOngoing(true);
        if (projectionReady) {
            PendingIntent stop = PendingIntent.getService(
                this,
                1,
                new Intent(this, AgentService.class).setAction(ACTION_STOP_PROJECTION),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "화면 공유 중지", stop);
        } else if (pendingSessionId != null) {
            builder.addAction(android.R.drawable.ic_menu_view, "화면 공유 승인", projectionApprovalIntent());
        }
        PendingIntent exit = PendingIntent.getService(
            this,
            2,
            new Intent(this, AgentService.class).setAction(ACTION_STOP_AGENT),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        builder.addAction(android.R.drawable.ic_lock_power_off, "앱 종료", exit);
        return builder.build();
    }

    private void updateNotification(String status) {
        if (!shuttingDown) {
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(status));
        }
    }

    private void stopAgent() {
        shuttingDown = true;
        handler.removeCallbacksAndMessages(null);
        pendingSessionId = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.cancel(NOTIFICATION_ID);
        notifications.cancel(REQUEST_NOTIFICATION_ID);
        stopSelf();
    }

    private void acceptProjection(Intent intent) {
        Intent resultData = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class)
            : intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (resultData == null) {
            cancelProjectionRequest("화면 공유 권한 필요");
            return;
        }
        clearProjectionRequest();
        if (Build.VERSION.SDK_INT >= 34) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            startForeground(NOTIFICATION_ID, notification("화면 공유 준비 중"), types);
        }
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        MediaProjection projection = manager.getMediaProjection(
            intent.getIntExtra(EXTRA_RESULT_CODE, android.app.Activity.RESULT_CANCELED),
            resultData
        );
        if (projection == null) {
            cancelProjectionRequest("화면 공유 권한 필요");
            return;
        }
        streamer.start(projection);
        projectionReady = streamer.isReady();
        updateNotification(projectionReady ? "온라인 · 화면 공유 준비됨" : "화면 공유 권한 필요");
        if (pendingSessionId != null) {
            acquireSessionWakeLock();
            remoteController().start(pendingSessionId);
        }
    }

    private void stopProjection() {
        endProjection("온라인");
    }

    private void cancelProjectionRequest(String status) {
        if (streamer.isReady()) {
            clearProjectionRequest();
            updateNotification("온라인 · 화면 공유 준비됨");
            return;
        }
        endProjection(status);
    }

    private void finishRemoteSession() {
        pendingSessionId = null;
        clearProjectionRequest();
        releaseSessionWakeLock();
        updateNotification(streamer.isReady() ? "온라인 · 화면 공유 준비됨" : "온라인");
    }

    private void endProjection(String status) {
        pendingSessionId = null;
        clearProjectionRequest();
        if (remoteSession != null) {
            remoteSession.stopSession();
        }
        streamer.stopProjection();
        releaseSessionWakeLock();
        projectionReady = false;
        updateNotification(status);
    }

    private void clearProjectionRequest() {
        handler.removeCallbacks(projectionRequestTimeout);
        getSystemService(NotificationManager.class).cancel(REQUEST_NOTIFICATION_ID);
    }

    private void handleCommand(String action) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post(() -> handleCommand(action));
            return;
        }
        if (action.startsWith("refresh-status ")) {
            String requestId = action.substring("refresh-status ".length());
            if (requestId.matches("[a-f0-9-]{36}") && SystemClock.elapsedRealtime() >= quotaRetryAtMs) {
                repository.heartbeat(requestId).addOnCompleteListener(task -> {
                    if (FirebaseQuota.exhausted(task.getException())) deferQuotaRetry(task.getException());
                });
            }
            return;
        }
        if (action.startsWith("start-stream ")) {
            String sessionId = action.substring("start-stream ".length()).trim();
            if (!sessionId.isEmpty()) {
                boolean prompt = shouldPromptForProjection(streamer.isReady(), sessionId, pendingSessionId);
                pendingSessionId = sessionId;
                remoteController().start(sessionId);
                if (streamer.isReady()) {
                    acquireSessionWakeLock();
                    updateNotification("원격 세션 연결 중");
                } else {
                    if (prompt) {
                        showProjectionRequest();
                    }
                    updateNotification("원격 요청 · 화면 공유 승인 필요");
                }
            }
            return;
        }
        if (action.startsWith("stop-stream")) {
            if (shouldStopRemoteSession(action, pendingSessionId)) {
                if (remoteSession != null) {
                    remoteSession.stopSession();
                }
                finishRemoteSession();
            }
            return;
        }
        if ("request-keyframe".equals(action)) {
            streamer.requestKeyframe();
            return;
        }
        if ("key-release-all".equals(action) || "key_release_all".equals(action)) {
            ControlAddonClient.releasePointer(this);
        } else if (!ControlAddonClient.execute(this, action)) {
            WonRemoteAccessibilityService.execute(action);
        }
    }

    private RemoteSessionController remoteController() {
        if (remoteSession == null) {
            remoteSession = new RemoteSessionController(
                this,
                streamer,
                this::handleCommand,
                () -> ControlAddonClient.releasePointer(this),
                this::finishRemoteSession
            );
        }
        return remoteSession;
    }

    private void stopCommandListener() {
        if (commandListener != null) {
            commandListener.remove();
            commandListener = null;
        }
    }

    @SuppressLint("WakelockTimeout")
    private void acquireSessionWakeLock() {
        if (!sessionWakeLock.isHeld()) {
            sessionWakeLock.acquire();
        }
    }

    private void releaseSessionWakeLock() {
        if (sessionWakeLock != null && sessionWakeLock.isHeld()) {
            sessionWakeLock.release();
        }
    }
}
