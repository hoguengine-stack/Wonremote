package com.wonremote.agent;

import android.util.Log;

import com.google.firebase.firestore.DocumentReference;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.ListenerRegistration;
import com.google.firebase.firestore.Query;
import com.google.firebase.firestore.SetOptions;
import com.google.firebase.functions.FirebaseFunctions;

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
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

final class RemoteSessionController {
    private static final String TAG = "WonRemoteAgent";
    private static final String TILE_CHANNEL = "wonremote-tiles";
    private static final String CONTROL_CHANNEL = "wonremote-control";
    private static final String FILE_CHANNEL = "wonremote-files";
    private static final long RTC_CONFIG_RETRY_MS = 60_000;
    private static final long RTC_CONFIG_REFRESH_MARGIN_MS = 5 * 60_000;
    private static final long RTC_CONFIG_WAIT_MS = 1_200;

    private final FirebaseFirestore firestore = FirebaseFirestore.getInstance();
    private final FirebaseFunctions functions = FirebaseFunctions.getInstance();
    private final PeerConnectionFactory factory;
    private final ScreenFrameStreamer streamer;
    private final Consumer<String> controlHandler;
    private final Runnable releaseInput;
    private final Runnable sessionClosed;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable rtcConfigTimeout = this::beginPendingNegotiation;
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
    private String pendingOfferSdp;
    private List<PeerConnection.IceServer> iceServers = defaultIceServers();
    private PeerConnection.IceTransportsType iceTransportPolicy = PeerConnection.IceTransportsType.ALL;
    private boolean remoteDescriptionReady;
    private boolean rtcConfigLoading;
    private boolean closed;
    private long nextRtcConfigRefreshAt;

    RemoteSessionController(
        android.content.Context context,
        ScreenFrameStreamer streamer,
        Consumer<String> controlHandler,
        Runnable releaseInput,
        Runnable sessionClosed
    ) {
        this.streamer = streamer;
        this.controlHandler = controlHandler;
        this.releaseInput = releaseInput;
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
        refreshRtcConfiguration();
        sessionId = nextSessionId;
        DocumentReference session = firestore.collection("sessions").document(nextSessionId);
        sessionListener = session.addSnapshotListener((snapshot, error) -> {
            if (!isCurrentSession(nextSessionId, sessionId)) {
                return;
            }
            if (error != null) {
                Log.e(TAG, "WebRTC session listener failed: " + error.getCode());
            }
            if (error == null && snapshot != null && "closed".equals(snapshot.getString("state"))) {
                closeSession();
                sessionClosed.run();
            }
        });
        signalListener = session.collection("webrtc").document("signal")
            .addSnapshotListener((snapshot, error) -> {
                if (isCurrentSession(nextSessionId, sessionId) && error != null) {
                    Log.e(TAG, "WebRTC offer listener failed: " + error.getCode());
                }
                if (isCurrentSession(nextSessionId, sessionId)
                    && error == null && snapshot != null && snapshot.exists()) {
                    acceptOffer(snapshot);
                }
            });
    }

    static boolean isCurrentSession(String expectedSessionId, String activeSessionId) {
        return expectedSessionId != null && expectedSessionId.equals(activeSessionId);
    }

    void close() {
        closed = true;
        closeSession();
        factory.dispose();
    }

    void refreshRtcConfiguration() {
        long now = System.currentTimeMillis();
        if (closed || rtcConfigLoading || now < nextRtcConfigRefreshAt) {
            return;
        }
        rtcConfigLoading = true;
        functions.getHttpsCallable("getRtcConfiguration").call().addOnCompleteListener(task ->
            handler.post(() -> {
                rtcConfigLoading = false;
                if (closed) {
                    return;
                }
                if (task.isSuccessful() && applyRtcConfiguration(task.getResult().getData())) {
                    Log.i(TAG, "Dynamic TURN configuration loaded for Android Agent.");
                } else {
                    nextRtcConfigRefreshAt = System.currentTimeMillis() + RTC_CONFIG_RETRY_MS;
                    Log.w(TAG, "Dynamic TURN unavailable; using STUN until the next refresh.", task.getException());
                }
                beginPendingNegotiation();
            })
        );
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
        String offerSdp = readOfferSdp(offer);
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
        Log.i(TAG, "WebRTC offer received; starting negotiation.");
        negotiationId = nextNegotiationId;
        pendingOfferSdp = offerSdp;
        remoteDescriptionReady = false;
        appliedCandidateIds.clear();
        pendingCandidates.clear();

        if (rtcConfigLoading) {
            handler.postDelayed(rtcConfigTimeout, RTC_CONFIG_WAIT_MS);
        } else {
            beginPendingNegotiation();
        }
    }

    private void beginPendingNegotiation() {
        String expectedNegotiationId = negotiationId;
        String offerSdp = pendingOfferSdp;
        if (peer != null || expectedNegotiationId == null || offerSdp == null) {
            return;
        }
        handler.removeCallbacks(rtcConfigTimeout);
        pendingOfferSdp = null;

        PeerConnection.RTCConfiguration configuration = new PeerConnection.RTCConfiguration(
            new ArrayList<>(iceServers)
        );
        configuration.iceTransportsType = iceTransportPolicy;
        configuration.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        configuration.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
        peer = factory.createPeerConnection(configuration, new PeerObserver(expectedNegotiationId));
        if (peer == null) {
            Log.e(TAG, "WebRTC PeerConnection creation failed.");
            return;
        }
        listenForViewerCandidates(expectedNegotiationId);
        peer.setRemoteDescription(new SimpleSdpObserver("remote offer") {
            @Override
            public void onSetSuccess() {
                handler.post(() -> {
                    if (!expectedNegotiationId.equals(negotiationId) || peer == null) {
                        return;
                    }
                    remoteDescriptionReady = true;
                    Log.i(TAG, "WebRTC remote offer applied.");
                    flushPendingCandidates();
                    peer.createAnswer(new SimpleSdpObserver("create answer") {
                        @Override
                        public void onCreateSuccess(SessionDescription answer) {
                            setLocalAnswer(expectedNegotiationId, answer);
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
        current.setLocalDescription(new SimpleSdpObserver("local answer") {
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
                    signalReference().set(signal, SetOptions.merge())
                        .addOnSuccessListener(unused -> Log.i(TAG, "WebRTC answer published."))
                        .addOnFailureListener(error -> Log.e(TAG, "WebRTC answer publication failed.", error));
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
                if (expectedNegotiationId.equals(negotiationId) && error != null) {
                    Log.e(TAG, "WebRTC candidate listener failed: " + error.getCode());
                }
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
                Log.i(TAG, "WebRTC viewer candidate applied.");
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
        firestore.collection("sessions").document(activeSessionId).collection("agentCandidates").add(document)
            .addOnSuccessListener(unused -> Log.i(TAG, "WebRTC agent candidate published."))
            .addOnFailureListener(error -> Log.e(TAG, "WebRTC agent candidate publication failed.", error));
    }

    private void routeDataChannel(DataChannel channel) {
        Log.i(TAG, "WebRTC data channel received: " + channel.state());
        if (TILE_CHANNEL.equals(channel.label())) {
            tileChannel = channel;
            channel.registerObserver(new DataChannel.Observer() {
                @Override
                public void onBufferedAmountChange(long previousAmount) {}

                @Override
                public void onStateChange() {
                    Log.i(TAG, "WebRTC screen channel: " + channel.state());
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
                    Log.i(TAG, "WebRTC control channel: " + channel.state());
                    if (channel.state() == DataChannel.State.CLOSED) {
                        releaseInput.run();
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

    private boolean applyRtcConfiguration(Object value) {
        if (!(value instanceof Map)) {
            return false;
        }
        Map<?, ?> configuration = (Map<?, ?>) value;
        Object rawServers = configuration.get("iceServers");
        if (!(rawServers instanceof List)) {
            return false;
        }

        List<PeerConnection.IceServer> parsedServers = new ArrayList<>();
        boolean hasTurn = false;
        for (Object rawServer : (List<?>) rawServers) {
            if (!(rawServer instanceof Map)) {
                continue;
            }
            Map<?, ?> server = (Map<?, ?>) rawServer;
            List<String> urls = stringList(server.get("urls"));
            String username = string(server.get("username"));
            String credential = string(server.get("credential"));
            for (String url : urls) {
                PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(url);
                if (!username.isEmpty()) {
                    builder.setUsername(username);
                }
                if (!credential.isEmpty()) {
                    builder.setPassword(credential);
                }
                parsedServers.add(builder.createIceServer());
                hasTurn |= url.regionMatches(true, 0, "turn:", 0, 5)
                    || url.regionMatches(true, 0, "turns:", 0, 6);
            }
        }
        if (parsedServers.isEmpty() || !hasTurn) {
            return false;
        }

        iceServers = parsedServers;
        iceTransportPolicy = "relay".equals(configuration.get("iceTransportPolicy"))
            ? PeerConnection.IceTransportsType.RELAY
            : PeerConnection.IceTransportsType.ALL;
        long now = System.currentTimeMillis();
        long expiresAt = now + 30 * 60_000;
        try {
            expiresAt = Instant.parse(string(configuration.get("expiresAt"))).toEpochMilli();
        } catch (DateTimeParseException ignored) {
            // Refresh the otherwise valid configuration early when the server omits expiry metadata.
        }
        nextRtcConfigRefreshAt = Math.max(now + RTC_CONFIG_RETRY_MS, expiresAt - RTC_CONFIG_REFRESH_MARGIN_MS);
        return true;
    }

    private static List<String> stringList(Object value) {
        if (value instanceof String) {
            String item = string(value);
            return item.isEmpty() ? Collections.emptyList() : Collections.singletonList(item);
        }
        if (!(value instanceof List)) {
            return Collections.emptyList();
        }
        List<String> values = new ArrayList<>();
        for (Object item : (List<?>) value) {
            String text = string(item);
            if (!text.isEmpty()) {
                values.add(text);
            }
        }
        return values;
    }

    private static List<PeerConnection.IceServer> defaultIceServers() {
        return Collections.singletonList(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        );
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
        releaseInput.run();
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
        pendingOfferSdp = null;
        remoteDescriptionReady = false;
        handler.removeCallbacks(rtcConfigTimeout);
        handler.removeCallbacks(candidateRetry);
        pendingCandidates.clear();
        appliedCandidateIds.clear();
    }

    static String readOfferSdp(Map<?, ?> offer) {
        // SDP is a wire payload: trimming removes the final line delimiter required by libwebrtc.
        Object value = offer.get("sdp");
        return value instanceof String ? (String) value : "";
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
        public void onSignalingChange(PeerConnection.SignalingState state) {
            Log.i(TAG, "WebRTC signaling: " + state);
        }

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
            Log.i(TAG, "WebRTC ICE connection: " + state);
        }

        @Override
        public void onIceConnectionReceivingChange(boolean receiving) {}

        @Override
        public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
            Log.i(TAG, "WebRTC ICE gathering: " + state);
        }

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

    static class SimpleSdpObserver implements SdpObserver {
        private final String operation;
        private final Consumer<String> reportFailure;

        SimpleSdpObserver(String operation) {
            this(operation, message -> Log.e(TAG, message));
        }

        SimpleSdpObserver(String operation, Consumer<String> reportFailure) {
            this.operation = operation;
            this.reportFailure = reportFailure;
        }

        @Override
        public void onCreateSuccess(SessionDescription description) {}

        @Override
        public void onSetSuccess() {}

        @Override
        public void onCreateFailure(String error) {
            reportFailure.accept("WebRTC " + operation + " failed (create).");
        }

        @Override
        public void onSetFailure(String error) {
            reportFailure.accept("WebRTC " + operation + " failed (apply).");
        }
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
