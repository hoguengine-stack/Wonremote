package com.wonremote.agent;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ControlAddonClientTest {
    private static final String ADDON_SERVICE =
        "com.wonremote.controladdon/com.wonremote.agent.WonRemoteAccessibilityService";

    @Test
    public void detectsOnlyTheControlAddonAccessibilityService() {
        assertFalse(ControlAddonClient.containsEnabledService(null));
        assertFalse(ControlAddonClient.containsEnabledService(" \t\n"));
        assertFalse(ControlAddonClient.execute(null, " \t\n"));
        assertFalse(ControlAddonClient.containsEnabledService("com.example/.OtherService"));
        assertTrue(ControlAddonClient.containsEnabledService("com.example/.OtherService:" + ADDON_SERVICE));
    }
}
