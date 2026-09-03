package com.wonremote.agent;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private EditText businessNumber;
    private EditText password;
    private TextView status;
    private Button register;
    private Button screenShare;
    private Button inputControl;
    private AgentStore store;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(16, 32, 42));
        getWindow().setNavigationBarColor(Color.rgb(16, 32, 42));
        store = new AgentStore(this);
        setContentView(buildContent());
        requestNotificationPermission();

        if (store.isRegistered()) {
            businessNumber.setText(store.businessNumber());
            showRegistered();
            AgentService.start(this);
        }
    }

    private LinearLayout buildContent() {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(32), dp(24), dp(24));
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        content.setBackgroundColor(Color.rgb(244, 248, 249));

        TextView title = text("WonRemote Agent · v" + BuildConfig.VERSION_NAME, 21, true);
        content.addView(title, matchWrap());

        status = text("Agent 최초 등록", 16, true);
        status.setPadding(0, dp(18), 0, dp(12));
        content.addView(status, matchWrap());

        businessNumber = input("사업자번호", InputType.TYPE_CLASS_NUMBER);
        content.addView(businessNumber, matchWrap());

        password = input("비밀번호", InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        password.setText(R.string.default_agent_password);
        content.addView(password, matchWrap());

        register = new Button(this);
        register.setText("등록");
        register.setTextSize(16);
        register.setAllCaps(false);
        LinearLayout.LayoutParams buttonParams = matchWrap();
        buttonParams.topMargin = dp(16);
        content.addView(register, buttonParams);
        register.setOnClickListener(view -> register());

        screenShare = actionButton("화면 공유 준비");
        screenShare.setEnabled(false);
        content.addView(screenShare, matchWrap());
        screenShare.setOnClickListener(view -> requestScreenShare());

        inputControl = actionButton("입력 제어 권한");
        inputControl.setEnabled(false);
        content.addView(inputControl, matchWrap());
        inputControl.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        return content;
    }

    private void register() {
        register.setEnabled(false);
        status.setText("등록 중...");
        try {
            new AgentRepository(this).register(
                businessNumber.getText().toString(),
                password.getText().toString()
            ).addOnCompleteListener(task -> {
                register.setEnabled(true);
                if (task.isSuccessful()) {
                    showRegistered();
                    AgentService.start(this);
                } else {
                    Throwable error = task.getException();
                    status.setText(error == null ? "등록 실패" : "등록 실패: " + error.getMessage());
                }
            });
        } catch (RuntimeException error) {
            register.setEnabled(true);
            status.setText(error.getMessage());
        }
    }

    private void showRegistered() {
        status.setText(getString(R.string.registered_agent_status, store.deviceId()));
        register.setText("등록 정보 갱신");
        screenShare.setEnabled(true);
        inputControl.setEnabled(true);
        updatePermissionLabels();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (inputControl != null) {
            updatePermissionLabels();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 1002 && resultCode == RESULT_OK && data != null) {
            AgentService.setProjection(this, resultCode, data);
            screenShare.setText("화면 공유 준비됨");
        }
    }

    private void requestScreenShare() {
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        startActivityForResult(manager.createScreenCaptureIntent(), 1002);
    }

    private void updatePermissionLabels() {
        inputControl.setText(WonRemoteAccessibilityService.isConnected()
            ? "입력 제어 준비됨" : "입력 제어 권한");
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
    }

    private EditText input(String hint, int inputType) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setInputType(inputType);
        field.setTextSize(16);
        field.setSingleLine(true);
        field.setPadding(dp(12), dp(12), dp(12), dp(12));
        return field;
    }

    private Button actionButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(15);
        button.setAllCaps(false);
        return button;
    }

    private TextView text(String value, int size, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(Color.rgb(16, 32, 42));
        view.setTextSize(size);
        if (bold) {
            view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        }
        return view;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
