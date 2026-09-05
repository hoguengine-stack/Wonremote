import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// JNI resolves Java names at runtime; Java-only reachability cannot prove safety.
export function verifyNativeMapping(mapping) {
  const required = new Set([
    "org.webrtc.ContextUtils", "org.webrtc.PeerConnectionFactory",
    "org.webrtc.PeerConnection", "org.webrtc.DataChannel", "org.webrtc.NetworkMonitor",
  ]);
  let nativeClass = false;
  for (const line of mapping.split(/\r?\n/)) {
    const header = /^(\S+) -> (\S+):$/.exec(line);
    if (header) {
      nativeClass = required.has(header[1]);
      if (nativeClass && header[1] !== header[2]) {
        throw new Error(`WebRTC JNI class changed: ${header[1]}`);
      }
      required.delete(header[1]);
    } else if (nativeClass && line.includes(" -> ")) {
      const member = /\s([\w$<>]+)(?:\([^)]*\)(?::\d+)*)? -> (\S+)$/.exec(line);
      if (member && !member[1].startsWith("$r8$") && !member[1].startsWith("-$$") && member[1] !== member[2]) {
        throw new Error(`WebRTC JNI member changed: ${member[1]}`);
      }
    }
  }
  if (required.size) throw new Error(`WebRTC JNI classes missing: ${[...required].join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyNativeMapping(readFileSync(process.argv[2], "utf8"));
  console.log("WebRTC release JNI mapping verified.");
}
