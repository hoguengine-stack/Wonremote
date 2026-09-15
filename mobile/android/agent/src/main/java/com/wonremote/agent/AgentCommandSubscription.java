package com.wonremote.agent;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.firestore.DocumentChange;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.FirebaseFirestoreException;
import com.google.firebase.firestore.ListenerRegistration;
import com.google.firebase.firestore.Query;
import com.google.firebase.firestore.Source;
import com.google.firebase.firestore.WriteBatch;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

/** Owned by AgentService; all callbacks run on its main-thread executor. */
final class AgentCommandSubscription implements ListenerRegistration {
    private final FirebaseFirestore firestore;
    private final Query query;
    private final Executor executor;
    private final Consumer<String> onAction;
    private final Consumer<Exception> onError;
    private final Set<String> queuedIds = new HashSet<>();
    private final ArrayDeque<List<DocumentSnapshot>> queue = new ArrayDeque<>();
    private ListenerRegistration listener;
    private boolean active = true;
    private boolean busy;

    AgentCommandSubscription(FirebaseFirestore firestore, Query query, Executor executor,
            Consumer<String> onAction, Consumer<Exception> onError) {
        this.firestore = firestore;
        this.query = query;
        this.executor = executor;
        this.onAction = onAction;
        this.onError = onError;
    }

    ListenerRegistration start() {
        listener = query.addSnapshotListener(executor, (snapshot, error) -> {
            if (!active) return;
            if (error != null) { fail(error); return; }
            if (snapshot == null) return;
            List<DocumentSnapshot> documents = new ArrayList<>();
            for (DocumentChange change : snapshot.getDocumentChanges()) {
                if (change.getType() == DocumentChange.Type.ADDED
                        && queuedIds.add(change.getDocument().getId())) {
                    documents.add(change.getDocument());
                }
            }
            if (documents.isEmpty()) return;
            documents.sort((left, right) -> {
                com.google.firebase.Timestamp a = left.getTimestamp("createdAt");
                com.google.firebase.Timestamp b = right.getTimestamp("createdAt");
                if (a == null) return b == null ? 0 : -1;
                return b == null ? 1 : a.compareTo(b);
            });
            queue.add(documents);
            drain();
        });
        if (!active) remove();
        return this;
    }

    private void drain() {
        if (!active || busy || queue.isEmpty()) return;
        busy = true;
        List<DocumentSnapshot> documents = queue.remove();
        acknowledge(documents, true).addOnCompleteListener(executor, task -> {
            if (!active) return;
            if (!task.isSuccessful()) { fail(task.getException()); return; }
            try {
                for (String action : task.getResult()) {
                    if (!active) return;
                    onAction.accept(action);
                }
            } catch (Exception error) {
                fail(error);
                return;
            }
            for (DocumentSnapshot document : documents) queuedIds.remove(document.getId());
            busy = false;
            drain();
        });
    }

    private Task<List<String>> acknowledge(List<DocumentSnapshot> documents, boolean recover) {
        if (!active || documents.isEmpty()) return Tasks.forResult(new ArrayList<>());
        WriteBatch batch = firestore.batch();
        List<String> actions = new ArrayList<>();
        for (DocumentSnapshot document : documents) {
            String action = document.getString("action");
            boolean valid = action != null && !action.trim().isEmpty();
            Map<String, Object> delivery = new HashMap<>();
            delivery.put("state", valid ? "delivered" : "ignored");
            delivery.put("deliveredAt", FieldValue.serverTimestamp());
            batch.update(document.getReference(), delivery);
            if (valid) {
                com.google.firebase.Timestamp created = document.getTimestamp("createdAt");
                if (!action.startsWith("refresh-status ") || (created != null
                        && Math.abs(System.currentTimeMillis() - created.toDate().getTime()) < 60_000)) {
                    actions.add(action.trim());
                }
            }
        }
        return batch.commit().continueWithTask(executor, task -> {
            if (!active) return Tasks.forResult(new ArrayList<>());
            if (task.isSuccessful()) return Tasks.forResult(actions);
            Exception error = task.getException();
            if (!recover || !(error instanceof FirebaseFirestoreException)
                    || ((FirebaseFirestoreException) error).getCode() != FirebaseFirestoreException.Code.NOT_FOUND) {
                return Tasks.forException(error);
            }
            // Retry atomically once, in original order, without claiming newly arrived IDs.
            return query.get(Source.SERVER).continueWithTask(executor, refreshed -> {
                if (!active) return Tasks.forResult(new ArrayList<>());
                if (!refreshed.isSuccessful()) return Tasks.forException(refreshed.getException());
                Map<String, DocumentSnapshot> current = new HashMap<>();
                for (DocumentSnapshot document : refreshed.getResult().getDocuments()) {
                    current.put(document.getId(), document);
                }
                List<DocumentSnapshot> survivors = new ArrayList<>();
                for (DocumentSnapshot document : documents) {
                    if (current.containsKey(document.getId())) survivors.add(current.get(document.getId()));
                }
                return acknowledge(survivors, false);
            });
        });
    }

    private void fail(Exception error) {
        if (!active) return;
        remove();
        onError.accept(error);
    }

    @Override public void remove() {
        active = false;
        if (listener != null) { listener.remove(); listener = null; }
        queue.clear();
        queuedIds.clear();
    }
}
