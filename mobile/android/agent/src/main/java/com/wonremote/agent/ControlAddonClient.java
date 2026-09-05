package com.wonremote.agent;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.Settings;

final class ControlAddonClient {
    static final String PACKAGE = "com.wonremote.controladdon";
    static final String DOWNLOAD_URL = "https://wonremote-a7fd3.web.app/download/control-addon.apk";

    private static final String PERMISSION = "com.wonremote.permission.CONTROL_ADDON";
    private static final String ACTION_EXECUTE = PACKAGE + ".EXECUTE";
    private static final String RECEIVER = PACKAGE + ".ControlCommandReceiver";
    private static final String SERVICE = "com.wonremote.agent.WonRemoteAccessibilityService";
    private static final String EXTRA_COMMAND = "command";

    private ControlAddonClient() {}

    static boolean isInstalled(Context context) {
        return context.getPackageManager().checkSignatures(context.getPackageName(), PACKAGE)
            == PackageManager.SIGNATURE_MATCH;
    }

    static boolean isReady(Context context) {
        if (!isInstalled(context)) {
            return false;
        }
        return containsEnabledService(Settings.Secure.getString(
            context.getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ));
    }

    static boolean execute(Context context, String command) {
        if (command == null || command.isBlank() || command.length() > 16 * 1024 || !isReady(context)) {
            return false;
        }
        try {
            Intent intent = new Intent(ACTION_EXECUTE)
                .setComponent(new ComponentName(PACKAGE, RECEIVER))
                .putExtra(EXTRA_COMMAND, command);
            context.sendBroadcast(intent, PERMISSION);
            return true;
        } catch (SecurityException error) {
            return false;
        }
    }

    static void releasePointer(Context context) {
        execute(context, "key-release-all");
        WonRemoteAccessibilityService.releasePointer();
    }

    static boolean requestScreenShareConsent(Context context) {
        return execute(context, WonRemoteAccessibilityService.COMMAND_REQUEST_SCREEN_SHARE_CONSENT);
    }

    static boolean containsEnabledService(String enabledServices) {
        if (enabledServices == null || enabledServices.isBlank()) {
            return false;
        }
        String expected = PACKAGE + "/" + SERVICE;
        for (String component : enabledServices.split(":")) {
            if (expected.equalsIgnoreCase(component.trim())) {
                return true;
            }
        }
        return false;
    }
}
