package com.wonremote.controladdon;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.wonremote.agent.WonRemoteAccessibilityService;

public final class MainActivity extends com.wonremote.update.UpdateActivity {
    private static final int ACCENT = Color.rgb(22, 125, 113);
    private static final int DARK = Color.rgb(18, 33, 43);
    private static final int MUTED = Color.rgb(96, 115, 127);

    private TextView status;
    private Button settings;
    private boolean openAccessibilityAfterAppInfo;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(DARK);
        getWindow().setNavigationBarColor(DARK);
        setContentView(content());
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
        if (openAccessibilityAfterAppInfo) {
            openAccessibilityAfterAppInfo = false;
            settings.post(this::openAccessibilitySettings);
        } else {
            settings.postDelayed(this::refresh, 350);
        }
    }

    private LinearLayout content() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(24), dp(24), dp(24), dp(24));
        root.setBackgroundColor(Color.rgb(242, 246, 247));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(22), dp(22), dp(22), dp(22));
        card.setBackground(rounded(Color.WHITE, 12));

        TextView title = text("WonRemote Control Add-On", 20, true, DARK);
        card.addView(title, matchWrap());
        card.addView(text("v" + BuildConfig.VERSION_NAME, 13, false, MUTED), matchWrap());
        card.addView(updateButton(), new LinearLayout.LayoutParams(dp(44), dp(44)));

        status = text("입력 제어 확인 중", 16, true, DARK);
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.topMargin = dp(24);
        card.addView(status, statusParams);

        TextView guide = text(
            "WonRemote Agent가 터치, 스와이프와 텍스트 입력을 전달할 수 있도록 접근성 권한을 사용합니다.",
            14,
            false,
            MUTED
        );
        guide.setLineSpacing(0, 1.25f);
        LinearLayout.LayoutParams guideParams = matchWrap();
        guideParams.topMargin = dp(10);
        card.addView(guide, guideParams);

        settings = new Button(this);
        settings.setText("입력 제어 권한 켜기");
        settings.setTextColor(Color.WHITE);
        settings.setTextSize(15);
        settings.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        settings.setAllCaps(false);
        settings.setBackground(rounded(ACCENT, 8));
        settings.setOnClickListener(view -> requestAccessibility());
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(50)
        );
        buttonParams.topMargin = dp(22);
        card.addView(settings, buttonParams);

        root.addView(card, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        return root;
    }

    private void requestAccessibility() {
        if (WonRemoteAccessibilityService.isConnected()) {
            return;
        }
        if (Build.VERSION.SDK_INT < 33) {
            openAccessibilitySettings();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("입력 제어 권한")
            .setMessage("앱 정보 우측 상단 메뉴에서 '제한된 설정 허용'을 선택하세요. 돌아오면 접근성 설정이 자동으로 열립니다.")
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

    private void refresh() {
        boolean connected = WonRemoteAccessibilityService.isConnected();
        status.setText(connected ? "입력 제어 준비됨" : "입력 제어 권한 필요");
        settings.setText(connected ? "입력 제어 사용 중" : "입력 제어 권한 켜기");
        settings.setEnabled(!connected);
        settings.setAlpha(connected ? 0.65f : 1f);
    }

    private TextView text(String value, int size, boolean bold, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        }
        return view;
    }

    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        return drawable;
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
