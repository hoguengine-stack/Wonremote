package com.wonremote.agent;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Intent;

import org.junit.Test;

public final class BootReceiverTest {
    @Test
    public void startsOnlyRegisteredAgentForSupportedBootEvents() {
        assertTrue(BootReceiver.shouldStart(Intent.ACTION_BOOT_COMPLETED, true));
        assertTrue(BootReceiver.shouldStart(Intent.ACTION_MY_PACKAGE_REPLACED, true));
        assertTrue(BootReceiver.shouldStart("android.intent.action.QUICKBOOT_POWERON", true));
        assertFalse(BootReceiver.shouldStart(Intent.ACTION_BOOT_COMPLETED, false));
        assertFalse(BootReceiver.shouldStart("android.intent.action.PACKAGE_ADDED", true));
        assertFalse(BootReceiver.shouldStart(null, true));
    }
}
