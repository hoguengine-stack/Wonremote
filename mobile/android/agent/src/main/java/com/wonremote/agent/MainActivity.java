package com.wonremote.agent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final int ACCENT = Color.rgb(22, 125, 113);
    private static final int DARK = Color.rgb(18, 33, 43);
    private static final int MUTED = Color.rgb(96, 115, 127);
    private static final int BORDER = Color.rgb(216, 226, 230);
    private static final int DANGER = Color.rgb(185, 58, 68);

    private EditText businessNumber;
    private EditText password;
    private TextView status;
    private TextView screenShareStatus;
    private TextView inputControlStatus;
    private Button register;
    private Button screenShare;
    private Button stopScreenShare;
    private Button inputControl;
    private AgentStore store;
    private boolean openAccessibilityAfterAppInfo;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(DARK);
        getWindow().setNavigationBarColor(DARK);
        store = new AgentStore(this);
        setContentView(buildContent());
        requestNotificationPermission();

        if (store.isRegistered()) {
            businessNumber.setText(store.businessNumber());
            showRegistered();
            AgentService.start(this);
        }
    }

    private View buildContent() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(242, 246, 247));

        LinearLayout content = vertical();
        content.setPadding(dp(20), dp(22), dp(20), dp(28));
        content.addView(buildHeader(), matchWrap());
        addSpace(content, 20);

        LinearLayout statusCard = card();
        statusCard.addView(sectionLabel("이 기기"), matchWrap());
        status = text("Agent 최초 등록", 20, true, DARK);
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.topMargin = dp(8);
        statusCard.addView(status, statusParams);
        content.addView(statusCard, matchWrap());
        addSpace(content, 14);

        LinearLayout registrationCard = card();
        registrationCard.addView(sectionLabel("장비 등록"), matchWrap());
        addSpace(registrationCard, 12);
        registrationCard.addView(fieldLabel("사업자번호"), matchWrap());
        businessNumber = input("000-00-00000", InputType.TYPE_CLASS_NUMBER);
        registrationCard.addView(businessNumber);
        addSpace(registrationCard, 10);
        registrationCard.addView(fieldLabel("비밀번호"), matchWrap());
        password = input("비밀번호", InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        password.setText(R.string.default_agent_password);
        registrationCard.addView(password);
        addSpace(registrationCard, 14);
        register = button("등록", ACCENT);
        registrationCard.addView(register);
        register.setOnClickListener(view -> register());
        content.addView(registrationCard, matchWrap());
        addSpace(content, 14);

        LinearLayout controlCard = card();
        controlCard.addView(sectionLabel("원격 제어 준비"), matchWrap());
        addSpace(controlCard, 14);
        screenShareStatus = stateLabel("화면 공유", "등록 후 사용 가능");
        controlCard.addView(screenShareStatus, matchWrap());
        addSpace(controlCard, 8);
        screenShare = button("전체 화면 공유 시작", ACCENT);
        screenShare.setEnabled(false);
        controlCard.addView(screenShare);
        screenShare.setOnClickListener(view -> requestScreenShare());

        stopScreenShare = button("화면 공유 중지", DANGER);
        stopScreenShare.setVisibility(View.GONE);
        controlCard.addView(stopScreenShare);
        stopScreenShare.setOnClickListener(view -> {
            AgentService.stopProjection(this);
            updatePermissionLabels();
        });

        addSpace(controlCard, 18);
        inputControlStatus = stateLabel("입력 제어", "등록 후 사용 가능");
        controlCard.addView(inputControlStatus, matchWrap());
        addSpace(controlCard, 8);
        inputControl = button("입력 제어 설정", Color.rgb(42, 72, 88));
        inputControl.setEnabled(false);
        controlCard.addView(inputControl);
        inputControl.setOnClickListener(view -> requestInputControl());
        content.addView(controlCard, matchWrap());

        scroll.addView(content, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        return scroll;
    }

    private LinearLayout buildHeader() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView mark = text("A", 21, true, DARK);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(rounded(Color.rgb(32, 184, 154), 10, 0, 0));
        header.addView(mark, new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout titleGroup = vertical();
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        titleParams.leftMargin = dp(12);
        titleGroup.addView(text("WonRemote Agent", 19, true, DARK), matchWrap());
        titleGroup.addView(text("v" + BuildConfig.VERSION_NAME, 13, false, MUTED), matchWrap());
        header.addView(titleGroup, titleParams);

        TextView secure = text("보안 연결", 12, true, ACCENT);
        secure.setGravity(Gravity.CENTER);
        secure.setPadding(dp(10), dp(6), dp(10), dp(6));
        secure.setBackground(rounded(Color.rgb(227, 244, 240), 20, 0, 0));
        header.addView(secure, wrapWrap());
        return header;
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
                    status.setText(error == null ? "등록 실패" : "등록 실패 · " + error.getMessage());
                }
            });
        } catch (RuntimeException error) {
            register.setEnabled(true);
            status.setText(error.getMessage());
        }
    }

    private void showRegistered() {
        status.setText("온라인 대기\n" + store.deviceId());
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
        if (openAccessibilityAfterAppInfo) {
            openAccessibilityAfterAppInfo = false;
            inputControl.post(this::openAccessibilitySettings);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != 1002) {
            return;
        }
        if (resultCode == RESULT_OK && data != null) {
            screenShareStatus.setText("화면 공유 · 준비 중");
            screenShare.setEnabled(false);
            AgentService.setProjection(this, resultCode, data);
            screenShare.postDelayed(this::updatePermissionLabels, 600);
        } else {
            screenShareStatus.setText("화면 공유 · 권한이 필요합니다");
        }
    }

    private void requestScreenShare() {
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        Intent intent = Build.VERSION.SDK_INT >= 34
            ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
            : manager.createScreenCaptureIntent();
        startActivityForResult(intent, 1002);
    }

    private void requestInputControl() {
        if (WonRemoteAccessibilityService.isConnected()) {
            return;
        }
        if (Build.VERSION.SDK_INT < 33) {
            openAccessibilitySettings();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("입력 제어 권한")
            .setMessage("Android 보호 정책에 따라 먼저 앱 정보 우측 상단 메뉴에서 '제한된 설정 허용'을 선택해야 합니다. 돌아오면 접근성 설정이 자동으로 열립니다.")
            .setNegativeButton("취소", null)
            .setPositiveButton("앱 정보 열기", (dialog, which) -> {
                openAccessibilityAfterAppInfo = true;
                startActivity(new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName())
                ));
            })
            .show();
    }

    private void openAccessibilitySettings() {
        startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
    }

    private void updatePermissionLabels() {
        boolean registered = store != null && store.isRegistered();
        boolean projectionReady = AgentService.isProjectionReady();
        boolean inputReady = WonRemoteAccessibilityService.isConnected();

        if (!registered) {
            screenShareStatus.setText("화면 공유 · 등록 후 사용 가능");
            screenShare.setVisibility(View.VISIBLE);
            screenShare.setEnabled(false);
            stopScreenShare.setVisibility(View.GONE);
            inputControlStatus.setText("입력 제어 · 등록 후 사용 가능");
            inputControl.setEnabled(false);
            return;
        }

        screenShareStatus.setText(projectionReady ? "화면 공유 · 준비됨" : "화면 공유 · 권한 필요");
        screenShare.setVisibility(projectionReady ? View.GONE : View.VISIBLE);
        screenShare.setEnabled(registered);
        stopScreenShare.setVisibility(projectionReady ? View.VISIBLE : View.GONE);

        inputControlStatus.setText(inputReady ? "입력 제어 · 준비됨" : "입력 제어 · 권한 필요");
        inputControl.setText(inputReady ? "입력 제어 준비됨" : "입력 제어 설정");
        inputControl.setEnabled(registered && !inputReady);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
    }

    private LinearLayout card() {
        LinearLayout layout = vertical();
        layout.setPadding(dp(18), dp(18), dp(18), dp(18));
        layout.setBackground(rounded(Color.WHITE, 12, 1, BORDER));
        layout.setElevation(dp(2));
        return layout;
    }

    private EditText input(String hint, int inputType) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setHintTextColor(Color.rgb(139, 153, 162));
        field.setTextColor(DARK);
        field.setInputType(inputType);
        field.setTextSize(16);
        field.setSingleLine(true);
        field.setPadding(dp(13), 0, dp(13), 0);
        field.setBackground(rounded(Color.rgb(249, 251, 252), 8, 1, BORDER));
        field.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)));
        return field;
    }

    private Button button(String label, int color) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(15);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setPadding(dp(12), 0, dp(12), 0);
        button.setBackground(rounded(color, 8, 0, 0));
        button.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)));
        return button;
    }

    private TextView sectionLabel(String value) {
        TextView view = text(value, 12, true, ACCENT);
        view.setAllCaps(true);
        return view;
    }

    private TextView fieldLabel(String value) {
        TextView view = text(value, 13, true, MUTED);
        view.setPadding(0, 0, 0, dp(6));
        return view;
    }

    private TextView stateLabel(String title, String state) {
        return text(title + " · " + state, 15, true, DARK);
    }

    private TextView text(String value, int size, boolean bold, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        }
        return view;
    }

    private GradientDrawable rounded(int color, int radiusDp, int strokeDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) {
            drawable.setStroke(dp(strokeDp), strokeColor);
        }
        return drawable;
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private void addSpace(LinearLayout layout, int heightDp) {
        layout.addView(new View(this), new LinearLayout.LayoutParams(1, dp(heightDp)));
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams wrapWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
