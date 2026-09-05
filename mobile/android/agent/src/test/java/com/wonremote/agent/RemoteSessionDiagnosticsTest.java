package com.wonremote.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public final class RemoteSessionDiagnosticsTest {
    @Test
    public void failedOfferAndAnswerCallbacksIdentifyTheMissingNegotiationStage() {
        List<String> failures = new ArrayList<>();
        new RemoteSessionController.SimpleSdpObserver("remote offer", failures::add)
            .onSetFailure("private SDP and ICE credentials");
        new RemoteSessionController.SimpleSdpObserver("create answer", failures::add)
            .onCreateFailure("private SDP and ICE credentials");
        new RemoteSessionController.SimpleSdpObserver("local answer", failures::add)
            .onSetFailure("private SDP and ICE credentials");

        assertEquals(List.of(
            "WebRTC remote offer failed (apply).",
            "WebRTC create answer failed (create).",
            "WebRTC local answer failed (apply)."
        ), failures);
    }

    @Test
    public void successfulCallbacksDoNotReportFailure() {
        List<String> failures = new ArrayList<>();
        RemoteSessionController.SimpleSdpObserver observer =
            new RemoteSessionController.SimpleSdpObserver("local answer", failures::add);
        observer.onCreateSuccess(null);
        observer.onSetSuccess();
        assertTrue(failures.isEmpty());
    }
}
