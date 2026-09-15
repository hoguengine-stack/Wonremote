package com.wonremote.agent;

import com.google.android.gms.tasks.TaskCompletionSource;
import com.google.firebase.Timestamp;
import com.google.firebase.firestore.*;
import java.util.*;
import java.util.concurrent.Executor;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class AgentCommandSubscriptionTest {
    private final FirebaseFirestore db = mock(FirebaseFirestore.class);
    private final Query query = mock(Query.class);
    private final ListenerRegistration registration = mock(ListenerRegistration.class);
    private final List<String> actions = new ArrayList<>();
    private final List<Exception> errors = new ArrayList<>();
    private final List<List<String>> writes = new ArrayList<>();
    private final List<TaskCompletionSource<Void>> commits = new ArrayList<>();
    private final TaskCompletionSource<QuerySnapshot> refresh = new TaskCompletionSource<>();
    private com.google.firebase.firestore.EventListener<QuerySnapshot> callback;
    private ListenerRegistration owner;

    @After public void tearDown() { owner.remove(); }

    @Before public void setUp() {
        when(query.addSnapshotListener(any(Executor.class), any())).thenAnswer(call -> {
            callback = call.getArgument(1);
            return registration;
        });
        when(query.get(Source.SERVER)).thenReturn(refresh.getTask());
        when(db.batch()).thenAnswer(call -> {
            WriteBatch batch = mock(WriteBatch.class);
            List<String> ids = new ArrayList<>();
            writes.add(ids);
            when(batch.update(any(DocumentReference.class), anyMap())).thenAnswer(update -> {
                ids.add(((DocumentReference) update.getArgument(0)).getId());
                return batch;
            });
            TaskCompletionSource<Void> commit = new TaskCompletionSource<>();
            commits.add(commit);
            when(batch.commit()).thenReturn(commit.getTask());
            return batch;
        });
        owner = new AgentCommandSubscription(db, query, Runnable::run, actions::add, errors::add).start();
    }

    private DocumentSnapshot document(String id, String action) {
        QueryDocumentSnapshot document = mock(QueryDocumentSnapshot.class);
        DocumentReference reference = mock(DocumentReference.class);
        when(reference.getId()).thenReturn(id);
        when(document.getId()).thenReturn(id);
        when(document.getReference()).thenReturn(reference);
        when(document.getString("action")).thenReturn(action);
        when(document.getTimestamp("createdAt")).thenReturn(Timestamp.now());
        return document;
    }

    private QuerySnapshot snapshot(DocumentSnapshot... documents) {
        QuerySnapshot snapshot = mock(QuerySnapshot.class);
        List<DocumentChange> changes = new ArrayList<>();
        for (DocumentSnapshot document : documents) {
            DocumentChange change = mock(DocumentChange.class);
            when(change.getType()).thenReturn(DocumentChange.Type.ADDED);
            when(change.getDocument()).thenReturn((QueryDocumentSnapshot) document);
            changes.add(change);
        }
        when(snapshot.getDocumentChanges()).thenReturn(changes);
        when(snapshot.getDocuments()).thenReturn(Arrays.asList(documents));
        return snapshot;
    }

    private FirebaseFirestoreException failure(FirebaseFirestoreException.Code code) {
        return new FirebaseFirestoreException("test failure", code);
    }

    @Test public void serializesOverlappingSnapshotsAndPreservesDistinctIdRepeatInput() {
        DocumentSnapshot a = document("a", "mouse left");
        DocumentSnapshot b = document("b", "mouse left");
        callback.onEvent(snapshot(a), null);
        callback.onEvent(snapshot(a, b), null);
        assertEquals(1, commits.size());
        assertTrue(actions.isEmpty());
        commits.get(0).setResult(null);
        assertEquals(Collections.singletonList("mouse left"), actions);
        assertEquals(2, commits.size());
        commits.get(1).setResult(null);
        assertEquals(Arrays.asList("mouse left", "mouse left"), actions);
        assertEquals(Arrays.asList(Collections.singletonList("a"), Collections.singletonList("b")), writes);
        verify(query, never()).get(Source.SERVER);
    }

    @Test public void recoversDeletedCommandOnceWithoutClaimingNewCommand() {
        DocumentSnapshot old = document("old", "obsolete");
        DocumentSnapshot a = document("a", "refresh-status request");
        DocumentSnapshot b = document("b", "mouse right");
        callback.onEvent(snapshot(old, a), null);
        callback.onEvent(snapshot(a, b), null);
        commits.get(0).setException(failure(FirebaseFirestoreException.Code.NOT_FOUND));
        refresh.setResult(snapshot(a, b));
        assertEquals(Collections.singletonList("a"), writes.get(1));
        commits.get(1).setResult(null);
        assertEquals(Collections.singletonList("refresh-status request"), actions);
        commits.get(2).setResult(null);
        assertEquals(Arrays.asList("refresh-status request", "mouse right"), actions);
        verify(query, times(1)).get(Source.SERVER);
        verify(registration, never()).remove();
        assertTrue(errors.isEmpty());
    }

    @Test public void stopsOnSecondDeletionAndDoesNotRunQueuedCommands() {
        callback.onEvent(snapshot(document("a", "key a")), null);
        callback.onEvent(snapshot(document("b", "key b")), null);
        commits.get(0).setException(failure(FirebaseFirestoreException.Code.NOT_FOUND));
        refresh.setResult(snapshot(document("a", "key a")));
        commits.get(1).setException(failure(FirebaseFirestoreException.Code.NOT_FOUND));
        callback.onEvent(snapshot(document("late", "key late")), null);
        assertEquals(2, commits.size());
        assertEquals(1, errors.size());
        assertTrue(actions.isEmpty());
        verify(registration).remove();
        verify(query, times(1)).get(Source.SERVER);
    }

    @Test public void terminalPermissionErrorDoesNotRefreshOrDrain() {
        callback.onEvent(snapshot(document("a", "key a")), null);
        callback.onEvent(snapshot(document("b", "key b")), null);
        commits.get(0).setException(failure(FirebaseFirestoreException.Code.PERMISSION_DENIED));
        assertEquals(1, commits.size());
        assertEquals(1, errors.size());
        verify(query, never()).get(Source.SERVER);
        verify(registration).remove();
        assertTrue(actions.isEmpty());
    }

    @Test public void stopDuringCommitSuppressesQueuedAndLateCallbacks() {
        callback.onEvent(snapshot(document("a", "key a")), null);
        callback.onEvent(snapshot(document("b", "key b")), null);
        owner.remove();
        commits.get(0).setResult(null);
        callback.onEvent(snapshot(document("c", "key c")), null);
        assertEquals(1, commits.size());
        assertTrue(actions.isEmpty());
        assertTrue(errors.isEmpty());
        verify(registration).remove();
    }

    @Test public void stopDuringRecoveryPreventsRetryWrite() {
        callback.onEvent(snapshot(document("a", "key a")), null);
        commits.get(0).setException(failure(FirebaseFirestoreException.Code.NOT_FOUND));
        owner.remove();
        refresh.setResult(snapshot(document("a", "key a")));
        assertEquals(1, commits.size());
        assertTrue(actions.isEmpty());
    }

    @Test public void idleAndModifiedSnapshotsMakeNoRequests() {
        QuerySnapshot empty = snapshot();
        callback.onEvent(empty, null);
        DocumentChange modified = mock(DocumentChange.class);
        when(modified.getType()).thenReturn(DocumentChange.Type.MODIFIED);
        QuerySnapshot snapshot = mock(QuerySnapshot.class);
        when(snapshot.getDocumentChanges()).thenReturn(Collections.singletonList(modified));
        callback.onEvent(snapshot, null);
        verify(db, never()).batch();
        verify(query, never()).get(Source.SERVER);
        verify(query, times(1)).addSnapshotListener(any(Executor.class), any());
    }

    @Test public void fiftyDocumentRaceHasBoundedRequestsAndNoDuplicateDispatch() {
        DocumentSnapshot[] docs = new DocumentSnapshot[50];
        for (int i = 0; i < docs.length; i++) docs[i] = document("id" + i, "key " + i);
        callback.onEvent(snapshot(docs), null);
        commits.get(0).setException(failure(FirebaseFirestoreException.Code.NOT_FOUND));
        refresh.setResult(snapshot(Arrays.copyOfRange(docs, 1, 50)));
        commits.get(1).setResult(null);
        assertEquals(99, writes.stream().mapToInt(List::size).sum());
        assertEquals(49, actions.size());
        assertEquals(49, new HashSet<>(actions).size());
        verify(query, times(1)).get(Source.SERVER);
    }

    @Test public void androidMainLooperOwnsDispatchAndRemountIgnoresOldCallbacks() {
        owner.remove();
        com.google.firebase.firestore.EventListener<QuerySnapshot> old = callback;
        owner = new AgentCommandSubscription(db, query,
            com.google.android.gms.tasks.TaskExecutors.MAIN_THREAD, action -> {
                assertEquals(android.os.Looper.getMainLooper(), android.os.Looper.myLooper());
                actions.add(action);
            }, errors::add).start();
        old.onEvent(snapshot(document("old", "key-down F12")), null);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper())
            .idleFor(java.time.Duration.ofDays(1));
        assertTrue(commits.isEmpty());
        verify(query, times(2)).addSnapshotListener(any(Executor.class), any());
        verify(query, never()).get(Source.SERVER);
        callback.onEvent(snapshot(document("a", "key-down F12")), null);
        commits.get(0).setResult(null);
        assertTrue(actions.isEmpty());
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertEquals(Collections.singletonList("key-down F12"), actions);
    }

    @Test public void listenerQuotaErrorCancelsInFlightAndReportsOnce() {
        callback.onEvent(snapshot(document("a", "key-down F12")), null);
        callback.onEvent(null, failure(FirebaseFirestoreException.Code.RESOURCE_EXHAUSTED));
        commits.get(0).setResult(null);
        callback.onEvent(null, failure(FirebaseFirestoreException.Code.RESOURCE_EXHAUSTED));
        assertTrue(actions.isEmpty());
        assertEquals(1, errors.size());
        verify(registration).remove();
        verify(query, never()).get(Source.SERVER);
    }

    @Test public void recoveryReadFailureIsTerminalWithoutRetryWrites() {
        callback.onEvent(snapshot(document("a", "key-down F12")), null);
        commits.get(0).setException(failure(FirebaseFirestoreException.Code.NOT_FOUND));
        refresh.setException(failure(FirebaseFirestoreException.Code.UNAVAILABLE));
        assertEquals(1, commits.size());
        assertEquals(1, errors.size());
        assertTrue(actions.isEmpty());
    }

    @Test public void allDeletedCommandsDoNotBlockNextInput() {
        callback.onEvent(snapshot(document("a", "key-down F12")), null);
        callback.onEvent(snapshot(document("b", "key-up F12")), null);
        commits.get(0).setException(failure(FirebaseFirestoreException.Code.NOT_FOUND));
        refresh.setResult(snapshot());
        assertEquals(Collections.singletonList("b"), writes.get(1));
        commits.get(1).setResult(null);
        assertEquals(Collections.singletonList("key-up F12"), actions);
        assertTrue(errors.isEmpty());
    }

    @Test public void stopFromActionCallbackSuppressesRemainingActions() {
        owner.remove();
        owner = new AgentCommandSubscription(db, query, Runnable::run, action -> {
            actions.add(action);
            owner.remove();
        }, errors::add).start();
        callback.onEvent(snapshot(document("a", "key-down F12"), document("b", "key-up F12")), null);
        commits.get(0).setResult(null);
        assertEquals(Collections.singletonList("key-down F12"), actions);
    }

    @Test public void idStaysReservedWhileActionCallbackRuns() {
        owner.remove();
        DocumentSnapshot a = document("a", "key-down F12");
        owner = new AgentCommandSubscription(db, query, Runnable::run, action -> {
            actions.add(action);
            callback.onEvent(snapshot(a), null);
        }, errors::add).start();
        callback.onEvent(snapshot(a), null);
        commits.get(0).setResult(null);
        assertEquals(1, commits.size());
        assertEquals(Collections.singletonList("key-down F12"), actions);
    }

    @Test public void expiredRefreshAndBlankActionAreAcknowledgedWithoutExecution() {
        DocumentSnapshot stale = document("stale", "refresh-status expired");
        when(stale.getTimestamp("createdAt")).thenReturn(new Timestamp(new Date(System.currentTimeMillis() - 120_000)));
        callback.onEvent(snapshot(stale, document("blank", "  "), document("valid", "key-up F12")), null);
        commits.get(0).setResult(null);
        assertEquals(3, writes.get(0).size());
        assertEquals(Collections.singletonList("key-up F12"), actions);
    }
}
