package com.wonremote.agent;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;
import java.util.UUID;

final class AgentStore {
    private static final String FILE = "wonremote_agent";
    private static final String BUSINESS_NUMBER = "business_number";
    private static final String INSTALL_ID = "install_id";

    private final SharedPreferences preferences;

    AgentStore(Context context) {
        preferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    String businessNumber() {
        return preferences.getString(BUSINESS_NUMBER, "");
    }

    String installId() {
        String current = preferences.getString(INSTALL_ID, "");
        if (!current.isEmpty()) {
            return current;
        }
        String created = UUID.randomUUID().toString().replace("-", "")
            .substring(0, 8).toUpperCase(Locale.ROOT);
        preferences.edit().putString(INSTALL_ID, created).apply();
        return created;
    }

    boolean isRegistered() {
        return !businessNumber().isEmpty();
    }

    void saveRegistration(String businessNumber) {
        preferences.edit()
            .putString(BUSINESS_NUMBER, AgentIdentity.formatBusinessNumber(businessNumber))
            .apply();
    }

    String deviceId() {
        return AgentIdentity.deviceId(businessNumber(), installId());
    }
}
