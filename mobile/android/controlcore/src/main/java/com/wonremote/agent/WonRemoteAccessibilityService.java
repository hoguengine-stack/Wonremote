package com.wonremote.agent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.PointF;
import android.os.Bundle;
import android.util.Base64;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class WonRemoteAccessibilityService extends AccessibilityService {
    private static volatile WonRemoteAccessibilityService active;

    private final List<PointF> dragPoints = new ArrayList<>();
    private String pressedButton;
    private boolean controlPressed;

    public static boolean isConnected() {
        return active != null;
    }

    public static boolean execute(String action) {
        WonRemoteAccessibilityService service = active;
        return service != null && service.executeAction(action == null ? "" : action.trim());
    }

    public static void releasePointer() {
        WonRemoteAccessibilityService service = active;
        if (service != null) {
            service.pressedButton = null;
            service.dragPoints.clear();
            service.controlPressed = false;
        }
    }

    @Override
    protected void onServiceConnected() {
        active = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {
        releasePointer();
    }

    @Override
    public void onDestroy() {
        if (active == this) {
            active = null;
        }
        super.onDestroy();
    }

    private boolean executeAction(String action) {
        String[] parts = action.split("\\s+");
        if (parts.length == 0) {
            return false;
        }
        try {
            switch (parts[0]) {
                case "mouse-down":
                    return beginPointer(parts);
                case "move":
                    return movePointer(parts);
                case "mouse-up":
                    return endPointer(parts);
                case "mouse-wheel":
                    return scroll(parts);
                case "text-base64":
                case "paste-text-base64":
                    return appendText(decode(parts[1]));
                case "text-replace-base64":
                    return replaceText(Integer.parseInt(parts[1]), "-".equals(parts[2]) ? "" : decode(parts[2]));
                case "key-down":
                    return keyDown(parts.length > 1 ? parts[1] : "");
                case "key-up":
                    return keyUp(parts.length > 1 ? parts[1] : "");
                case "key-release-all":
                case "key_release_all":
                    releasePointer();
                    return true;
                default:
                    return false;
            }
        } catch (RuntimeException error) {
            releasePointer();
            return false;
        }
    }

    private boolean beginPointer(String[] parts) {
        if (parts.length != 4) {
            return false;
        }
        pressedButton = parts[3];
        dragPoints.clear();
        dragPoints.add(point(parts[1], parts[2]));
        return true;
    }

    private boolean movePointer(String[] parts) {
        if (parts.length != 3 || pressedButton == null) {
            return false;
        }
        dragPoints.add(point(parts[1], parts[2]));
        return true;
    }

    private boolean endPointer(String[] parts) {
        if (parts.length != 4) {
            return false;
        }
        PointF end = point(parts[1], parts[2]);
        if (pressedButton == null) {
            return tap(end, "right".equals(parts[3]) ? 500 : 60);
        }
        dragPoints.add(end);
        PointF first = dragPoints.get(0);
        if (Math.hypot(end.x - first.x, end.y - first.y) < 8) {
            String button = pressedButton;
            pressedButton = null;
            dragPoints.clear();
            return tap(end, "right".equals(button) ? 500 : 60);
        }
        Path path = new Path();
        path.moveTo(first.x, first.y);
        for (int index = 1; index < dragPoints.size(); index++) {
            PointF point = dragPoints.get(index);
            path.lineTo(point.x, point.y);
        }
        long duration = "right".equals(pressedButton) ? 500 : Math.min(1_500, Math.max(60, dragPoints.size() * 16L));
        pressedButton = null;
        dragPoints.clear();
        return dispatch(path, duration);
    }

    private boolean tap(PointF point, long duration) {
        Path path = new Path();
        path.moveTo(point.x, point.y);
        return dispatch(path, duration);
    }

    private boolean dispatch(Path path, long duration) {
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, duration))
            .build();
        return dispatchGesture(gesture, null, null);
    }

    private boolean scroll(String[] parts) {
        if (parts.length != 4) {
            return false;
        }
        AccessibilityNodeInfo node = focusedNode();
        if (node == null) {
            node = getRootInActiveWindow();
        }
        if (node == null) {
            return false;
        }
        int delta = Integer.parseInt(parts[3]);
        return node.performAction(delta > 0
            ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
    }

    private boolean keyDown(String key) {
        AccessibilityNodeInfo node = focusedNode();
        if ("Ctrl".equalsIgnoreCase(key) || "Control".equalsIgnoreCase(key)) {
            controlPressed = true;
            return true;
        }
        if (node == null) {
            return false;
        }
        if (controlPressed) {
            if ("A".equalsIgnoreCase(key)) return selectAll(node);
            if ("C".equalsIgnoreCase(key)) return node.performAction(AccessibilityNodeInfo.ACTION_COPY);
            if ("V".equalsIgnoreCase(key)) return node.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        }
        if ("Backspace".equalsIgnoreCase(key)) {
            CharSequence current = node.getText();
            String text = current == null ? "" : current.toString();
            int end = text.offsetByCodePoints(text.length(), text.isEmpty() ? 0 : -1);
            return setText(node, text.substring(0, end));
        }
        if ("Enter".equalsIgnoreCase(key) && android.os.Build.VERSION.SDK_INT >= 30) {
            return node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        }
        return false;
    }

    private boolean keyUp(String key) {
        if ("Ctrl".equalsIgnoreCase(key) || "Control".equalsIgnoreCase(key)) {
            controlPressed = false;
            return true;
        }
        return true;
    }

    private boolean appendText(String value) {
        AccessibilityNodeInfo node = focusedNode();
        if (node == null) {
            return false;
        }
        CharSequence current = node.getText();
        return setText(node, (current == null ? "" : current.toString()) + value);
    }

    private boolean replaceText(int deleteCount, String value) {
        AccessibilityNodeInfo node = focusedNode();
        if (node == null || deleteCount < 0 || deleteCount > 4096) {
            return false;
        }
        String current = node.getText() == null ? "" : node.getText().toString();
        int codePoints = current.codePointCount(0, current.length());
        int keep = Math.max(0, codePoints - deleteCount);
        int end = current.offsetByCodePoints(0, keep);
        return setText(node, current.substring(0, end) + value);
    }

    private AccessibilityNodeInfo focusedNode() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    }

    private boolean setText(AccessibilityNodeInfo node, String value) {
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
    }

    private boolean selectAll(AccessibilityNodeInfo node) {
        int length = node.getText() == null ? 0 : node.getText().length();
        Bundle arguments = new Bundle();
        arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0);
        arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, length);
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, arguments);
    }

    private PointF point(String dx, String dy) {
        float x = Math.max(0, Math.min(65_535, Integer.parseInt(dx))) / 65_535f
            * getResources().getDisplayMetrics().widthPixels;
        float y = Math.max(0, Math.min(65_535, Integer.parseInt(dy))) / 65_535f
            * getResources().getDisplayMetrics().heightPixels;
        return new PointF(x, y);
    }

    private String decode(String value) {
        return new String(Base64.decode(value, Base64.DEFAULT), StandardCharsets.UTF_8);
    }
}
