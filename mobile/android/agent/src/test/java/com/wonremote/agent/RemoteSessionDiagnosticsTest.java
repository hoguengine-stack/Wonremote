package com.wonremote.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public final class RemoteSessionDiagnosticsTest {
    @Test
    public void firestoreOfferPreservesEveryLineThroughTheNativeDescriptionBoundary() {
        String sdp = "v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
            + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
            + "a=sctp-port:5000\r\na=max-message-size:262144\r\n";
        for (String wire : List.of(sdp, sdp.replace("\r\n", "\n"))) {
            for (int connection = 0; connection < 2; connection++) {
                String received = RemoteSessionController.readOfferSdp(Map.of("sdp", wire));
                assertEquals(wire, received);
                assertTrue(received.endsWith("\n"));
            }
        }
        assertEquals("", RemoteSessionController.readOfferSdp(Map.of()));
        assertEquals("", RemoteSessionController.readOfferSdp(Map.of("sdp", 123)));
    }

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
