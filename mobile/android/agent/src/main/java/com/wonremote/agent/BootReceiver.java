package com.wonremote.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    private static final String ACTION_QUICKBOOT_POWERON = "android.intent.action.QUICKBOOT_POWERON";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (shouldStart(action, new AgentStore(context).isRegistered())) {
            AgentService.start(context);
        }
    }

    static boolean shouldStart(String action, boolean registered) {
        return registered && (Intent.ACTION_BOOT_COMPLETED.equals(action)
            || ACTION_QUICKBOOT_POWERON.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action));
    }
}
