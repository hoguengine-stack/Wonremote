package com.wonremote.agent;

import com.google.firebase.firestore.DocumentReference;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.ListenerRegistration;
import com.google.firebase.firestore.Query;
import com.google.firebase.firestore.SetOptions;

import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

final class RemoteSessionController {
    private static final String TILE_CHANNEL = "wonremote-tiles";
    private static final String CONTROL_CHANNEL = "wonremote-control";
    private static final String FILE_CHANNEL = "wonremote-files";

    private final FirebaseFirestore firestore = FirebaseFirestore.getInstance();
    private final PeerConnectionFactory factory;
    private final ScreenFrameStreamer streamer;
    private final Consumer<String> controlHandler;
    private final Runnable sessionClosed;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Map<String, IceCandidate> pendingCandidates = new LinkedHashMap<>();
    private final Set<String> appliedCandidateIds = new HashSet<>();

    private ListenerRegistration signalListener;
    private ListenerRegistration candidateListener;
    private ListenerRegistration sessionListener;
    private PeerConnection peer;
    private DataChannel tileChannel;
    private DataChannel controlChannel;
    private String sessionId;
    private String negotiationId;
    private boolean remoteDescriptionReady;

    RemoteSessionController(
        android.content.Context context,
        ScreenFrameStreamer streamer,
        Consumer<String> controlHandler,
        Runnable sessionClosed
    ) {
        this.streamer = streamer;
        this.controlHandler = controlHandler;
        this.sessionClosed = sessionClosed;
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.getApplicationContext())
                .createInitializationOptions()
        );
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
    }

    void start(String nextSessionId) {
        if (nextSessionId == null || nextSessionId.trim().isEmpty()) {
            return;
        }
        if (nextSessionId.equals(sessionId)) {
            return;
        }
        closeSession();
        sessionId = nextSessionId;
        DocumentReference session = firestore.collection("sessions").document(nextSessionId);
        sessionListener = session.addSnapshotListener((snapshot, error) -> {
            if (error == null && snapshot != null && "closed".equals(snapshot.getString("state"))) {
                closeSession();
                sessionClosed.run();
            }
        });
        signalListener = session.collection("webrtc").document("signal")
            .addSnapshotListener((snapshot, error) -> {
                if (error == null && snapshot != null && snapshot.exists()) {
                    acceptOffer(snapshot);
                }
            });
    }

    void close() {
        closeSession();
        factory.dispose();
    }

    void stopSession() {
        closeSession();
    }

    private void acceptOffer(DocumentSnapshot signal) {
        Object rawOffer = signal.get("offer");
        if (!(rawOffer instanceof Map)) {
            return;
        }
        Map<?, ?> offer = (Map<?, ?>) rawOffer;
        String offerType = string(offer.get("type"));
        String offerSdp = string(offer.get("sdp"));
        String offerNegotiationId = string(offer.get("negotiationId"));
        String rootNegotiationId = signal.getString("negotiationId");
        String nextNegotiationId = offerNegotiationId.isEmpty() ? rootNegotiationId : offerNegotiationId;
        if (!"offer".equals(offerType) || offerSdp.isEmpty() || nextNegotiationId == null
            || nextNegotiationId.isEmpty() || nextNegotiationId.equals(negotiationId)
            || (!offerNegotiationId.isEmpty() && rootNegotiationId != null
                && !rootNegotiationId.equals(offerNegotiationId))) {
            return;
        }
        negotiate(nextNegotiationId, offerSdp);
    }

    private void negotiate(String nextNegotiationId, String offerSdp) {
        closePeer();
        negotiationId = nextNegotiationId;
        remoteDescriptionReady = false;
        appliedCandidateIds.clear();
        pendingCandidates.clear();

        PeerConnection.IceServer stun = PeerConnection.IceServer.builder("stun:stun.l.google.com:19302")
            .createIceServer();
        PeerConnection.RTCConfiguration configuration = new PeerConnection.RTCConfiguration(
            Collections.singletonList(stun)
        );
        configuration.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        configuration.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
        peer = factory.createPeerConnection(configuration, new PeerObserver(nextNegotiationId));
        if (peer == null) {
            return;
        }
        listenForViewerCandidates(nextNegotiationId);
        peer.setRemoteDescription(new SimpleSdpObserver() {
            @Override
            public void onSetSuccess() {
                handler.post(() -> {
                    if (!nextNegotiationId.equals(negotiationId) || peer == null) {
                        return;
                    }
                    remoteDescriptionReady = true;
                    flushPendingCandidates();
                    peer.createAnswer(new SimpleSdpObserver() {
                        @Override
                        public void onCreateSuccess(SessionDescription answer) {
                            setLocalAnswer(nextNegotiationId, answer);
                        }
                    }, new MediaConstraints());
                });
            }
        }, new SessionDescription(SessionDescription.Type.OFFER, offerSdp));
    }

    private void setLocalAnswer(String expectedNegotiationId, SessionDescription answer) {
        PeerConnection current = peer;
        if (current == null || !expectedNegotiationId.equals(negotiationId)) {
            return;
        }
        current.setLocalDescription(new SimpleSdpObserver() {
            @Override
            public void onSetSuccess() {
                handler.post(() -> {
                    if (peer == null || sessionId == null || !expectedNegotiationId.equals(negotiationId)) {
                        return;
                    }
                    Map<String, Object> answerData = new HashMap<>();
                    answerData.put("negotiationId", expectedNegotiationId);
                    answerData.put("type", "answer");
                    answerData.put("sdp", answer.description);
                    Map<String, Object> signal = new HashMap<>();
                    signal.put("answer", answerData);
                    signal.put("negotiationId", expectedNegotiationId);
                    signal.put("state", "agent-answer");
                    signal.put("updatedAt", FieldValue.serverTimestamp());
                    signalReference().set(signal, SetOptions.merge());
                });
            }
        }, answer);
    }

    private void listenForViewerCandidates(String expectedNegotiationId) {
        candidateListener = firestore.collection("sessions").document(sessionId)
            .collection("viewerCandidates")
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(64)
            .addSnapshotListener((snapshot, error) -> {
                if (error != null || snapshot == null || !expectedNegotiationId.equals(negotiationId)) {
                    return;
                }
                snapshot.getDocuments().forEach(document -> {
                    if (appliedCandidateIds.contains(document.getId())
                        || !expectedNegotiationId.equals(document.getString("negotiationId"))) {
                        return;
                    }
                    Object raw = document.get("candidate");
                    if (!(raw instanceof Map)) {
                        appliedCandidateIds.add(document.getId());
                        return;
                    }
                    Map<?, ?> candidateData = (Map<?, ?>) raw;
                    String candidate = string(candidateData.get("candidate"));
                    String sdpMid = string(candidateData.get("sdpMid"));
                    int line = number(candidateData.get("sdpMLineIndex"));
                    if (candidate.isEmpty() || line < 0) {
                        return;
                    }
                    IceCandidate iceCandidate = new IceCandidate(sdpMid, line, candidate);
                    if (remoteDescriptionReady && peer != null) {
                        pendingCandidates.put(document.getId(), iceCandidate);
                        flushPendingCandidates();
                    } else {
                        pendingCandidates.put(document.getId(), iceCandidate);
                    }
                });
            });
    }

    private void flushPendingCandidates() {
        if (!remoteDescriptionReady || peer == null || pendingCandidates.isEmpty()) {
            return;
        }
        pendingCandidates.entrySet().removeIf(entry -> {
            if (peer != null && peer.addIceCandidate(entry.getValue())) {
                appliedCandidateIds.add(entry.getKey());
                return true;
            }
            return false;
        });
        handler.removeCallbacks(candidateRetry);
        if (!pendingCandidates.isEmpty()) {
            handler.postDelayed(candidateRetry, 100);
        }
    }

    private final Runnable candidateRetry = this::flushPendingCandidates;

    private void publishCandidate(String expectedNegotiationId, IceCandidate candidate) {
        String activeSessionId = sessionId;
        if (!expectedNegotiationId.equals(negotiationId) || activeSessionId == null) {
            return;
        }
        Map<String, Object> candidateData = new HashMap<>();
        candidateData.put("candidate", candidate.sdp);
        candidateData.put("sdpMid", candidate.sdpMid);
        candidateData.put("sdpMLineIndex", candidate.sdpMLineIndex);
        Map<String, Object> document = new HashMap<>();
        document.put("candidate", candidateData);
        document.put("createdAt", FieldValue.serverTimestamp());
        document.put("negotiationId", expectedNegotiationId);
        firestore.collection("sessions").document(activeSessionId).collection("agentCandidates").add(document);
    }

    private void routeDataChannel(DataChannel channel) {
        if (TILE_CHANNEL.equals(channel.label())) {
            tileChannel = channel;
            channel.registerObserver(new DataChannel.Observer() {
                @Override
                public void onBufferedAmountChange(long previousAmount) {}

                @Override
                public void onStateChange() {
                    if (channel.state() == DataChannel.State.OPEN) {
                        streamer.setChannel(channel);
                    } else if (channel == tileChannel) {
                        streamer.setChannel(null);
                    }
                }

                @Override
                public void onMessage(DataChannel.Buffer buffer) {}
            });
            if (channel.state() == DataChannel.State.OPEN) {
                streamer.setChannel(channel);
            }
            return;
        }
        if (CONTROL_CHANNEL.equals(channel.label())) {
            controlChannel = channel;
            channel.registerObserver(new DataChannel.Observer() {
                @Override
                public void onBufferedAmountChange(long previousAmount) {}

                @Override
                public void onStateChange() {
                    if (channel.state() == DataChannel.State.CLOSED) {
                        WonRemoteAccessibilityService.releasePointer();
                    }
                }

                @Override
                public void onMessage(DataChannel.Buffer buffer) {
                    if (!buffer.binary) {
                        String action = parseControl(buffer.data);
                        if (!action.isEmpty()) {
                            controlHandler.accept(action);
                        }
                    }
                }
            });
            return;
        }
        if (FILE_CHANNEL.equals(channel.label())) {
            channel.registerObserver(new EmptyDataChannelObserver());
            return;
        }
        channel.close();
    }

    private String parseControl(ByteBuffer data) {
        byte[] bytes = new byte[data.remaining()];
        data.get(bytes);
        if (bytes.length == 0 || bytes.length > 16 * 1024) {
            return "";
        }
        try {
            JSONObject message = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            return "control".equals(message.optString("type")) ? message.optString("action") : "";
        } catch (JSONException error) {
            return "";
        }
    }

    private DocumentReference signalReference() {
        return firestore.collection("sessions").document(sessionId).collection("webrtc").document("signal");
    }

    private void closeSession() {
        if (signalListener != null) {
            signalListener.remove();
            signalListener = null;
        }
        if (sessionListener != null) {
            sessionListener.remove();
            sessionListener = null;
        }
        closePeer();
        sessionId = null;
    }

    private void closePeer() {
        if (candidateListener != null) {
            candidateListener.remove();
            candidateListener = null;
        }
        streamer.setChannel(null);
        WonRemoteAccessibilityService.releasePointer();
        if (tileChannel != null) {
            tileChannel.unregisterObserver();
            tileChannel = null;
        }
        if (controlChannel != null) {
            controlChannel.unregisterObserver();
            controlChannel = null;
        }
        if (peer != null) {
            peer.close();
            peer.dispose();
            peer = null;
        }
        negotiationId = null;
        remoteDescriptionReady = false;
        handler.removeCallbacks(candidateRetry);
        pendingCandidates.clear();
        appliedCandidateIds.clear();
    }

    private static String string(Object value) {
        return value instanceof String ? ((String) value).trim() : "";
    }

    private static int number(Object value) {
        return value instanceof Number ? ((Number) value).intValue() : -1;
    }

    private final class PeerObserver implements PeerConnection.Observer {
        private final String expectedNegotiationId;

        private PeerObserver(String expectedNegotiationId) {
            this.expectedNegotiationId = expectedNegotiationId;
        }

        @Override
        public void onSignalingChange(PeerConnection.SignalingState state) {}

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState state) {}

        @Override
        public void onIceConnectionReceivingChange(boolean receiving) {}

        @Override
        public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}

        @Override
        public void onIceCandidate(IceCandidate candidate) {
            publishCandidate(expectedNegotiationId, candidate);
        }

        @Override
        public void onIceCandidatesRemoved(IceCandidate[] candidates) {}

        @Override
        public void onAddStream(MediaStream stream) {}

        @Override
        public void onRemoveStream(MediaStream stream) {}

        @Override
        public void onDataChannel(DataChannel channel) {
            if (expectedNegotiationId.equals(negotiationId)) {
                routeDataChannel(channel);
            } else {
                channel.close();
            }
        }

        @Override
        public void onRenegotiationNeeded() {}

        @Override
        public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override
        public void onCreateSuccess(SessionDescription description) {}

        @Override
        public void onSetSuccess() {}

        @Override
        public void onCreateFailure(String error) {}

        @Override
        public void onSetFailure(String error) {}
    }

    private static final class EmptyDataChannelObserver implements DataChannel.Observer {
        @Override
        public void onBufferedAmountChange(long previousAmount) {}

        @Override
        public void onStateChange() {}

        @Override
        public void onMessage(DataChannel.Buffer buffer) {}
    }
}
