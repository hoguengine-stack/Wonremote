package com.wonremote.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class AgentIdentityTest {
    @Test
    public void matchesDesktopFirebaseIdentityContract() {
        assertEquals("123-45-67890", AgentIdentity.formatBusinessNumber("1234567890"));
        assertEquals("1234567890@agents.wonremote.app", AgentIdentity.authEmail("123-45-67890"));
        assertEquals("wonremote-1234567890-1234", AgentIdentity.authPassword("1234567890", "1234"));
        assertEquals("AGENT-LOCALENV-425D1CB", AgentIdentity.deviceNumber("agent-localenv-425d1cbe"));
        assertEquals(
            "123-45-67890:AGENT-LOCALENV-425D1CB",
            AgentIdentity.deviceId("1234567890", "agent-localenv-425d1cbe")
        );
    }

    @Test
    public void rejectsInvalidRegistrationInput() {
        assertThrows(IllegalArgumentException.class, () -> AgentIdentity.formatBusinessNumber("1234"));
        assertThrows(IllegalArgumentException.class, () -> AgentIdentity.authPassword("1234567890", "0000"));
        assertThrows(IllegalArgumentException.class, () -> AgentIdentity.deviceNumber("agent-"));
    }
}
