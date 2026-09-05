# Firebase publishes the consumer rules required by its own libraries.
# WebRTC native code resolves Java classes and callbacks outside R8's call graph.
-keep class org.webrtc.** { *; }
-keep class org.jni_zero.** { *; }
