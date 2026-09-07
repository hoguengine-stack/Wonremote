package com.wonremote.agent;

final class RemoteUpdateRequest {
    private long latest;
    private boolean pending, busy;
    boolean accept(String action, long now) {
        if (busy || !action.matches("request-update [0-9]{13}")) return false;
        long at = Long.parseLong(action.substring(15));
        if (at <= latest || now - at > 60_000 || at > now + 5_000) return false;
        latest = at;
        pending = true;
        return true;
    }
    boolean start(boolean sessionActive) {
        if (!pending || busy || sessionActive) return false;
        pending = false;
        busy = true;
        return true;
    }
    void finish() { busy = false; }
}
