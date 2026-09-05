package com.wonremote.controladdon;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.wonremote.agent.WonRemoteAccessibilityService;

public final class ControlCommandReceiver extends BroadcastReceiver {
    public static final String ACTION_EXECUTE = "com.wonremote.controladdon.EXECUTE";
    public static final String EXTRA_COMMAND = "command";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_EXECUTE.equals(intent.getAction())) {
            return;
        }
        String command = intent.getStringExtra(EXTRA_COMMAND);
        if (command != null && !command.isBlank() && command.length() <= 16 * 1024) {
            WonRemoteAccessibilityService.execute(command);
        }
    }
}
