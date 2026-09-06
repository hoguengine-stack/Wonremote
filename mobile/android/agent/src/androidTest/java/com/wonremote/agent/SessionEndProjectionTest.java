package com.wonremote.agent;

import junit.framework.TestCase;

public final class SessionEndProjectionTest extends TestCase {
    public void testSessionClosureUsesExplicitProjectionShutdown() {
        RecordingService service = new RecordingService();
        service.finishRemoteSession();
        assertEquals(1, service.stops);
        assertNotNull(service.status);
    }

    private static final class RecordingService extends AgentService {
        int stops;
        String status;

        @Override
        void endProjection(String status) {
            stops++;
            this.status = status;
        }
    }
}
