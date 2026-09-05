package com.wonremote.agent;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AgentProjectionRequestTest {
    @Test
    public void promptsOnceForEachNewSessionWithoutProjection() {
        assertTrue(AgentService.shouldPromptForProjection(false, "session-1", null));
        assertTrue(AgentService.shouldPromptForProjection(false, "session-2", "session-1"));
        assertFalse(AgentService.shouldPromptForProjection(false, "session-1", "session-1"));
        assertFalse(AgentService.shouldPromptForProjection(true, "session-1", null));
        assertFalse(AgentService.shouldPromptForProjection(false, "", null));
        assertFalse(AgentService.shouldPromptForProjection(false, "   ", null));
        assertFalse(AgentService.shouldPromptForProjection(false, null, null));
    }

    @Test
    public void stopsOnlyTheCurrentNamedRemoteSession() {
        assertTrue(AgentService.shouldStopRemoteSession("stop-stream session-2", "session-2"));
        assertFalse(AgentService.shouldStopRemoteSession("stop-stream session-1", "session-2"));
        assertFalse(AgentService.shouldStopRemoteSession("stop-stream", "session-2"));
        assertFalse(AgentService.shouldStopRemoteSession("stop-stream session-2", null));
    }

    @Test
    public void ignoresLateCallbacksFromAReplacedSession() {
        assertTrue(RemoteSessionController.isCurrentSession("session-2", "session-2"));
        assertFalse(RemoteSessionController.isCurrentSession("session-1", "session-2"));
        assertFalse(RemoteSessionController.isCurrentSession("session-1", null));
    }

    @Test
    public void fallsBackWhenNoAccessibilityServiceCanLaunchConsent() {
        assertFalse(WonRemoteAccessibilityService.requestScreenShareConsent());
    }
}
