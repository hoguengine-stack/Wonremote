package com.wonremote.agent;

import static org.junit.Assert.*;

import com.google.firebase.firestore.FirebaseFirestoreException;
import org.junit.Test;

public final class FirebaseQuotaTest {
    @Test
    public void unwrapsTransactionFailureAndExplainsQuotaInsteadOfCredentials() {
        Throwable error = new RuntimeException(new FirebaseFirestoreException(
            "Quota exceeded.", FirebaseFirestoreException.Code.RESOURCE_EXHAUSTED));
        assertTrue(FirebaseQuota.exhausted(error));
        assertEquals(300_000, FirebaseQuota.retryDelayMs(error));
        assertTrue(FirebaseQuota.registrationMessage(error).contains("한도"));
        assertTrue(FirebaseQuota.registrationMessage(error).contains("재설치로 해결되지 않습니다"));
    }

    @Test
    public void doesNotClassifyPermissionsOrNetworkAsQuotaAndCanRecover() {
        Throwable error = new FirebaseFirestoreException(
            "Denied", FirebaseFirestoreException.Code.PERMISSION_DENIED);
        assertFalse(FirebaseQuota.exhausted(error));
        assertEquals(10_000, FirebaseQuota.retryDelayMs(error));
        assertEquals("등록 실패 · Denied", FirebaseQuota.registrationMessage(error));
        assertFalse(FirebaseQuota.exhausted(null));
        assertEquals(10_000, FirebaseQuota.retryDelayMs(null));
    }
}
