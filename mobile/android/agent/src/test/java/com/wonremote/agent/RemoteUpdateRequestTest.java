package com.wonremote.agent;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteUpdateRequestTest {
    @Test public void defersDeduplicatesAndExpiresWithoutPolling() {
        RemoteUpdateRequest request = new RemoteUpdateRequest();
        long now = 1700000000000L;
        assertTrue(request.accept("request-update " + now, now));
        assertFalse(request.start(true));
        assertFalse(request.accept("request-update " + now, now));
        assertTrue(request.start(false));
        assertFalse(request.accept("request-update " + (now+1), now+1));
        request.finish();
        assertFalse(request.start(false));
        assertFalse(request.accept("request-update " + (now+2), now+86400000));
        assertTrue(request.accept("request-update " + (now+3), now+3));
        assertTrue(request.start(false));
    }
}
