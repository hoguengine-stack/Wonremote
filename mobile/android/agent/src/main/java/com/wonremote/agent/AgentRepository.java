package com.wonremote.agent;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.auth.AuthResult;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthUserCollisionException;
import com.google.firebase.firestore.DocumentReference;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.ListenerRegistration;
import com.google.firebase.firestore.Query;
import com.google.firebase.firestore.SetOptions;
import com.google.firebase.firestore.WriteBatch;

import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

final class AgentRepository {
    private static final int PROTOCOL_VERSION = 2;

    private final Context context;
    private final AgentStore store;
    private final FirebaseAuth auth = FirebaseAuth.getInstance();
    private final FirebaseFirestore firestore = FirebaseFirestore.getInstance();

    AgentRepository(Context context) {
        this.context = context.getApplicationContext();
        this.store = new AgentStore(context);
    }

    Task<String> register(String businessNumber, String password) {
        String formatted = AgentIdentity.formatBusinessNumber(businessNumber);
        return authenticate(formatted, password).continueWithTask(authTask -> {
            AuthResult result = authTask.getResult();
            String installId = store.installId();
            String deviceId = AgentIdentity.deviceId(formatted, installId);
            DocumentReference reference = firestore.collection("devices").document(deviceId);
            Map<String, Object> heartbeat = onlineFields(formatted, installId, result.getUser().getUid());

            return firestore.runTransaction(transaction -> {
                if (!transaction.get(reference).exists()) {
                    heartbeat.put("id", deviceId);
                    heartbeat.put("storeName", "상호명 미설정");
                    heartbeat.put("storeNameSource", "default");
                    heartbeat.put("deviceName", "Android");
                    heartbeat.put("updateRing", "general");
                    heartbeat.put("updatePaused", false);
                }
                transaction.set(reference, heartbeat, SetOptions.merge());
                return deviceId;
            }).continueWith(task -> {
                String registeredId = task.getResult();
                store.saveRegistration(formatted);
                return registeredId;
            });
        });
    }

    Task<Void> heartbeat() {
        return heartbeat(null);
    }

    Task<AuthResult> connect() {
        return ensureAuthenticated(store.businessNumber());
    }

    Task<Void> heartbeat(String requestId) {
        if (!store.isRegistered()) {
            return Tasks.forException(new IllegalStateException("Agent가 등록되지 않았습니다."));
        }
        String businessNumber = store.businessNumber();
        return ensureAuthenticated(businessNumber).continueWithTask(task -> {
            if (!task.isSuccessful()) return Tasks.forException(task.getException());
            String installId = store.installId();
            String uid = auth.getCurrentUser().getUid();
            Map<String, Object> fields = onlineFields(businessNumber, installId, uid);
            if (requestId != null) fields.put("heartbeatRequestId", requestId);
            return firestore.collection("devices").document(store.deviceId())
                .set(fields, SetOptions.merge());
        });
    }

    Task<Void> markOffline() {
        if (!store.isRegistered() || auth.getCurrentUser() == null) {
            return Tasks.forResult(null);
        }
        Map<String, Object> fields = new HashMap<>();
        fields.put("status", "offline");
        fields.put("updatedAt", FieldValue.serverTimestamp());
        return firestore.collection("devices").document(store.deviceId()).set(fields, SetOptions.merge());
    }

    ListenerRegistration listenForCommands(Consumer<String> onAction, Consumer<Exception> onError) {
        Set<String> delivering = new HashSet<>();
        Query commands = firestore.collection("devices").document(store.deviceId())
            .collection("commands")
            .whereEqualTo("state", "pending")
            .limit(50);
        return commands.addSnapshotListener((snapshot, error) -> {
            if (error != null) {
                onError.accept(error);
                return;
            }
            if (snapshot == null || snapshot.isEmpty()) {
                return;
            }
            List<DocumentSnapshot> documents = snapshot.getDocuments();
            documents.sort((left, right) -> {
                com.google.firebase.Timestamp leftAt = left.getTimestamp("createdAt");
                com.google.firebase.Timestamp rightAt = right.getTimestamp("createdAt");
                if (leftAt == null) return rightAt == null ? 0 : -1;
                if (rightAt == null) return 1;
                return leftAt.compareTo(rightAt);
            });
            WriteBatch batch = firestore.batch();
            List<String> actions = new java.util.ArrayList<>();
            List<String> documentIds = new java.util.ArrayList<>();
            for (DocumentSnapshot document : documents) {
                if (!delivering.add(document.getId())) {
                    continue;
                }
                String action = document.getString("action");
                Map<String, Object> delivery = new HashMap<>();
                delivery.put("deliveredAt", FieldValue.serverTimestamp());
                delivery.put("state", action == null || action.trim().isEmpty() ? "ignored" : "delivered");
                batch.update(document.getReference(), delivery);
                documentIds.add(document.getId());
                if (action != null && !action.trim().isEmpty()) {
                    com.google.firebase.Timestamp created = document.getTimestamp("createdAt");
                    if (!action.startsWith("refresh-status ") || (created != null
                        && Math.abs(System.currentTimeMillis() - created.toDate().getTime()) < 60_000)) {
                        actions.add(action.trim());
                    }
                }
            }
            if (documentIds.isEmpty()) {
                return;
            }
            batch.commit().addOnCompleteListener(task -> {
                documentIds.forEach(delivering::remove);
                if (task.isSuccessful()) {
                    actions.forEach(onAction);
                } else if (task.getException() != null) {
                    onError.accept(task.getException());
                }
            });
        });
    }

    private Task<AuthResult> ensureAuthenticated(String businessNumber) {
        if (auth.getCurrentUser() != null) {
            return Tasks.forResult(null);
        }
        return authenticate(businessNumber, "1234");
    }

    private Task<AuthResult> authenticate(String businessNumber, String password) {
        String email = AgentIdentity.authEmail(businessNumber);
        String firebasePassword = AgentIdentity.authPassword(businessNumber, password);
        return auth.signInWithEmailAndPassword(email, firebasePassword).continueWithTask(signIn -> {
            if (signIn.isSuccessful()) {
                return Tasks.forResult(signIn.getResult());
            }
            return auth.createUserWithEmailAndPassword(email, firebasePassword).continueWithTask(create -> {
                if (create.isSuccessful()) {
                    return Tasks.forResult(create.getResult());
                }
                if (create.getException() instanceof FirebaseAuthUserCollisionException) {
                    return auth.signInWithEmailAndPassword(email, firebasePassword);
                }
                return Tasks.forException(create.getException());
            });
        });
    }

    private Map<String, Object> onlineFields(String businessNumber, String installId, String ownerUid) {
        String formatted = AgentIdentity.formatBusinessNumber(businessNumber);
        Map<String, Object> fields = new HashMap<>();
        fields.put("businessNumber", formatted);
        fields.put("deletedAt", null);
        fields.put("desktopName", desktopName());
        fields.put("deviceNumber", AgentIdentity.deviceNumber(installId));
        fields.put("installId", installId);
        fields.put("lastSeenAt", Instant.now().toString());
        fields.put("lastSeenAtServer", FieldValue.serverTimestamp());
        fields.put("ownerUid", ownerUid);
        fields.put("platform", "android");
        fields.put("presenceMode", "manual");
        fields.put("protocolVersion", PROTOCOL_VERSION);
        fields.put("status", "online");
        fields.put("systemInfo", systemInfo());
        fields.put("updatedAt", FieldValue.serverTimestamp());
        fields.put("version", BuildConfig.VERSION_NAME);
        return fields;
    }

    private String desktopName() {
        String maker = Build.MANUFACTURER == null ? "Android" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "Device" : Build.MODEL.trim();
        return (maker + " " + model).trim();
    }

    private Map<String, Object> systemInfo() {
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(memory);
        Map<String, Object> info = new HashMap<>();
        info.put("cpuModel", Build.VERSION.SDK_INT >= 31 && Build.SOC_MODEL != null
            ? Build.SOC_MODEL : Build.HARDWARE);
        info.put("memoryBytes", memory.totalMem);
        info.put("osVersion", "Android " + Build.VERSION.RELEASE);
        return info;
    }
}
