package com.wonremote.agent;

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

import com.google.firebase.firestore.ListenerRegistration;

public final class AgentService extends Service {
    private static final String CHANNEL_ID = "wonremote-agent";
    private static final String ACTION_PROJECTION = "com.wonremote.agent.PROJECTION";
    private static final String EXTRA_RESULT_CODE = "result_code";
    private static final String EXTRA_RESULT_DATA = "result_data";
    private static final int NOTIFICATION_ID = 177;
    private static final long HEARTBEAT_MS = 20_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private AgentRepository repository;
    private ScreenFrameStreamer streamer;
    private RemoteSessionController remoteSession;
    private ListenerRegistration commandListener;
    private String pendingSessionId;

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

    @Override
    public void onCreate() {
        super.onCreate();
        repository = new AgentRepository(this);
        streamer = new ScreenFrameStreamer(this);
        createNotificationChannel();
        Notification notification = notification("연결 준비 중");
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        heartbeat.run();
    }

    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            repository.heartbeat().addOnCompleteListener(task -> {
                updateNotification(task.isSuccessful() ? "온라인" : "연결 재시도 중");
                if (task.isSuccessful() && commandListener == null) {
                    commandListener = repository.listenForCommands(
                        AgentService.this::handleCommand,
                        error -> {
                            stopCommandListener();
                            updateNotification("명령 채널 재연결 중");
                        }
                    );
                }
                handler.postDelayed(this, task.isSuccessful() ? HEARTBEAT_MS : 10_000);
            });
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_PROJECTION.equals(intent.getAction())) {
            acceptProjection(intent);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(heartbeat);
        stopCommandListener();
        if (remoteSession != null) {
            remoteSession.close();
            remoteSession = null;
        }
        streamer.stop();
        repository.markOffline();
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
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification notification(String status) {
        PendingIntent open = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("WonRemote Agent")
            .setContentText(status)
            .setContentIntent(open)
            .setOngoing(true)
            .build();
    }

    private void updateNotification(String status) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(status));
    }

    private void acceptProjection(Intent intent) {
        Intent resultData = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class)
            : intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (resultData == null) {
            updateNotification("화면 공유 권한 필요");
            return;
        }
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
            updateNotification("화면 공유 권한 필요");
            return;
        }
        streamer.start(projection);
        updateNotification("온라인 · 화면 공유 준비됨");
        if (pendingSessionId != null) {
            remoteController().start(pendingSessionId);
        }
    }

    private void handleCommand(String action) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post(() -> handleCommand(action));
            return;
        }
        if (action.startsWith("start-stream ")) {
            String sessionId = action.substring("start-stream ".length()).trim();
            if (!sessionId.isEmpty()) {
                pendingSessionId = sessionId;
                remoteController().start(sessionId);
                updateNotification(streamer.isReady() ? "원격 세션 연결 중" : "화면 공유 권한 필요");
            }
            return;
        }
        if (action.startsWith("stop-stream")) {
            pendingSessionId = null;
            if (remoteSession != null) {
                remoteSession.stopSession();
            }
            updateNotification("온라인");
            return;
        }
        WonRemoteAccessibilityService.execute(action);
    }

    private RemoteSessionController remoteController() {
        if (remoteSession == null) {
            remoteSession = new RemoteSessionController(
                this,
                streamer,
                this::handleCommand,
                () -> {
                    pendingSessionId = null;
                    updateNotification("온라인");
                }
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
}
