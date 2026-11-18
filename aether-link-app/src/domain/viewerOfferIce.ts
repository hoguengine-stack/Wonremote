function ipv4HostCandidateKey(line: string, fragment: string): string | undefined {
  if (!/^\S+(?: \S+)+$/.test(line)) return undefined;
  const tokens = line.split(" ");
  if (tokens.length < 8 || tokens.length % 2 !== 0) return undefined;
  const [foundation, component, protocol, priority, address, port, type, host] = tokens;
  if (!/^candidate:[A-Za-z0-9+/]{1,32}$/.test(foundation) || component !== "1" || protocol.toLowerCase() !== "udp"
    || !/^\d{1,10}$/.test(priority) || Number(priority) > 0xffffffff
    || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address) || address.split(".").some(octet => Number(octet) > 255)
    || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 || type !== "typ" || host !== "host") return undefined;
  const key = tokens.slice(0, 8);
  let foundFragment = false;
  for (let index = 8; index < tokens.length; index += 2) {
    const [name, value] = [tokens[index], tokens[index + 1]];
    if (name !== "ufrag") key.push(name, value);
    else {
      if (foundFragment || value !== fragment) return undefined;
      foundFragment = true;
    }
  }
  return key.join(" ");
}

export function matchEmbeddedViewerIce(offer: RTCSessionDescriptionInit): ((candidate: RTCIceCandidateInit) => boolean) | undefined {
  if (offer.type !== "offer" || typeof offer.sdp !== "string" || !offer.sdp) return undefined;
  const lines = offer.sdp.split(/\r?\n/);
  const media = lines.filter(line => line.startsWith("m="));
  // An unfamiliar media layout can still use all existing trickle candidates.
  if (media.length !== 1 || !/^m=application [1-9]\d* UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0])) return undefined;
  const data = lines.slice(lines.indexOf(media[0]) + 1);
  const mids = data.filter(line => line.startsWith("a=mid:"));
  const fragments = data.filter(line => line.startsWith("a=ice-ufrag:"));
  if (mids.length !== 1 || fragments.length !== 1) return undefined;
  const mid = mids[0].slice(6);
  const fragment = fragments[0].slice(12);
  if (!/^\S+$/.test(mid) || !/^[A-Za-z0-9+/]{4,256}$/.test(fragment)) return undefined;
  const keys = new Set(data.filter(line => line.startsWith("a=candidate:"))
    .map(line => ipv4HostCandidateKey(line.slice(2), fragment)).filter(key => key !== undefined));
  if (!keys.size) return undefined;
  return candidate => {
    if (candidate.sdpMid !== mid || candidate.sdpMLineIndex !== 0 || candidate.usernameFragment !== fragment
      || typeof candidate.candidate !== "string") return false;
    const key = ipv4HostCandidateKey(candidate.candidate, fragment);
    return key !== undefined && keys.has(key);
  };
}
